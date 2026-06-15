const amqp = require("amqplib");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const EXCHANGE = "scale.topic";
const REPLY_QUEUE = "orchestrator.replies";
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

let onConnectedCallback = null;

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

function connectWithRetry(onConnected) {
  if (onConnected) onConnectedCallback = onConnected;
  connectRabbitMQ()
    .then(() => {
      console.log("Connected to RabbitMQ");
      if (onConnectedCallback) onConnectedCallback();
    })
    .catch((err) => {
      scheduleReconnect(`connection failed (${err.message})`);
    });
}

function isReady() {
  return channel !== null;
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

async function forwardRequest(routingKey, payload, correlationId) {
  if (!channel) {
    throw new Error("RabbitMQ connection lost");
  }
  const content = Buffer.from(JSON.stringify(payload));
  channel.publish(EXCHANGE, routingKey, content, {
    persistent: false,
    contentType: "application/json",
    replyTo: REPLY_QUEUE,
    correlationId,
  });
  return waitForReply(correlationId);
}

function publishAuditEvent(event) {
  if (!channel) return;
  try {
    const content = Buffer.from(JSON.stringify({ type: "audit", ...event }));
    channel.publish(EXCHANGE, "logging", content, { contentType: "application/json" });
  } catch {
    // Auditing must never break the request path.
  }
}

async function forwardToWorker(payload) {
  return forwardRequest("worker", payload, payload.correlationId);
}

async function forwardToLogging(payload) {
  return forwardRequest("logging", payload, payload.correlationId);
}

module.exports = {
  connectWithRetry,
  isReady,
  forwardToWorker,
  forwardToLogging,
  forwardRequest,
  publishAuditEvent,
};
