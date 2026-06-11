const amqp = require("amqplib");
const { recordAudit, recordRequestLog, setQueueDepth, startMetricsServer } = require("./metrics");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const EXCHANGE = "scale.topic";
const ROUTING_KEY = "logging";
const QUEUE = "scale.logging";
const PREFETCH = Number(process.env.LOGGING_PREFETCH) || 20;
const RECONNECT_DELAY_MS = Number(process.env.RABBITMQ_RECONNECT_DELAY_MS) || 5000;

// Queue-depth monitor toggles
const QUEUE_MONITOR_ENABLED = (process.env.QUEUE_MONITOR_ENABLED || "true").toLowerCase() !== "false";
const QUEUE_MONITOR_INTERVAL_MS = Number(process.env.QUEUE_MONITOR_INTERVAL_MS) || 15000;
const QUEUE_DEPTH_WARN_THRESHOLD = Number(process.env.QUEUE_DEPTH_WARN_THRESHOLD) || 100;
const MONITORED_QUEUES = (process.env.MONITORED_QUEUES || "scale.logging,scale.worker,orchestrator.replies")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function logLine(level, type, fields) {
  console.log(JSON.stringify({ level, service: "logging", type, at: new Date().toISOString(), ...fields }));
}

function sendReply(channel, msg, payload) {
  const replyTo = msg.properties.replyTo;
  const correlationId = msg.properties.correlationId;
  if (!replyTo || !correlationId) return;
  const content = Buffer.from(JSON.stringify(payload));
  channel.sendToQueue(replyTo, content, {
    correlationId,
    contentType: "application/json",
  });
}

async function run() {
  const conn = await amqp.connect(RABBITMQ_URL);

  conn.on("error", (err) => {
    console.error("Logging service RabbitMQ connection error:", err.message);
  });
  conn.on("close", () => {
    scheduleReconnect("connection closed");
  });

  const channel = await conn.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  channel.prefetch(PREFETCH);

  channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());

      // Fire-and-forget audit events from the orchestrator (no replyTo).
      if (payload.type === "audit") {
        recordAudit(payload);
        logLine("info", "audit", {
          correlationId: payload.correlationId,
          method: payload.method,
          path: payload.path,
          routingKey: payload.routingKey,
          statusCode: payload.statusCode,
          durationMs: payload.durationMs,
          ...(payload.error ? { error: payload.error } : {}),
        });
        channel.ack(msg);
        return;
      }

      // Regular request-logging messages (routing key "logging").
      recordRequestLog();
      const at = new Date().toISOString();
      logLine("info", "request", {
        correlationId: payload.correlationId,
        method: payload.method,
        path: payload.path,
        body: payload.body,
      });
      sendReply(channel, msg, {
        statusCode: 200,
        body: { ok: true, logged: true, at },
      });
      channel.ack(msg);
    } catch (err) {
      logLine("error", "consume-error", { error: err.message });
      sendReply(channel, msg, {
        statusCode: 500,
        body: { error: err.message },
      });
      channel.ack(msg);
    }
  });

  startQueueMonitor(conn);

  console.log(`Logging service bound to ${ROUTING_KEY} (prefetch=${PREFETCH})`);
}

// --- Queue-depth monitor -------------------------------------------------

let monitorChannel = null;
let monitorTimer = null;

function startQueueMonitor(conn) {
  if (!QUEUE_MONITOR_ENABLED) {
    console.log("Queue-depth monitor disabled (QUEUE_MONITOR_ENABLED=false)");
    return;
  }
  if (monitorTimer) clearInterval(monitorTimer);
  monitorChannel = null;

  conn.on("close", () => {
    clearInterval(monitorTimer);
    monitorTimer = null;
    monitorChannel = null;
  });

  monitorTimer = setInterval(async () => {
    try {
      if (!monitorChannel) monitorChannel = await conn.createChannel();
      for (const queue of MONITORED_QUEUES) {
        const { messageCount } = await monitorChannel.checkQueue(queue);
        setQueueDepth(queue, messageCount);
        if (messageCount > QUEUE_DEPTH_WARN_THRESHOLD) {
          logLine("warn", "queue-depth", {
            queue,
            depth: messageCount,
            threshold: QUEUE_DEPTH_WARN_THRESHOLD,
          });
        }
      }
    } catch (err) {
      // checkQueue on a missing queue closes the channel; recreate next tick.
      monitorChannel = null;
      logLine("warn", "queue-monitor-error", { error: err.message });
    }
  }, QUEUE_MONITOR_INTERVAL_MS);

  console.log(
    `Queue-depth monitor: ${MONITORED_QUEUES.join(", ")} every ${QUEUE_MONITOR_INTERVAL_MS}ms (warn > ${QUEUE_DEPTH_WARN_THRESHOLD})`
  );
}

let reconnectTimer = null;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.error(`Logging service RabbitMQ ${reason} - reconnecting in ${RECONNECT_DELAY_MS}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnect();
  }, RECONNECT_DELAY_MS);
}

function reconnect() {
  run().catch((err) => {
    scheduleReconnect(`connection failed (${err.message})`);
  });
}

startMetricsServer();
reconnect();
