#!/usr/bin/env node
/**
 * Identifies where time is spent: SQL direct, HTTP pipeline, queue depth.
 */
const { performance } = require("perf_hooks");
const sql = require("mssql");
const { buildMssqlConfig } = require("../config/database");
const queries = require("../worker-service/src/queries");

const BASE_URL = (process.argv[2] || "http://localhost:3001").replace(/\/$/, "");
const SHIPMENT = { shipmentID: "P2606120019301", warehouse: "FAN-DC" };

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
const AUTH_TOKEN =
  process.env.AUTH_TOKEN ||
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.load-test`;

function pct(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function stats(label, times) {
  const s = [...times].sort((a, b) => a - b);
  console.log(
    `${label}: n=${s.length} avg=${avg(s).toFixed(1)}ms p50=${pct(s, 50).toFixed(1)}ms p95=${pct(s, 95).toFixed(1)}ms max=${s[s.length - 1]?.toFixed(1)}ms`
  );
}

async function fetchShipment() {
  const params = new URLSearchParams({
    shipmentId: SHIPMENT.shipmentID,
    warehouse: SHIPMENT.warehouse,
  });
  const url = `${BASE_URL}/ilsintegrationservices/scaleapi/ShipmentHeadersApi/Get?${params}`;
  const start = performance.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  const elapsed = performance.now() - start;
  const body = await res.json();
  return {
    ok: res.ok,
    elapsed,
    queryMs: body?.timings?.queryMs,
    workerMs: body?.timings?.workerMs,
    rows: Array.isArray(body) ? body.length : body?.rows?.length,
  };
}

async function runParallel(n, concurrency, fn) {
  const times = [];
  let i = 0;
  async function worker() {
    while (i < n) {
      const idx = i++;
      const r = await fn(idx);
      times.push(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return times;
}

async function rabbitQueue(name) {
  const auth = Buffer.from("scale:scale_secret").toString("base64");
  const res = await fetch(`http://localhost:15672/api/queues/%2F/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function sqlDirect(n, concurrency) {
  const pool = await sql.connect(buildMssqlConfig({ pool: { max: concurrency } }));
  const q = queries["ShipmentHeader.by.ShipmentId.and.Warehouse"];
  const times = await runParallel(n, concurrency, async () => {
    const start = performance.now();
    const req = pool.request();
    req.input("shipmentID", sql.NVarChar, SHIPMENT.shipmentID);
    req.input("warehouse", sql.NVarChar, SHIPMENT.warehouse);
    await req.query(q.sql);
    return performance.now() - start;
  });
  await pool.close();
  return times;
}

async function sampleQueuesDuringLoad(durationMs = 14000) {
  const samples = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const [workerQ, replyQ] = await Promise.all([
      rabbitQueue("scale.worker"),
      rabbitQueue("orchestrator.replies"),
    ]);
    samples.push({
      t: Date.now(),
      workerReady: workerQ?.messages_ready ?? -1,
      workerUnacked: workerQ?.messages_unacknowledged ?? -1,
      workerConsumers: workerQ?.consumers ?? -1,
      replyReady: replyQ?.messages_ready ?? -1,
      replyUnacked: replyQ?.messages_unacknowledged ?? -1,
    });
    await new Promise((r) => setTimeout(r, 500));
  }
  return samples;
}

