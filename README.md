# Scale WMS – Microservices Orchestrator

Orchestrator API that receives requests from the warehouse management system (Scale) and routes them to microservices via **RabbitMQ**. Routing is driven by **HTTP headers** (`X-Routing-Key`). Request–reply is supported so the WMS gets responses back from microservices.

## Services

| Service | Routing key | Purpose |
|---------|-------------|---------|
| Logging | `logging` | Logs incoming requests |
| Worker | `worker` | Executes named SQL queries against SQL Server (`ils` DB) |

## Quick start (Docker)

```bash
docker compose up -d --build
```

- **Orchestrator:** http://localhost:3001  
- **RabbitMQ Management:** http://localhost:15672 (user: `scale`, pass: `scale_secret`)

## Windows CLI startup

If you want Windows to start the stack automatically without Docker Desktop, use the PowerShell scripts in [scripts/windows](scripts/windows).

Install the startup task from an elevated PowerShell window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-startup-task.ps1
```

That task runs at Windows startup, starts the Docker service if one is available, waits for the Docker daemon, and then starts the project with 10 worker containers.

To start it now, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\start-project.ps1
```

To remove the startup task later:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-startup-task.ps1 -Remove
```

See **docs/DOCKER-INSTALL.md** for installing Docker on macOS.

## SQL Server prerequisite

The worker connects to `APTUSVALENTIN\SQL2022DEV` (database `ils`). Before starting:

1. Enable **TCP/IP** for the `SQL2022DEV` instance (SQL Server Configuration Manager).
2. Set a **static TCP port** (recommended) or start **SQL Server Browser** (UDP 1434).
3. Allow the TCP port (and UDP 1434 if using Browser) through **Windows Firewall**.

Configure SQL Server connection (copy template and edit):

```bash
cp .env.example .env
```

Test connectivity from your Mac:

```bash
npm install
node scripts/test-db-connection.js
```

## Scale-compatible Shipment Headers API

Drop-in replacement for the Scale integration GET endpoint (no routing header required):

```bash
curl "http://localhost:3001/ilsintegrationservices/scaleapi/ShipmentHeadersApi/Get?shipmentId=DIRE1&warehouse=MN"
```

Returns a JSON **array** of shipment objects with **PascalCase** property names, matching the real Scale API response shape.

## Bearer token validation

When `AUTH_APP_ID` is set (in `.env`), every request except `/health` must carry a JWT:

```bash
curl "http://localhost:3001/ilsintegrationservices/scaleapi/ShipmentHeadersApi/Get?shipmentId=DIRE1&warehouse=MN" \
  -H "Authorization: Bearer <token>"
```

The orchestrator checks that the token is **not expired** (`exp` claim, 30s clock skew). Failures return `401` (missing/malformed/expired token). Leave `AUTH_APP_ID` unset to disable validation (local dev).

> The token signature is **not** verified against Azure AD JWKS keys yet — this blocks expired and wrong-app tokens, not hand-forged ones. Add JWKS verification before exposing beyond a trusted network.

The `Authorization` header is stripped before the request is forwarded to RabbitMQ, so tokens never reach the queue or the logging service.

## Worker API contract (internal / load tests)

Send requests to the orchestrator with `X-Routing-Key: worker` and a JSON body:

```json
{ "query": "ping", "params": {} }
```

Built-in queries: `ping`, `db-info`, `list-tables`, `ShipmentHeader.by.ShipmentId.and.Warehouse`. Add more in `worker-service/src/queries.js`.

**Example:**

```bash
curl -X POST http://localhost:3001/query \
  -H "X-Routing-Key: worker" \
  -H "Content-Type: application/json" \
  -d '{"query":"ping"}'
```

## Scaling: multiple instances

To handle higher load, run **multiple instances** of a microservice. Each instance consumes from the same queue; RabbitMQ distributes messages across them.

```bash
# Scale logging to 3 instances, worker to 2
docker compose up -d --scale logging-service=3 --scale worker-service=2

# Reset to one instance per service
docker compose up -d --scale logging-service=1 --scale worker-service=1
```

**Note:** Do not scale `rabbitmq` or `orchestrator` unless you have a specific multi-instance setup. Scaling is for logging and worker services.

The worker is tuned for **≥10 req/s** (prefetch 20, connection pool 20). Use `--scale worker-service=N` for more headroom.

## Capacity test script

```bash
node scripts/capacity-test.js
```

**Options:**

```bash
node scripts/capacity-test.js [baseUrl] [concurrency] [requestsPerService]
```

| Argument             | Default                | Description                    |
|----------------------|------------------------|--------------------------------|
| baseUrl              | http://localhost:3001  | Orchestrator base URL          |
| concurrency          | 100                    | Requests in flight per service |
| requestsPerService   | 1000                   | Requests per routing key       |

**Examples:**

```bash
node scripts/capacity-test.js
node scripts/capacity-test.js http://localhost:3001 20 300
node scripts/capacity-test.js http://localhost:3001 10 10
```

## Routing (headers)

Set the routing key in an HTTP header. The orchestrator checks (in order): `x-routing-key`, `X-Routing-Key`, `x-scale-routing-key`.

| Routing key  | Microservice      |
|--------------|-------------------|
| `logging`    | Logging service   |
| `worker`     | SQL worker        |

**Quick test:**

```bash
curl http://localhost:3001/health

