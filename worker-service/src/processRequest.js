const { performance } = require("perf_hooks");
const queries = require("./queries");
const { runNamedQuery } = require("./db");
const { mapShipmentHeaderRows } = require("./mappers/shipmentHeader");
const {
  isScaleShipmentHeadersGet,
  getShipmentHeadersParams,
  QUERY_SHIPMENT_BY_ID_WAREHOUSE,
} = require("./routes");

const REQUEST_LOG_ENABLED = (process.env.WORKER_REQUEST_LOG_ENABLED || "false").toLowerCase() === "true";
const TIMING_TRACE_ENABLED = (process.env.WORKER_TIMING_TRACE_ENABLED || "false").toLowerCase() === "true";

function roundMs(value) {
  return Math.round(value * 10) / 10;
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

async function handleScaleShipmentHeadersGet(payload, context) {
  const extracted = getShipmentHeadersParams(payload);
  if (extracted.error) {
    return { statusCode: 400, body: { error: extracted.error } };
  }

  const queryDef = queries[QUERY_SHIPMENT_BY_ID_WAREHOUSE];
  try {
    const queryStartedAt = performance.now();
    const result = await runNamedQuery(queryDef, extracted.params);
    const queryFinishedAt = performance.now();
    const body = mapShipmentHeaderRows(result.rows);
    if (REQUEST_LOG_ENABLED) {
      console.log("[WORKER] Scale API ShipmentHeadersApi/Get:", {
        at: new Date().toISOString(),
        correlationId: payload.correlationId,
        shipmentId: extracted.params.shipmentID,
        warehouse: extracted.params.warehouse,
        rowCount: body.length,
      });
    }
    const replyBody = TIMING_TRACE_ENABLED
      ? {
          rows: body,
          timings: {
            queryMs: roundMs(queryFinishedAt - queryStartedAt),
            workerMs: roundMs(performance.now() - context.messageReceivedAt),
          },
        }
      : body;
    return { statusCode: 200, body: replyBody };
  } catch (err) {
    console.error("[WORKER] ShipmentHeadersApi/Get error:", err.message);
    return { statusCode: 500, body: { error: err.message } };
  }
}

async function handleNamedQuery(payload, context) {
  const extracted = extractQueryRequest(payload);
  if (extracted.error) {
    return {
      statusCode: 400,
      body: { ok: false, error: extracted.error },
    };
  }

  const { queryName, params } = extracted;
  const queryDef = queries[queryName];

  if (!queryDef) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: `Unknown query: ${queryName}`,
        availableQueries: Object.keys(queries),
      },
    };
  }

  try {
    const queryStartedAt = performance.now();
    const result = await runNamedQuery(queryDef, params);
    const queryFinishedAt = performance.now();
    if (REQUEST_LOG_ENABLED) {
      console.log("[WORKER] Query executed:", {
        service: "worker",
        at: new Date().toISOString(),
        correlationId: payload.correlationId,
        query: queryName,
        rowCount: result.rowCount,
      });
    }
    const timings = TIMING_TRACE_ENABLED
      ? {
          queryMs: roundMs(queryFinishedAt - queryStartedAt),
          workerMs: roundMs(performance.now() - context.messageReceivedAt),
        }
      : null;
    return {
      statusCode: 200,
      body: {
        ok: true,
        query: queryName,
        rowCount: result.rowCount,
        rows: result.rows,
        ...(timings ? { timings } : {}),
      },
    };
  } catch (err) {
    console.error("[WORKER] Query error:", err.message);
    return {
      statusCode: 500,
      body: { ok: false, error: err.message, query: queryName },
    };
  }
}

async function processRequest(payload) {
  const context = { messageReceivedAt: performance.now() };
  if (isScaleShipmentHeadersGet(payload)) {
    return handleScaleShipmentHeadersGet(payload, context);
  }
  return handleNamedQuery(payload, context);
}

module.exports = { processRequest };
