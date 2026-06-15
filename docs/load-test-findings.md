# Load test findings

**Date:** 2026-06-15  
**Environment:** QA SQL (`10.16.36.212:1433/ILS`), Docker Compose, 5 worker replicas  
**Endpoint:** `GET /ilsintegrationservices/scaleapi/ShipmentHeadersApi/Get`  
**Script:** `scripts/shipment-query-test.js`

## Setup

| Parameter | Value |
|-----------|-------|
| Requests | 1000 |
| Workers | 5 (`docker compose up -d --scale worker-service=5`) |
| DB pool max | 100 |
| Worker prefetch | 50 |
| Orchestrator reply timeout | 30s |

## Results

| | concurrency 100 | concurrency 300 | Delta |
|---|---|---|---|
| **Throughput** | 644.21 req/s | 1048.48 req/s | +63% |
| **Avg latency** | 90 ms | 156 ms | +74% |
| **p95** | 280 ms | 269 ms | flat / slightly down |
| **Max** | 439 ms | 294 ms | −33% |
| **Success** | 1000/1000 | 1000/1000 | — |
| **Wall time** | 1.55s | 0.95s | — |

### Per-run detail

**Baseline (concurrency 100)**

- Throughput: 644.21 req/s
- Latency min / p50 / p95 / max / avg: 22.8 / 64.6 / 279.7 / 438.6 / 89.7 ms

**Saturated run (concurrency 300)**

- Throughput: 1048.48 req/s
- Latency min / p50 / p95 / max / avg: 30.2 / 159.7 / 268.5 / 294.4 / 155.9 ms

## Conclusion

With **5 workers**, the system is **not saturated** at 300 concurrency:

- Throughput increases when concurrency goes from 100 → 300.
- Average latency rises slightly (+74%), but p95 and max stay under ~300 ms.
- All 1000 requests succeed in both runs.

This differs from a single-worker baseline (~80 req/s, saturation at 300 concurrency with p95 > 4s). Horizontal scaling to 5 workers removes the bottleneck.

## Infrastructure note

Workers inside Docker could not resolve the hostname `Wms-qasql`. Setting `DB_SERVER=10.16.36.212` in `.env` fixed SQL connectivity from containers. Without this, all requests timed out at ~30s (0/1000 success).
