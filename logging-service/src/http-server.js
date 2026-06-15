const express = require("express");
const { startMetricsServer } = require("./metrics");
const { processPayload } = require("./processPayload");

const PORT = Number(process.env.LOGGING_HTTP_PORT) || 4101;

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "logging", transport: "http" });
});

app.post("/internal/execute", (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({
        statusCode: 400,
        body: { error: "Request body must be a JSON object" },
      });
    }
    const reply = processPayload(payload);
    res.status(200).json(reply);
  } catch (err) {
    res.status(200).json({
      statusCode: 500,
      body: { error: err.message },
    });
  }
});

startMetricsServer();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Logging HTTP listening on port ${PORT} (POST /internal/execute)`);
});
