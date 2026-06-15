#!/usr/bin/env node
/**
 * Compare SQL connect latency: hostname vs IP (Docker DNS issue on Windows).
 * Usage: node scripts/compare-sql-target.js [hostname] [ip]
 */
const { performance } = require("perf_hooks");
const sql = require("mssql");
const path = require("path");

const HOSTNAME = process.argv[2] || "Wms-qasql";
const IP = process.argv[3] || "10.16.36.212";
const ROUNDS = 5;

async function timedQuery(server) {
  const envPath = path.resolve(__dirname, "../.env");
  require("dotenv").config({ path: envPath });
  process.env.DB_SERVER = server;

  delete require.cache[require.resolve("../config/database")];
  const { buildMssqlConfig } = require("../config/database");

  const times = [];
  for (let i = 0; i < ROUNDS; i++) {
    const pool = await sql.connect(buildMssqlConfig());
    const start = performance.now();
    await pool.request().query("SELECT 1 AS ok");
    times.push(performance.now() - start);
    await pool.close();
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { server, times, avg };
}

async function main() {
  console.log(`SQL target comparison (${ROUNDS} cold connect+query each)\n`);
  const a = await timedQuery(HOSTNAME);
  const b = await timedQuery(IP);
  console.log(`${HOSTNAME}: avg ${a.avg.toFixed(1)} ms  (${a.times.map((t) => t.toFixed(0)).join(", ")})`);
  console.log(`${IP}: avg ${b.avg.toFixed(1)} ms  (${b.times.map((t) => t.toFixed(0)).join(", ")})`);
  const ratio = a.avg / b.avg;
  if (ratio > 1.5) {
    console.log(`\n→ Use IP in .env (DB_SERVER=${IP}). Hostname is ~${ratio.toFixed(1)}× slower.`);
  } else {
    console.log("\n→ Hostname and IP are similar; look elsewhere for bottlenecks.");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
