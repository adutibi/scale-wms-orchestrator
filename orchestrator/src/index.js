const express = require("express");
const crypto = require("crypto");
const { authMiddleware } = require("./auth");
const { matchScaleRoute } = require("../config/scaleRoutes");

const TRANSPORT = (process.env.TRANSPORT || "http").toLowerCase();
const ROUTING_HEADER = "x-routing-key";
const AUDIT_LOG_ENABLED = (process.env.AUDIT_LOG_ENABLED || "true").toLowerCase() !== "false";

const transport =
  TRANSPORT === "rabbitmq"
    ? require("./transport-rabbitmq")
    : TRANSPORT === "nats"
      ? require("./transport-nats")
      : require("./transport-http");

function getRoutingKey(req) {
  const key = req.get(ROUTING_HEADER) || req.get("X-Routing-Key") || req.get("x-scale-routing-key");
  if (key) return key.trim();
  const scaleRoute = matchScaleRoute(req.method, req.path);
  if (scaleRoute) return scaleRoute.routingKey;
  return null;
}

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

function publishAuditEvent(event) {
  if (!AUDIT_LOG_ENABLED) return;
  transport.publishAuditEvent(event);
}

async function forwardRequest(routingKey, payload) {
  if (routingKey === "worker") {
    return transport.forwardToWorker(payload);
  }
  if (routingKey === "logging") {
    return transport.forwardToLogging(payload);
  }
  throw new Error(`Unknown routing key: ${routingKey}`);
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ type: "*/*", limit: "10mb" }));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "orchestrator",
    transport: TRANSPORT,
    backendReady: transport.isReady(),
  });
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

  if (!transport.isReady()) {
    const hint =
      TRANSPORT === "rabbitmq"
        ? "Orchestrator not connected to RabbitMQ"
        : TRANSPORT === "nats"
          ? "Orchestrator not connected to NATS"
          : "Configure WORKER_URLS / LOGGING_HTTP_URL";
    return res.status(503).json({ error: "Service unavailable", message: hint });
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
    const reply = await forwardRequest(routingKey, payload);
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
      err.message === "Reply timeout"
        ? 504
        : err.message === "RabbitMQ connection lost" || err.message === "NATS connection lost"
          ? 503
          : 500;
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
      return res.status(503).json({ error: "Service unavailable", message: err.message });
    }
    console.error("Orchestrator error:", { correlationId, error: err.message });
    res.status(500).json({ error: "Failed to forward request", message: err.message });
  }
});

const PORT = Number(process.env.ORCHESTRATOR_PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Orchestrator listening on port ${PORT} (transport=${TRANSPORT})`);
});

if (TRANSPORT === "rabbitmq" || TRANSPORT === "nats") {
  transport.connectWithRetry();
}
