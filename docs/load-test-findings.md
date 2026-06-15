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

`extra_hosts` in `docker-compose.yml` maps `Wms-qasql` → `10.16.36.212` so hostname-based configs still work in containers.

## Windows Server vs MacBook (same QA SQL)

Same stack (5 workers, 1000 req, non-persistent orchestrator messages), different host:

| | MacBook (Docker) | Windows Server (Docker) | Ratio |
|---|---|---|---|
| Throughput @ c=100 | **644 req/s** | ~83 req/s | **7.8×** |
| Avg latency @ c=100 | **90 ms** | ~940 ms | **10×** |
| Throughput @ c=300 | **1048 req/s** | ~77 req/s (saturated) | **13×** |

**Findings on Windows:**

1. **SQL hostname vs IP** — from the host, `Wms-qasql` connect+query ~143 ms vs `10.16.36.212` ~32 ms. Use the IP in `.env` for workers.
2. **Docker on Windows Server** — NAT/Hyper-V networking adds latency on every hop (client → orchestrator → RabbitMQ → worker → SQL). Mac Docker (Linux VM) is much faster for the same path.
3. **Orchestrator not CPU-bound** — ~0–32% CPU during load; RabbitMQ spikes to ~170% CPU. Bottleneck is broker routing + wait, not worker count (queue `max_ready=0` with 5 workers).
4. **Scaling workers 1→5 on Windows** did not raise throughput (~73 → ~75 req/s) — unlike Mac, where 5 workers unlock 600+ req/s.

**Mitigations applied:** `DB_SERVER=10.16.36.212`, `extra_hosts`, `persistent: false` on orchestrator publish, disable `WORKER_TIMING_TRACE_ENABLED` for benchmarks.

### Windows native mode (orchestrator + workers on host, RabbitMQ in Docker)

After `scripts/windows/run-native.ps1 -WorkerCount 5`:

| | Docker (5 workers) | Native (5 workers) | Mac Docker |
|---|---|---|---|
| Throughput @ c=100 | ~84 req/s | **191 req/s** | 644 req/s |
| Avg latency @ c=100 | ~841 ms | **358 ms** | 90 ms |
| p95 @ c=100 | ~1762 ms | **1052 ms** | 280 ms |

Native mode on Windows is **~2.3× faster** than all-in-Docker on the same machine. Remaining gap vs Mac is likely RabbitMQ still in Docker + Windows host vs macOS networking.

**If Windows throughput must match Mac:** run worker + orchestrator **natively** (see `run-native.ps1`), or deploy containers on **Linux** (same LAN as SQL).
