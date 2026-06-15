[CmdletBinding()]
param(
  [int]$WorkerCount = 5,
  [int]$OrchestratorPort = 3001,
  [int]$WorkerBasePort = 4001,
  [int]$LoggingPort = 4101
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $projectRoot

function Invoke-Quiet {
  param([scriptblock]$Cmd)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Cmd } finally { $ErrorActionPreference = $prev }
}

function Ensure-NpmInstall {
  param([string]$Dir)
  if (-not (Test-Path (Join-Path $Dir "node_modules"))) {
    Write-Host "npm install in $Dir ..."
    Push-Location $Dir
    Invoke-Quiet { npm install --omit=dev 2>&1 | Out-Host }
    Pop-Location
  }
}

Write-Host "=== HTTP native mode (no RabbitMQ, no Docker) ==="
Write-Host "Project: $projectRoot"
Write-Host "Workers: $WorkerCount | Orchestrator: $OrchestratorPort"
Write-Host ""

Invoke-Quiet {
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker compose stop orchestrator worker-service logging-service rabbitmq 2>&1 | Out-Null
  }
}

Ensure-NpmInstall (Join-Path $projectRoot "orchestrator")
Ensure-NpmInstall (Join-Path $projectRoot "worker-service")
Ensure-NpmInstall (Join-Path $projectRoot "logging-service")

if (Test-Path (Join-Path $projectRoot ".env")) {
  Get-Content (Join-Path $projectRoot ".env") | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_ -split '=', 2
    if ($name) { Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim('"') }
  }
}

$env:TRANSPORT = "http"
$env:ORCHESTRATOR_PORT = "$OrchestratorPort"
$env:LOGGING_HTTP_PORT = "$LoggingPort"

$logDir = Join-Path $projectRoot "logs\native"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$workerUrls = @()
$workerPids = @()

Write-Host "Starting logging service on port $LoggingPort..."
$loggingLog = Join-Path $logDir "logging.log"
$loggingErr = Join-Path $logDir "logging.err.log"
$loggingProc = Start-Process -FilePath "node" `
  -ArgumentList "src/index.js" `
  -WorkingDirectory (Join-Path $projectRoot "logging-service") `
  -RedirectStandardOutput $loggingLog `
  -RedirectStandardError $loggingErr `
  -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1

Write-Host "Starting $WorkerCount worker(s)..."
for ($i = 0; $i -lt $WorkerCount; $i++) {
  $port = $WorkerBasePort + $i
  $workerUrls += "http://localhost:$port"
  $env:WORKER_HTTP_PORT = "$port"
  $log = Join-Path $logDir "worker-$port.log"
  $errLog = Join-Path $logDir "worker-$port.err.log"
  $proc = Start-Process -FilePath "node" `
    -ArgumentList "src/index.js" `
    -WorkingDirectory (Join-Path $projectRoot "worker-service") `
    -RedirectStandardOutput $log `
    -RedirectStandardError $errLog `
    -PassThru -WindowStyle Hidden
  $workerPids += $proc
  Write-Host "  worker http://localhost:$port pid=$($proc.Id)"
}

$env:WORKER_URLS = ($workerUrls -join ",")
$env:LOGGING_HTTP_URL = "http://localhost:$LoggingPort"

Start-Sleep -Seconds 2

Write-Host "Starting orchestrator on port $OrchestratorPort..."
$orchLog = Join-Path $logDir "orchestrator.log"
$orchErr = Join-Path $logDir "orchestrator.err.log"
$orchProc = Start-Process -FilePath "node" `
  -ArgumentList "src/index.js" `
  -WorkingDirectory (Join-Path $projectRoot "orchestrator") `
  -RedirectStandardOutput $orchLog `
  -RedirectStandardError $orchErr `
  -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "HTTP stack running (no RabbitMQ):"
Write-Host "  Orchestrator: http://localhost:$OrchestratorPort"
Write-Host "  Workers:      $($workerUrls -join ', ')"
Write-Host "  Logging:      http://localhost:$LoggingPort"
Write-Host "  Logs:         $logDir"
Write-Host ""
Write-Host "Load test:"
Write-Host "  node scripts/shipment-query-test.js http://localhost:$OrchestratorPort 1000 100"

@{
  orchestrator = $orchProc.Id
  logging = $loggingProc.Id
  workers = @($workerPids.Id)
  workerUrls = $workerUrls
} | ConvertTo-Json | Set-Content (Join-Path $logDir "pids.json")
