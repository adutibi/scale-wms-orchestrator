# Scripts

## DB connection test

Tests SQL Server connectivity from the host machine (before or alongside Docker).

**Prerequisites:** `npm install` at project root; copy `cp .env.example .env` and set SQL credentials.

```bash
node scripts/test-db-connection.js
```

Connection settings are read from `.env` via `config/database.js`.

## Capacity test

Sends requests to **logging** and **worker** services via the orchestrator and logs timing and completion. Worker requests use `{ "query": "ping" }`.

**Prerequisites:** Orchestrator and all services running (e.g. `docker compose up -d`).

**Run (default: 1000 requests per service, concurrency 100):**

```bash
node scripts/capacity-test.js
```

**Options:**

```bash
node scripts/capacity-test.js [baseUrl] [concurrency] [requestsPerService]
```

| Argument              | Default              | Description                          |
|-----------------------|---------------------|--------------------------------------|
| baseUrl               | http://localhost:3000 | Orchestrator base URL                |
| concurrency           | 100                 | Requests in flight per service       |
| requestsPerService    | 1000                | Number of requests per routing key   |

**Examples:**

```bash
node scripts/capacity-test.js
node scripts/capacity-test.js http://localhost:3000 20 300
node scripts/capacity-test.js http://localhost:3000 10 10
```

**Remote server example:**

```bash
node scripts/capacity-test.js http://192.168.1.50:3001 20 300
```

Replace `192.168.1.50` with the server's LAN IP. Use the published host port for the orchestrator (`3001` in this workspace).

**Output:** Start/end timestamps per service, duration, success/error counts, requests per second, and a summary. Exits with code 1 if worker throughput is below 10 req/s.