async function main() {
  console.log("=== Bottleneck diagnostic ===\n");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Shipment: ${SHIPMENT.shipmentID} / ${SHIPMENT.warehouse}\n`);

  // 1) Cold + warm single HTTP
  const cold = await fetchShipment();
  console.log("1) Single HTTP (warm):", {
    ok: cold.ok,
    elapsedMs: cold.elapsed.toFixed(1),
    queryMs: cold.queryMs,
    workerMs: cold.workerMs,
    pipelineMs: cold.elapsed - (cold.workerMs || 0),
  });

  // 2) Direct SQL baseline
  console.log("\n2) Direct SQL (bypass RabbitMQ/orchestrator):");
  const sqlSeq = await sqlDirect(20, 1);
  stats("   sequential x20", sqlSeq);
  const sqlPar = await sqlDirect(100, 50);
  stats("   parallel 100 @ concurrency 50", sqlPar);

  // 3) HTTP at low concurrency
  console.log("\n3) HTTP orchestrator path:");
  const http10 = await runParallel(20, 1, () => fetchShipment());
  stats("   sequential x20 elapsed", http10.map((r) => r.elapsed));
  const httpPar10 = await runParallel(100, 10, () => fetchShipment());
  stats("   parallel 100 @ concurrency 10 elapsed", httpPar10.map((r) => r.elapsed));
  const withTimings = httpPar10.filter((r) => r.queryMs != null);
  if (withTimings.length) {
    stats("   queryMs (worker)", withTimings.map((r) => r.queryMs));
    stats("   workerMs", withTimings.map((r) => r.workerMs));
    stats(
      "   pipeline (elapsed-workerMs)",
      withTimings.map((r) => r.elapsed - r.workerMs)
    );
  }

  // 4) Load test with queue sampling
  console.log("\n4) Load 1000 @ concurrency 100 + RabbitMQ queue samples:");
  const sampler = sampleQueuesDuringLoad(16000);
  const loadStart = performance.now();
  const load = await runParallel(1000, 100, () => fetchShipment());
  const loadWall = performance.now() - loadStart;
  const samples = await sampler;

  stats("   elapsed", load.map((r) => r.elapsed));
  const loadTimings = load.filter((r) => r.queryMs != null);
  stats("   queryMs", loadTimings.map((r) => r.queryMs));
  stats("   workerMs", loadTimings.map((r) => r.workerMs));
  stats("   pipeline (elapsed-workerMs)", loadTimings.map((r) => r.elapsed - r.workerMs));
  console.log(`   wall=${(loadWall / 1000).toFixed(2)}s throughput=${(1000 / (loadWall / 1000)).toFixed(2)} req/s`);

  const maxWorkerReady = Math.max(...samples.map((s) => s.workerReady));
  const maxWorkerUnacked = Math.max(...samples.map((s) => s.workerUnacked));
  const maxReplyReady = Math.max(...samples.map((s) => s.replyReady));
  const consumers = samples[0]?.workerConsumers;
  console.log("\n   RabbitMQ peaks during load:");
  console.log(`   scale.worker: consumers=${consumers} max_ready=${maxWorkerReady} max_unacked=${maxWorkerUnacked}`);
  console.log(`   orchestrator.replies: max_ready=${maxReplyReady}`);

  // 5) Breakdown %
  const qAvg = avg(loadTimings.map((r) => r.queryMs));
  const wAvg = avg(loadTimings.map((r) => r.workerMs));
  const pAvg = avg(loadTimings.map((r) => r.elapsed - r.workerMs));
  const eAvg = avg(load.map((r) => r.elapsed));
  console.log("\n5) Average time budget per request @ load:");
  console.log(`   SQL query:     ${qAvg.toFixed(1)}ms (${((qAvg / eAvg) * 100).toFixed(0)}%)`);
  console.log(`   Worker total:  ${wAvg.toFixed(1)}ms (${((wAvg / eAvg) * 100).toFixed(0)}%)`);
  console.log(`   Pipeline wait: ${pAvg.toFixed(1)}ms (${((pAvg / eAvg) * 100).toFixed(0)}%)`);

  console.log("\n6) Verdict:");
  if (maxWorkerReady > 50) {
    console.log("   -> Worker queue backs up (workers too slow or too few).");
  } else if (maxWorkerReady <= 5 && pAvg > qAvg * 1.5) {
    console.log("   -> Pipeline/orchestrator wait dominates; worker queue stays shallow.");
  }
  if (avg(sqlPar) < qAvg * 0.5) {
    console.log("   -> SQL is faster direct than through workers -> pool/contention per worker or queue dispatch.");
  } else if (avg(sqlPar) >= qAvg * 0.8) {
    console.log("   -> SQL time similar direct vs worker path -> SQL/QA DB is major cost.");
  }
  if (pAvg > qAvg && maxWorkerReady < 20) {
    console.log("   -> PRIMARY BOTTLENECK: orchestrator request-reply + HTTP concurrency (not SQL, not worker queue depth).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
