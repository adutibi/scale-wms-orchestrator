const amqp = require("amqplib");
const { getPool } = require("./db");
const { processRequest } = require("./processRequest");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const EXCHANGE = "scale.topic";
const ROUTING_KEY = "worker";
const QUEUE = "scale.worker";
const PREFETCH = Number(process.env.WORKER_PREFETCH) || 20;
const RECONNECT_DELAY_MS = Number(process.env.RABBITMQ_RECONNECT_DELAY_MS) || 5000;

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

async function processMessage(channel, msg) {
  const payload = JSON.parse(msg.content.toString());
  try {
    const reply = await processRequest(payload);
    sendReply(channel, msg, reply);
    channel.ack(msg);
  } catch (err) {
    console.error("[WORKER] Unhandled error:", err);
    sendReply(channel, msg, {
      statusCode: 500,
      body: { ok: false, error: err.message },
    });
    channel.ack(msg);
  }
}

async function run() {
  await getPool();

  const conn = await amqp.connect(RABBITMQ_URL);

  conn.on("error", (err) => {
    console.error("[WORKER] RabbitMQ connection error:", err.message);
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
    processMessage(channel, msg);
  });

  console.log(`Worker service bound to ${ROUTING_KEY} (prefetch=${PREFETCH}, transport=rabbitmq)`);
}

let reconnectTimer = null;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.error(`[WORKER] RabbitMQ ${reason} - reconnecting in ${RECONNECT_DELAY_MS}ms`);
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
