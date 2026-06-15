[CmdletBinding()]
param(
  [ValidateSet("http", "nats")]
  [string]$Transport = "http",
  [int]$WorkerCount = 5,
  [int]$OrchestratorPort = 3001,
  [int]$WorkerBasePort = 4001,
  [int]$LoggingPort = 4101,
  [string]$NatsUrl = "nats://localhost:4222"
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

Write-Host "=== Native mode (transport=$Transport) ==="
Write-Host "Project: $projectRoot"
Write-Host "Workers: $WorkerCount | Orchestrator: $OrchestratorPort"
Write-Host ""

Invoke-Quiet {
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker compose stop orchestrator worker-service logging-service rabbitmq nats 2>&1 | Out-Null
    if ($Transport -eq "nats") {
      Write-Host "Starting NATS broker (Docker profile nats)..."
      docker compose --profile nats up -d nats 2>&1 | Out-Host
      Start-Sleep -Seconds 2
    }
  } elseif ($Transport -eq "nats") {
    Write-Host "WARNING: docker not found - start NATS manually at $NatsUrl"
  }
}

Ensure-NpmInstall (Join-Path $projectRoot "orchestrator")
Ensure-NpmInstall (Join-Path $projectRoot "worker-service")
Ensure-NpmInstall (Join-Path $projectRoot "logging-service")

if (Test-Path (Join-Path $projectRoot ".env")) {
  Get-Content (Join-Path $projectRoot ".env") | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_ -split '=', 2
    if ($name) {
      $cleanValue = $value.Trim().Trim([char]34)
      Set-Item -Path "Env:$($name.Trim())" -Value $cleanValue
    }
  }
}

$env:TRANSPORT = $Transport
$env:ORCHESTRATOR_PORT = "$OrchestratorPort"
$env:NATS_URL = $NatsUrl

$logDir = Join-Path $projectRoot "logs\native"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$workerPids = @()

if ($Transport -eq "http") {
  $env:LOGGING_HTTP_PORT = "$LoggingPort"
}

Write-Host "Starting logging service..."
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
$workerUrls = @()
for ($i = 0; $i -lt $WorkerCount; $i++) {
  $port = $WorkerBasePort + $i
  if ($Transport -eq "http") {
    $workerUrls += "http://localhost:$port"
    $env:WORKER_HTTP_PORT = "$port"
  }
  $log = Join-Path $logDir "worker-$i.log"
  $errLog = Join-Path $logDir "worker-$i.err.log"
  $proc = Start-Process -FilePath "node" `
    -ArgumentList "src/index.js" `
    -WorkingDirectory (Join-Path $projectRoot "worker-service") `
    -RedirectStandardOutput $log `
    -RedirectStandardError $errLog `
    -PassThru -WindowStyle Hidden
  $workerPids += $proc
  if ($Transport -eq "http") {
    Write-Host "  worker http://localhost:$port pid=$($proc.Id)"
  } else {
    Write-Host "  worker nats queue member pid=$($proc.Id)"
  }
}

if ($Transport -eq "http") {
  $env:WORKER_URLS = ($workerUrls -join ",")
  $env:LOGGING_HTTP_URL = "http://localhost:$LoggingPort"
}

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
Write-Host "Stack running (transport=$Transport):"
Write-Host "  Orchestrator: http://localhost:$OrchestratorPort"
if ($Transport -eq "http") {
  Write-Host ("  Workers:      " + ($workerUrls -join ", "))
  Write-Host "  Logging:      http://localhost:$LoggingPort"
} else {
  Write-Host "  NATS:         $NatsUrl"
  Write-Host "  Workers:      $WorkerCount (queue group scale-workers)"
}
Write-Host "  Logs:         $logDir"
Write-Host ""
Write-Host "Load test:"
Write-Host "  node scripts/shipment-query-test.js http://localhost:$OrchestratorPort 1000 100"

@{
  transport = $Transport
  orchestrator = $orchProc.Id
  logging = $loggingProc.Id
  workers = @($workerPids.Id)
  workerUrls = $workerUrls
  natsUrl = $NatsUrl
} | ConvertTo-Json | Set-Content (Join-Path $logDir "pids.json")
