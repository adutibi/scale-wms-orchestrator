const { recordAudit, recordRequestLog } = require("./metrics");

function logLine(level, type, fields) {
  console.log(JSON.stringify({ level, service: "logging", type, at: new Date().toISOString(), ...fields }));
}

function processPayload(payload) {
  if (payload.type === "audit") {
    recordAudit(payload);
    logLine("info", "audit", {
      correlationId: payload.correlationId,
      method: payload.method,
      path: payload.path,
      routingKey: payload.routingKey,
      statusCode: payload.statusCode,
      durationMs: payload.durationMs,
      ...(payload.error ? { error: payload.error } : {}),
    });
    return { statusCode: 200, body: { ok: true, type: "audit" } };
  }

  recordRequestLog();
  const at = new Date().toISOString();
  logLine("info", "request", {
    correlationId: payload.correlationId,
    method: payload.method,
    path: payload.path,
    body: payload.body,
  });
  return { statusCode: 200, body: { ok: true, logged: true, at } };
}

module.exports = { processPayload };
