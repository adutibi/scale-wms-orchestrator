const { connect, StringCodec } = require("nats");

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const WORKER_SUBJECT = process.env.NATS_WORKER_SUBJECT || "scale.worker";
const LOGGING_SUBJECT = process.env.NATS_LOGGING_SUBJECT || "scale.logging";
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS) || 30000;
const RECONNECT_DELAY_MS = Number(process.env.NATS_RECONNECT_DELAY_MS) || 5000;

const sc = StringCodec();
let nc = null;
let reconnectTimer = null;
let onConnectedCallback = null;

function parseEnvelope(text) {
  const envelope = JSON.parse(text);
  if (typeof envelope.statusCode !== "number") {
    throw new Error("Service response missing statusCode");
  }
  return {
    statusCode: envelope.statusCode,
    body: envelope.body !== undefined ? envelope.body : envelope,
  };
}

async function request(subject, payload) {
  if (!nc || nc.isClosed()) {
    throw new Error("NATS connection lost");
  }
  try {
    const msg = await nc.request(subject, sc.encode(JSON.stringify(payload)), {
      timeout: REPLY_TIMEOUT_MS,
    });
    return parseEnvelope(sc.decode(msg.data));
  } catch (err) {
    if (err.code === "TIMEOUT" || /timeout/i.test(err.message || "")) {
      throw new Error("Reply timeout");
    }
    throw err;
  }
}

async function forwardToWorker(payload) {
  return request(WORKER_SUBJECT, payload);
}

async function forwardToLogging(payload) {
  return request(LOGGING_SUBJECT, payload);
}

function publishAuditEvent(event) {
  if (!nc || nc.isClosed()) return;
  try {
    nc.publish(LOGGING_SUBJECT, sc.encode(JSON.stringify({ type: "audit", ...event })));
  } catch {
    // Auditing must never break the request path.
  }
}

function isReady() {
  return nc !== null && !nc.isClosed();
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.error(`NATS ${reason} - reconnecting in ${RECONNECT_DELAY_MS}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithRetry();
  }, RECONNECT_DELAY_MS);
}

async function connectNats() {
  const connection = await connect({ servers: NATS_URL });
  connection.closed().then((err) => {
    nc = null;
    if (err) {
      console.error("NATS connection closed:", err.message);
    }
    scheduleReconnect("connection closed");
  });
  nc = connection;
}

function connectWithRetry(onConnected) {
  if (onConnected) onConnectedCallback = onConnected;
  connectNats()
    .then(() => {
      console.log(`Connected to NATS (${NATS_URL})`);
      if (onConnectedCallback) onConnectedCallback();
    })
    .catch((err) => {
      scheduleReconnect(`connection failed (${err.message})`);
    });
}

module.exports = {
  connectWithRetry,
  forwardToWorker,
  forwardToLogging,
  publishAuditEvent,
  isReady,
};
