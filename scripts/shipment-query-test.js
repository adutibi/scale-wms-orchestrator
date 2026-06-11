#!/usr/bin/env node
/**
 * Fetches shipment IDs from ils DB and runs worker API calls with per-request timing.
 *
 * Usage: node scripts/shipment-query-test.js [baseUrl] [count] [concurrency]
 *   baseUrl      default http://localhost:3000
 *   count        default 100
 *   concurrency  default 10 (requests in flight)
 *
 * Environment:
 *   SHOW_RESPONSES=N   print full JSON body for first N successful responses
 *   RESPONSES_LOG=path append every response as one JSON line to file
 *   AUTH_TOKEN=...     bearer token to send (when orchestrator auth is enabled)
 *                      If unset and AUTH_APP_ID is set (.env), a synthetic
 *                      unsigned token is generated (works while the
 *                      orchestrator does not verify signatures).
 */

const sql = require("mssql");
const { buildMssqlConfig } = require("../config/database");

const BASE_URL = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const COUNT = Math.max(1, parseInt(process.argv[3], 10) || 100);
const CONCURRENCY = Math.max(1, parseInt(process.argv[4], 10) || 10);
const SCALE_API_PATH = "/ilsintegrationservices/scaleapi/ShipmentHeadersApi/Get";
const USE_SCALE_API = process.env.USE_LEGACY_API !== "1";
const QUERY_NAME = "ShipmentHeader.by.ShipmentId.and.Warehouse";
const SHOW_RESPONSES = Math.max(0, parseInt(process.env.SHOW_RESPONSES || "0", 10) || 0);
const RESPONSES_LOG = process.env.RESPONSES_LOG || "";
const fs = RESPONSES_LOG ? require("fs") : null;
let printedResponses = 0;

function buildAuthHeaders() {
  if (process.env.AUTH_TOKEN) {
    return { Authorization: `Bearer ${process.env.AUTH_TOKEN}` };
  }
  const appId = (process.env.AUTH_APP_ID || "").split(",")[0].trim();
  if (!appId) return {};
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const token =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({ appid: appId, exp: Math.floor(Date.now() / 1000) + 3600 }) +
    ".load-test";
  return { Authorization: `Bearer ${token}` };
}

const AUTH_HEADERS = buildAuthHeaders();

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function fetchShipmentPool() {
  const pool = await sql.connect(buildMssqlConfig());
  const result = await pool.request().query(`
    SELECT sh.SHIPMENT_ID AS shipmentID, sh.warehouse AS warehouse
    FROM SHIPMENT_HEADER sh
    INNER JOIN WAREHOUSE w ON sh.warehouse = w.warehouse
    WHERE sh.SHIPMENT_ID IS NOT NULL AND sh.warehouse IS NOT NULL
    ORDER BY sh.DATE_TIME_STAMP DESC
  `);
  await pool.close();
  return result.recordset;
}

function buildShipmentList(pool, count) {
  if (pool.length === 0) return [];
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push(pool[i % pool.length]);
  }
  return list;
}

