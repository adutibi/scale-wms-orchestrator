const { connect, StringCodec } = require("nats");
const { getPool } = require("./db");
const { processRequest } = require("./processRequest");

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const SUBJECT = process.env.NATS_WORKER_SUBJECT || "scale.worker";
const QUEUE_GROUP = process.env.NATS_QUEUE_GROUP || "scale-workers";
const RECONNECT_DELAY_MS = Number(process.env.NATS_RECONNECT_DELAY_MS) || 5000;

const sc = StringCodec();
let reconnectTimer = null;

function publishReply(nc, msg, payload) {
  if (!msg.reply) return;
  nc.publish(msg.reply, sc.encode(JSON.stringify(payload)));
}

async function handleMessage(nc, msg) {
  try {
    const payload = JSON.parse(sc.decode(msg.data));
    const reply = await processRequest(payload);
    publishReply(nc, msg, reply);
  } catch (err) {
    console.error("[WORKER] NATS error:", err.message);
    publishReply(nc, msg, {
      statusCode: 500,
      body: { ok: false, error: err.message },
    });
  }
}

async function run() {
  await getPool();
  const nc = await connect({ servers: NATS_URL });

  nc.closed().then((err) => {
    if (err) {
      console.error("[WORKER] NATS connection closed:", err.message);
    }
    scheduleReconnect("connection closed");
  });

  const sub = nc.subscribe(SUBJECT, { queue: QUEUE_GROUP });
  console.log(`Worker subscribed to ${SUBJECT} (queue=${QUEUE_GROUP}, transport=nats)`);

  (async () => {
    for await (const msg of sub) {
      await handleMessage(nc, msg);
    }
  })();
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.error(`[WORKER] NATS ${reason} - reconnecting in ${RECONNECT_DELAY_MS}ms`);
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

reconnect();
