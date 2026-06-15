const { connect, StringCodec } = require("nats");
const { startMetricsServer } = require("./metrics");
const { processPayload } = require("./processPayload");

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const SUBJECT = process.env.NATS_LOGGING_SUBJECT || "scale.logging";
const QUEUE_GROUP = process.env.NATS_QUEUE_GROUP || "scale-logging";
const RECONNECT_DELAY_MS = Number(process.env.NATS_RECONNECT_DELAY_MS) || 5000;

const sc = StringCodec();
let reconnectTimer = null;

function logLine(level, type, fields) {
  console.log(JSON.stringify({ level, service: "logging", type, at: new Date().toISOString(), ...fields }));
}

function publishReply(nc, msg, payload) {
  if (!msg.reply) return;
  nc.publish(msg.reply, sc.encode(JSON.stringify(payload)));
}

async function handleMessage(nc, msg) {
  try {
    const payload = JSON.parse(sc.decode(msg.data));
    const reply = processPayload(payload);
    if (payload.type !== "audit") {
      publishReply(nc, msg, reply);
    }
  } catch (err) {
    logLine("error", "consume-error", { error: err.message });
    publishReply(nc, msg, { statusCode: 500, body: { error: err.message } });
  }
}

async function run() {
  const nc = await connect({ servers: NATS_URL });

  nc.closed().then((err) => {
    if (err) {
      console.error("Logging service NATS connection closed:", err.message);
    }
    scheduleReconnect("connection closed");
  });

  const sub = nc.subscribe(SUBJECT, { queue: QUEUE_GROUP });
  console.log(`Logging service subscribed to ${SUBJECT} (queue=${QUEUE_GROUP}, transport=nats)`);

  (async () => {
    for await (const msg of sub) {
      await handleMessage(nc, msg);
    }
  })();
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.error(`Logging service NATS ${reason} - reconnecting in ${RECONNECT_DELAY_MS}ms`);
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
