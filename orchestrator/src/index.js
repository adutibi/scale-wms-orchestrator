const express = require("express");
const amqp = require("amqplib");
const crypto = require("crypto");
const { authMiddleware } = require("./auth");
const { matchScaleRoute } = require("../config/scaleRoutes");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const EXCHANGE = "scale.topic";
const REPLY_QUEUE = "orchestrator.replies";
const ROUTING_HEADER = "x-routing-key";
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS) || 30000;
const RECONNECT_DELAY_MS = Number(process.env.RABBITMQ_RECONNECT_DELAY_MS) || 5000;

let channel = null;
let reconnectTimer = null;
const pendingReplies = new Map();

function failPendingReplies(err) {
  for (const [correlationId, pending] of pendingReplies) {
    clearTimeout(pending.timeoutHandle);
    pendingReplies.delete(correlationId);
    pending.reject(err);
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.error(`RabbitMQ ${reason} - reconnecting in ${RECONNECT_DELAY_MS}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithRetry();
  }, RECONNECT_DELAY_MS);
}

async function connectRabbitMQ() {
  const conn = await amqp.connect(RABBITMQ_URL);

  conn.on("error", (err) => {
    console.error("RabbitMQ connection error:", err.message);
  });
  conn.on("close", () => {
    channel = null;
    failPendingReplies(new Error("RabbitMQ connection lost"));
    scheduleReconnect("connection closed");
  });

  channel = await conn.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(REPLY_QUEUE, { durable: true });
  channel.prefetch(Number(process.env.ORCHESTRATOR_REPLY_PREFETCH) || 50);

  channel.consume(REPLY_QUEUE, (msg) => {
    if (!msg) return;
    const correlationId = msg.properties.correlationId;
    const pending = correlationId ? pendingReplies.get(correlationId) : null;
    if (pending) {
      clearTimeout(pending.timeoutHandle);
      pendingReplies.delete(correlationId);
      try {
        const raw = msg.content.toString();
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { body: raw };
        }
        const statusCode = payload.statusCode ?? 200;
        const body = payload.body !== undefined ? payload.body : payload;
        pending.resolve({ statusCode, body });
      } catch (err) {
        pending.reject(err);
      }
    }
    channel.ack(msg);
  });

  return channel;
}

function getRoutingKey(req) {
  const key = req.get(ROUTING_HEADER) || req.get("X-Routing-Key") || req.get("x-scale-routing-key");
  if (key) return key.trim();
  const scaleRoute = matchScaleRoute(req.method, req.path);
  if (scaleRoute) return scaleRoute.routingKey;
  return null;
}

// Only these client headers are forwarded into queue payloads; everything
// else (Authorization, cookies, proxy headers, ...) is dropped.
const DEFAULT_FORWARD_HEADERS =
  "content-type,accept,user-agent,warehouse,x-routing-key,x-scale-routing-key,x-request-id";
const FORWARD_HEADERS = new Set(
  (process.env.FORWARD_HEADERS || DEFAULT_FORWARD_HEADERS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function pickForwardedHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (FORWARD_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// Fire-and-forget audit event per request, consumed by logging-service.
const AUDIT_LOG_ENABLED = (process.env.AUDIT_LOG_ENABLED || "true").toLowerCase() !== "false";

function publishAuditEvent(event) {
  if (!AUDIT_LOG_ENABLED || !channel) return;
  try {
    const content = Buffer.from(JSON.stringify({ type: "audit", ...event }));
    channel.publish(EXCHANGE, "logging", content, { contentType: "application/json" });
  } catch {
    // Auditing must never break the request path.
  }
}

function waitForReply(correlationId) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (pendingReplies.delete(correlationId)) {
        reject(new Error("Reply timeout"));
      }
    }, REPLY_TIMEOUT_MS);
    pendingReplies.set(correlationId, { resolve, reject, timeoutHandle });
  });
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ type: "*/*", limit: "10mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "orchestrator" });
});

app.use(authMiddleware());

app.all("*", async (req, res) => {
  const routingKey = getRoutingKey(req);
  if (!routingKey) {
    return res.status(400).json({
      error: "Missing routing key",
      hint: `Set header "${ROUTING_HEADER}" or "X-Routing-Key" (e.g. logging, worker)`,
    });
  }

  if (!channel) {
    return res.status(503).json({ error: "Orchestrator not connected to RabbitMQ" });
  }

  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();

  const payload = {
    method: req.method,
    path: req.path,
    query: req.query,
    headers: pickForwardedHeaders(req.headers),
    body: req.body,
    correlationId,
    timestamp: new Date().toISOString(),
  };

  try {
    const content = Buffer.from(JSON.stringify(payload));
    channel.publish(EXCHANGE, routingKey, content, {
      persistent: true,
      contentType: "application/json",
      replyTo: REPLY_QUEUE,
      correlationId,
    });

    const reply = await waitForReply(correlationId);
    const status = reply.statusCode ?? 200;
    publishAuditEvent({
      correlationId,
      method: req.method,
      path: req.path,
      routingKey,
      statusCode: status,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
    res.status(status);
    if (
      reply.body !== undefined &&
      reply.body !== null &&
      (Array.isArray(reply.body) ||
        (typeof reply.body === "object" && !Buffer.isBuffer(reply.body)))
    ) {
      res.json(reply.body);
    } else {
      res.send(reply.body);
    }
  } catch (err) {
    const failureStatus =
      err.message === "Reply timeout" ? 504 : err.message === "RabbitMQ connection lost" ? 503 : 500;
    publishAuditEvent({
      correlationId,
      method: req.method,
      path: req.path,
      routingKey,
      statusCode: failureStatus,
      durationMs: Date.now() - startedAt,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
    if (failureStatus === 504) {
      return res.status(504).json({ error: "Gateway timeout", message: "Microservice did not respond in time" });
    }
    if (failureStatus === 503) {
      return res.status(503).json({ error: "Service unavailable", message: "Broker connection lost, retry shortly" });
    }
    console.error("Orchestrator error:", { correlationId, error: err.message });
    res.status(500).json({ error: "Failed to forward request" });
  }
});

const PORT = Number(process.env.ORCHESTRATOR_PORT) || 3000;

function connectWithRetry() {
  connectRabbitMQ()
    .then(() => {
      console.log("Connected to RabbitMQ");
    })
    .catch((err) => {
      scheduleReconnect(`connection failed (${err.message})`);
    });
}

// Start HTTP immediately; requests get 503 until the broker connection is up.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Orchestrator listening on port ${PORT} (request-reply)`);
});
connectWithRetry();
