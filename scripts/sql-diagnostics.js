#!/usr/bin/env node
/**
 * Snapshot SQL Server health during load tests.
 * Usage: node scripts/sql-diagnostics.js
 */
const sql = require("mssql");
const { buildMssqlConfig, formatConnectionTarget } = require("../config/database");

async function main() {
  const pool = await sql.connect(buildMssqlConfig());
  console.log(`Target: ${formatConnectionTarget()}\n`);

  const identity = await pool.request().query(`
    SELECT @@SERVERNAME AS serverName, DB_NAME() AS databaseName,
           (SELECT value_in_use FROM sys.configurations WHERE name = 'user connections') AS maxUserConnections
  `);
  console.log("=== Server ===");
  console.log(identity.recordset[0]);

  const connections = await pool.request().query(`
    SELECT
      COUNT(*) AS totalSessions,
      SUM(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS runningSessions,
      SUM(CASE WHEN s.status = 'sleeping' THEN 1 ELSE 0 END) AS sleepingSessions,
      SUM(CASE WHEN r.blocking_session_id > 0 THEN 1 ELSE 0 END) AS blockedRequests,
      SUM(CASE WHEN s.login_name = '${process.env.DB_USER || "Manh"}' THEN 1 ELSE 0 END) AS manhSessions
    FROM sys.dm_exec_sessions s
    LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
    WHERE s.is_user_process = 1
  `);
  console.log("\n=== Sessions (user processes) ===");
  console.log(connections.recordset[0]);

  const dbConns = await pool.request().query(`
    SELECT DB_NAME(database_id) AS dbName, COUNT(*) AS connections
    FROM sys.dm_exec_sessions
    WHERE is_user_process = 1 AND database_id IS NOT NULL
    GROUP BY database_id
    ORDER BY connections DESC
  `);
  console.log("\n=== Connections per database ===");
  console.table(dbConns.recordset);

  const waits = await pool.request().query(`
    SELECT TOP 10 wait_type, waiting_tasks_count, wait_time_ms,
           wait_time_ms / NULLIF(waiting_tasks_count, 0) AS avg_wait_ms
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT LIKE '%SLEEP%'
      AND wait_type NOT IN ('BROKER_TASK_STOP','BROKER_TO_FLUSH','CLR_AUTO_EVENT',
        'CLR_MANUAL_EVENT','DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION',
        'LAZYWRITER_SLEEP','LOGMGR_QUEUE','ONDEMAND_TASK_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH',
        'SLEEP_TASK','SLEEP_SYSTEMTASK','SP_SERVER_DIAGNOSTICS_SLEEP',
        'SQLTRACE_BUFFER_FLUSH','WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT')
    ORDER BY wait_time_ms DESC
  `);
  console.log("\n=== Top wait stats (cumulative since restart) ===");
  console.table(waits.recordset);

  const blocking = await pool.request().query(`
    SELECT TOP 10
      r.session_id, r.blocking_session_id, r.wait_type, r.wait_time,
      DB_NAME(r.database_id) AS dbName,
      SUBSTRING(t.text, (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text)
          ELSE r.statement_end_offset END - r.statement_start_offset)/2)+1) AS statementText
    FROM sys.dm_exec_requests r
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
    WHERE r.blocking_session_id > 0 OR r.wait_type LIKE 'LCK%'
    ORDER BY r.wait_time DESC
  `);
  console.log("\n=== Blocking / lock waits (right now) ===");
  if (blocking.recordset.length === 0) {
    console.log("(none)");
  } else {
    console.table(blocking.recordset);
  }

  const perf = await pool.request().query(`
    SELECT TOP 5
      qs.execution_count,
      qs.total_elapsed_time / 1000 AS total_elapsed_ms,
      (qs.total_elapsed_time / qs.execution_count) / 1000 AS avg_elapsed_ms,
      qs.total_worker_time / 1000 AS total_cpu_ms,
      qs.total_logical_reads,
      SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS queryText
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE st.text LIKE '%SHIPMENT_HEADER%'
    ORDER BY qs.total_elapsed_time DESC
  `);
  console.log("\n=== SHIPMENT_HEADER query stats (plan cache) ===");
  if (perf.recordset.length === 0) {
    console.log("(no cached plans yet)");
  } else {
    console.table(perf.recordset);
  }

  await pool.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
