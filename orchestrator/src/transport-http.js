const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS) || 30000;

function parseUrls(envName, fallback) {
  const raw = process.env[envName] || fallback;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

const roundRobin = { worker: 0, logging: 0 };

function pickUrl(key, urls) {
  if (urls.length === 0) return null;
  const url = urls[roundRobin[key] % urls.length];
  roundRobin[key] += 1;
  return url;
}

async function postExecute(baseUrl, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/internal/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`Service returned non-JSON (${res.status})`);
    }
    if (typeof envelope.statusCode !== "number") {
      throw new Error("Service response missing statusCode");
    }
    return {
      statusCode: envelope.statusCode,
      body: envelope.body !== undefined ? envelope.body : envelope,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Reply timeout");
    }
    throw err;
  }
}

async function forwardToWorker(payload) {
  const urls = parseUrls("WORKER_URLS", "http://localhost:4001");
  const base = pickUrl("worker", urls);
  if (!base) throw new Error("No worker URLs configured (WORKER_URLS)");
  return postExecute(base, payload);
}

async function forwardToLogging(payload) {
  const urls = parseUrls("LOGGING_HTTP_URL", "http://localhost:4101");
  const base = pickUrl("logging", urls);
  if (!base) throw new Error("No logging URL configured (LOGGING_HTTP_URL)");
  return postExecute(base, payload);
}

function publishAuditEvent(event) {
  const urls = parseUrls("LOGGING_HTTP_URL", "http://localhost:4101");
  const base = urls[0];
  if (!base) return;
  fetch(`${base}/internal/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "audit", ...event }),
  }).catch(() => {});
}

function isReady() {
  return parseUrls("WORKER_URLS", "http://localhost:4001").length > 0;
}

module.exports = {
  forwardToWorker,
  forwardToLogging,
  publishAuditEvent,
  isReady,
  parseUrls,
};
