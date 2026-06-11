# OpenMemory Guide – scale-wms-orchestrator

## Overview

Scale WMS microservices orchestrator: Express API routes HTTP requests via RabbitMQ to logging and SQL worker services. Request-reply pattern with correlation IDs.

## Architecture

- **orchestrator/** – HTTP entry point, publishes to `scale.topic`, consumes `orchestrator.replies`
- **logging-service/** – Logs requests (routing key `logging`)
- **worker-service/** – Named SQL queries against SQL Server `ils` DB (routing key `worker`)
- **RabbitMQ** – Topic exchange `scale.topic`

## User Defined Namespaces

- (none defined)

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| Orchestrator | `orchestrator/` | HTTP → RabbitMQ → HTTP reply |
| Logging | `logging-service/` | Request logging |
| Worker | `worker-service/` | SQL named queries via `mssql` pool |
| Scripts | `scripts/` | `test-db-connection.js`, `capacity-test.js` |

## Patterns

- Routing via `X-Routing-Key` header
- Scale API route contracts centralized in `config/scaleRoutes.js` (name/method/pathPattern/routingKey) — consumed by orchestrator (auto-routing) AND worker (dispatch) via `<service>/config/scaleRoutes.js` re-export shims; both Dockerfiles build from root context and copy `config/`
- Header allowlist: orchestrator forwards only `FORWARD_HEADERS` (default content-type, accept, user-agent, warehouse, x-routing-key, x-scale-routing-key, x-request-id) into queue payloads; Authorization/cookies never reach RabbitMQ
- Observability hub = logging-service: orchestrator publishes fire-and-forget `{type:"audit"}` events (toggle `AUDIT_LOG_ENABLED`) to `logging` key; logging-service serves JSON metrics on :9100/metrics (`METRICS_ENABLED`) and polls queue depths via `checkQueue` every 15s warning above `QUEUE_DEPTH_WARN_THRESHOLD` (`QUEUE_MONITOR_ENABLED`). All log lines structured JSON with correlationId (also in worker logs + queue payloads)
- AMQP resilience: all 3 services attach `conn.on("close")` → `scheduleReconnect()` (guarded by timer flag, `RABBITMQ_RECONNECT_DELAY_MS`, default 5s). Orchestrator starts HTTP before broker connect, fails pending replies fast (503) on connection loss
- Auth: `orchestrator/src/auth.js` validates Bearer JWT (exp + appid/azp vs `AUTH_APP_ID` env, comma-separated; unset = disabled; `/health` always open; signature NOT verified yet). `Authorization` header is stripped before forwarding to RabbitMQ
- Worker body: `{ "query": "<name>", "params": {} }` — queries in `worker-service/src/queries.js`
- Throughput: worker prefetch 20, logging prefetch 20 (`LOGGING_PREFETCH`), orchestrator reply prefetch 50, DB pool max 20
- SQL config: `.env` + `config/database.js` (DB_SERVER, DB_PORT, DB_NAME, credentials)