async function callWorker(shipment) {
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  const params = new URLSearchParams({
    shipmentId: shipment.shipmentID,
    warehouse: shipment.warehouse,
  });
  const url = USE_SCALE_API
    ? `${BASE_URL}${SCALE_API_PATH}?${params}`
    : `${BASE_URL}/query`;
  try {
    const res = await fetch(url, {
      method: USE_SCALE_API ? "GET" : "POST",
      headers: USE_SCALE_API
        ? { ...AUTH_HEADERS }
        : {
            "Content-Type": "application/json",
            "X-Routing-Key": "worker",
            ...AUTH_HEADERS,
          },
      body: USE_SCALE_API
        ? undefined
        : JSON.stringify({
            query: QUERY_NAME,
            params: {
              shipmentID: shipment.shipmentID,
              warehouse: shipment.warehouse,
            },
          }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const elapsedMs = performance.now() - start;
    const bodyText = await res.text();
    let rows = 0;
    let body = bodyText;
    try {
      body = JSON.parse(bodyText);
      if (Array.isArray(body)) {
        rows = body.length;
      } else if (Array.isArray(body.rows)) {
        rows = body.rows.length;
      }
    } catch {
      // keep raw bodyText
    }
    return {
      ok: res.ok,
      status: res.status,
      elapsedMs,
      shipmentID: shipment.shipmentID,
      warehouse: shipment.warehouse,
      rows,
      body,
      url,
      error: res.ok ? null : bodyText.slice(0, 200),
    };
  } catch (err) {
    clearTimeout(timeout);
    return {
      ok: false,
      status: 0,
      elapsedMs: performance.now() - start,
      shipmentID: shipment.shipmentID,
      warehouse: shipment.warehouse,
      rows: 0,
      body: null,
      url,
      error: err.message,
    };
  }
}

function logResponse(n, r) {
  const entry = {
    request: n,
    ok: r.ok,
    status: r.status,
    elapsedMs: Math.round(r.elapsedMs * 10) / 10,
    shipmentId: r.shipmentID,
    warehouse: r.warehouse,
    rowCount: r.rows,
    url: r.url,
    body: r.body,
    error: r.error,
  };

  if (RESPONSES_LOG && fs) {
    fs.appendFileSync(RESPONSES_LOG, JSON.stringify(entry) + "\n");
  }

  if (r.ok && printedResponses < SHOW_RESPONSES) {
    printedResponses++;
    log(`--- Response #${n} ---`);
    log(`URL: ${r.url}`);
    log(`Status: ${r.status} | ${r.elapsedMs.toFixed(1)}ms | rows=${r.rows}`);
    console.log(JSON.stringify(r.body, null, 2));
    log("---");
  }
}

async function runBatch(shipments) {
  return Promise.all(shipments.map((s) => callWorker(s)));
}

async function main() {
  const verbose = COUNT <= 200;
  log(`Fetching shipment pool from ils...`);
  const pool = await fetchShipmentPool();
  if (pool.length === 0) {
    console.error("No shipments found in database.");
    process.exit(1);
  }
  const shipments = buildShipmentList(pool, COUNT);
  log(`Pool: ${pool.length} shipments, running ${COUNT} API calls (concurrency ${CONCURRENCY})...`);
  log(`Orchestrator: ${BASE_URL}`);
  log(`API mode: ${USE_SCALE_API ? "Scale GET " + SCALE_API_PATH : "legacy POST /query"}`);
  if (SHOW_RESPONSES > 0) log(`Showing first ${SHOW_RESPONSES} response bodies`);
  if (RESPONSES_LOG) {
    fs.writeFileSync(RESPONSES_LOG, "");
    log(`Logging all responses to: ${RESPONSES_LOG}`);
  }
  if (verbose) log("---");

  const wallStart = performance.now();
  const results = [];

  for (let i = 0; i < shipments.length; i += CONCURRENCY) {
    const batch = shipments.slice(i, i + CONCURRENCY);
    const batchResults = await runBatch(batch);
    results.push(...batchResults);

    if (verbose) {
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        const n = i + j + 1;
        const status = r.ok ? "OK" : "ERR";
        log(
          `#${String(n).padStart(3)} ${status} ${r.elapsedMs.toFixed(1)}ms ` +
            `shipment=${r.shipmentID} warehouse=${r.warehouse} rows=${r.rows}` +
            (r.error ? ` error=${r.error}` : "")
        );
        logResponse(n, r);
      }
    } else {
      for (let j = 0; j < batchResults.length; j++) {
        logResponse(i + j + 1, batchResults[j]);
      }
      if (results.length % 1000 < CONCURRENCY || results.length === shipments.length) {
      const batchErrors = batchResults.filter((r) => !r.ok).length;
        log(`Progress: ${results.length}/${COUNT} (${((results.length / COUNT) * 100).toFixed(1)}%) batchErrors=${batchErrors}`);
      }
    }
  }

  const wallMs = performance.now() - wallStart;
  const times = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const success = results.filter((r) => r.ok).length;
  const errors = results.length - success;

  log("---");
  log("Summary:");
  log(`  Total calls:   ${results.length}`);
  log(`  Success:       ${success}`);
  log(`  Errors:        ${errors}`);
  log(`  Wall time:     ${(wallMs / 1000).toFixed(2)}s`);
  log(`  Throughput:    ${(results.length / (wallMs / 1000)).toFixed(2)} req/s`);
  log(`  Latency min:   ${times[0]?.toFixed(1)}ms`);
  log(`  Latency p50:   ${percentile(times, 50).toFixed(1)}ms`);
  log(`  Latency p95:   ${percentile(times, 95).toFixed(1)}ms`);
  log(`  Latency max:   ${times[times.length - 1]?.toFixed(1)}ms`);
  log(`  Latency avg:   ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}ms`);
  if (RESPONSES_LOG) log(`  Responses log: ${RESPONSES_LOG}`);

  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
