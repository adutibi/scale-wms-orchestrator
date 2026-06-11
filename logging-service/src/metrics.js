// In-memory metrics for the logging service, exposed over HTTP.
//
// Toggles (env):
//   METRICS_ENABLED=false  - disable the /metrics HTTP endpoint
//   METRICS_PORT           - endpoint port (default 9100)

const http = require("http");

const METRICS_ENABLED = (process.env.METRICS_ENABLED || "true").toLowerCase() !== "false";
const METRICS_PORT = Number(process.env.METRICS_PORT) || 9100;

const stats = {
  startedAt: new Date().toISOString(),
  audit: {
    total: 0,
    byStatus: {},
    byRoutingKey: {},
    byPath: {},
    durationMs: { count: 0, total: 0, max: 0 },
    errors: 0,
  },
  requestLogs: { total: 0 },
  queueDepths: {},
};

function recordAudit(event) {
  const a = stats.audit;
  a.total += 1;
  const status = String(event.statusCode ?? "unknown");
  a.byStatus[status] = (a.byStatus[status] || 0) + 1;
  if (event.routingKey) {
    a.byRoutingKey[event.routingKey] = (a.byRoutingKey[event.routingKey] || 0) + 1;
  }
  if (event.path) {
    a.byPath[event.path] = (a.byPath[event.path] || 0) + 1;
  }
  if (typeof event.durationMs === "number") {
    a.durationMs.count += 1;
    a.durationMs.total += event.durationMs;
    if (event.durationMs > a.durationMs.max) a.durationMs.max = event.durationMs;
  }
  if (event.error) a.errors += 1;
}

function recordRequestLog() {
  stats.requestLogs.total += 1;
}

function setQueueDepth(queue, depth) {
  stats.queueDepths[queue] = { depth, at: new Date().toISOString() };
}

function getSnapshot() {
  const d = stats.audit.durationMs;
  return {
    ...stats,
    audit: {
      ...stats.audit,
      durationMs: {
        ...d,
        avg: d.count > 0 ? Math.round((d.total / d.count) * 10) / 10 : 0,
      },
    },
    uptimeSeconds: Math.round(process.uptime()),
  };
}

function startMetricsServer() {
  if (!METRICS_ENABLED) {
    console.log("Metrics endpoint disabled (METRICS_ENABLED=false)");
    return null;
  }
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getSnapshot(), null, 2));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", hint: "GET /metrics" }));
    }
  });
  server.listen(METRICS_PORT, "0.0.0.0", () => {
    console.log(`Metrics endpoint on :${METRICS_PORT}/metrics`);
  });
  return server;
}

module.exports = { recordAudit, recordRequestLog, setQueueDepth, getSnapshot, startMetricsServer };
