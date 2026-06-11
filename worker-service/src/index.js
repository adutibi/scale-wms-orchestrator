const amqp = require("amqplib");
const queries = require("./queries");
const { getPool, runNamedQuery } = require("./db");
const { mapShipmentHeaderRows } = require("./mappers/shipmentHeader");
const {
  isScaleShipmentHeadersGet,
  getShipmentHeadersParams,
  QUERY_SHIPMENT_BY_ID_WAREHOUSE,
} = require("./routes");

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

function extractQueryRequest(payload) {
  const body = payload.body;
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object with { query, params? }" };
  }
  const queryName = body.query;
  if (!queryName || typeof queryName !== "string") {
    return { error: "Missing or invalid 'query' field in request body" };
  }
  const params = body.params && typeof body.params === "object" ? body.params : {};
  return { queryName, params };
}

async function handleScaleShipmentHeadersGet(channel, msg, payload) {
  const extracted = getShipmentHeadersParams(payload);
  if (extracted.error) {
    sendReply(channel, msg, { statusCode: 400, body: { error: extracted.error } });
    channel.ack(msg);
    return;
  }

  const queryDef = queries[QUERY_SHIPMENT_BY_ID_WAREHOUSE];
  try {
    const result = await runNamedQuery(queryDef, extracted.params);
    const body = mapShipmentHeaderRows(result.rows);
    console.log("[WORKER] Scale API ShipmentHeadersApi/Get:", {
      at: new Date().toISOString(),
      correlationId: payload.correlationId,
      shipmentId: extracted.params.shipmentID,
      warehouse: extracted.params.warehouse,
      rowCount: body.length,
    });
    sendReply(channel, msg, { statusCode: 200, body });
    channel.ack(msg);
  } catch (err) {
    console.error("[WORKER] ShipmentHeadersApi/Get error:", err.message);
    sendReply(channel, msg, { statusCode: 500, body: { error: err.message } });
    channel.ack(msg);
  }
}

async function handleNamedQuery(channel, msg, payload) {
  const extracted = extractQueryRequest(payload);
  if (extracted.error) {
    sendReply(channel, msg, {
      statusCode: 400,
      body: { ok: false, error: extracted.error },
    });
    channel.ack(msg);
    return;
  }

  const { queryName, params } = extracted;
  const queryDef = queries[queryName];

  if (!queryDef) {
    sendReply(channel, msg, {
      statusCode: 400,
      body: {
        ok: false,
        error: `Unknown query: ${queryName}`,
        availableQueries: Object.keys(queries),
      },
    });
    channel.ack(msg);
    return;
  }

  try {
    const result = await runNamedQuery(queryDef, params);
    console.log("[WORKER] Query executed:", {
      service: "worker",
      at: new Date().toISOString(),
      correlationId: payload.correlationId,
      query: queryName,
      rowCount: result.rowCount,
    });
    sendReply(channel, msg, {
      statusCode: 200,
      body: {
        ok: true,
        query: queryName,
        rowCount: result.rowCount,
        rows: result.rows,
      },
    });
    channel.ack(msg);
  } catch (err) {
    console.error("[WORKER] Query error:", err.message);
    sendReply(channel, msg, {
      statusCode: 500,
      body: { ok: false, error: err.message, query: queryName },
    });
    channel.ack(msg);
  }
}

async function processMessage(channel, msg) {
  const payload = JSON.parse(msg.content.toString());

  if (isScaleShipmentHeadersGet(payload)) {
    await handleScaleShipmentHeadersGet(channel, msg, payload);
    return;
  }

  await handleNamedQuery(channel, msg, payload);
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
    processMessage(channel, msg).catch((err) => {
      console.error("[WORKER] Unhandled error:", err);
      sendReply(channel, msg, {
        statusCode: 500,
        body: { ok: false, error: err.message },
      });
      channel.ack(msg);
    });
  });

  console.log(`Worker service bound to ${ROUTING_KEY} (prefetch=${PREFETCH})`);
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