curl -X POST http://localhost:3001/any/path \
  -H "X-Routing-Key: logging" \
  -H "Content-Type: application/json" \
  -d '{"event":"test"}'
```

## Configuration

**SQL Server** — single source of truth in [`.env`](.env) (copy from [`.env.example`](.env.example)), loaded by [config/database.js](config/database.js):

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_SERVER` | `Wms-sql1` | SQL Server host (use LAN IP for Docker) |
| `DB_PORT` | `1433` | TCP port (preferred over instance name) |
| `DB_INSTANCE` | — | Named instance if not using `DB_PORT` |
| `DB_NAME` | `ils` | Database name |
| `DB_USER` / `DB_PASSWORD` | — | Login credentials |
| `DB_POOL_MAX` | `30` | Connection pool size per worker |
| `WORKER_PREFETCH` | `50` | RabbitMQ prefetch per worker |
| `WORKER_REQUEST_LOG_ENABLED` | `false` | Per-request worker logging (benchmark off) |
| `WORKER_TIMING_TRACE_ENABLED` | `false` | Adds query/worker timing info to worker replies |

Docker `worker-service` reads `.env` via `env_file`. Host scripts load the same file automatically.

| Component | Other env vars |
|-----------|----------------|
| Orchestrator | `RABBITMQ_URL`, `ORCHESTRATOR_PORT`, `ORCHESTRATOR_REPLY_PREFETCH`, `AUTH_APP_ID`, `AUTH_CLOCK_SKEW_S`, `RABBITMQ_RECONNECT_DELAY_MS`, `AUDIT_LOG_ENABLED`, `FORWARD_HEADERS` |
| Logging | `RABBITMQ_URL`, `LOGGING_PREFETCH` (default 20), `RABBITMQ_RECONNECT_DELAY_MS`, `METRICS_ENABLED`, `METRICS_PORT`, `QUEUE_MONITOR_ENABLED`, `QUEUE_DEPTH_WARN_THRESHOLD` |

All services automatically reconnect to RabbitMQ if the broker connection drops (default retry every 5s, override with `RABBITMQ_RECONNECT_DELAY_MS`). While disconnected, the orchestrator answers `503` and in-flight requests fail fast instead of hanging.

## Observability

The **logging-service is the observability hub**. All features are toggleable in `.env`:

| Toggle | Default | What it does |
|--------|---------|--------------|
| `AUDIT_LOG_ENABLED` | `true` | Orchestrator publishes a fire-and-forget audit event per request (correlationId, method, path, routing key, status, duration) to the logging service |
| `METRICS_ENABLED` | `true` | Logging service serves `GET :9100/metrics` — request counts by status/route, avg/max latency, queue depths |
| `QUEUE_MONITOR_ENABLED` | `true` | Logging service polls RabbitMQ queue depths every 15s and logs a warning above `QUEUE_DEPTH_WARN_THRESHOLD` (default 100) |

All log lines are structured JSON and include the `correlationId`, so a request can be traced across orchestrator → worker → audit log:

```bash
curl http://localhost:9100/metrics
```

## Shared route contracts

Scale API endpoints are defined once in [config/scaleRoutes.js](config/scaleRoutes.js) (name, method, path pattern, routing key) and consumed by **both** the orchestrator (auto-routing) and the worker (dispatch). To add a new API (e.g. `ShipmentDetailsApi`), add the route there plus a query + mapper + handler in the worker — no regex duplication.

The orchestrator forwards only an **allowlist of headers** into queue payloads (`content-type, accept, user-agent, warehouse, x-routing-key, x-scale-routing-key, x-request-id`; override with `FORWARD_HEADERS`). `Authorization`, cookies, and proxy headers never reach RabbitMQ or the logs.

## Documentation

- **docs/ARCHITECTURE.md** – Architecture design document, data flow, messaging topology.
- **docs/flow-diagram.md** – Mermaid flow diagrams (architecture, request–reply, scaling).
- **docs/DOCKER-INSTALL.md** – Install Docker Desktop and run the project.
- **scripts/README.md** – Capacity test and DB connection test usage.

## Project layout

```
.
├── .env.example
├── config/
│   └── database.js
├── docker-compose.yml
├── docs/
├── orchestrator/
├── logging-service/
├── worker-service/
└── scripts/
    ├── capacity-test.js
    ├── test-db-connection.js
    └── README.md
```


Build with 10 workers: docker compose up -d --build --scale worker-service=10