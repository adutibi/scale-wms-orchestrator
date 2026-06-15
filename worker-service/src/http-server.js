const express = require("express");
const { getPool } = require("./db");
const { processRequest } = require("./processRequest");

const PORT = Number(process.env.WORKER_HTTP_PORT) || 4001;

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "worker", transport: "http" });
});

app.post("/internal/execute", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({
        statusCode: 400,
        body: { error: "Request body must be a JSON object" },
      });
    }
    const reply = await processRequest(payload);
    res.status(200).json(reply);
  } catch (err) {
    console.error("[WORKER] HTTP execute error:", err.message);
    res.status(200).json({
      statusCode: 500,
      body: { ok: false, error: err.message },
    });
  }
});

async function start() {
  await getPool();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Worker HTTP listening on port ${PORT} (POST /internal/execute)`);
  });
}

start().catch((err) => {
  console.error("[WORKER] Failed to start HTTP server:", err.message);
  process.exit(1);
});
