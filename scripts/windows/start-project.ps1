[CmdletBinding()]
param(
  [int]$WorkerCount = 10,
  [int]$DockerTimeoutSeconds = 180,
  [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"

function Get-DockerServiceName {
  foreach ($name in @("docker", "com.docker.service")) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($service) {
      return $service.Name
    }
  }

  return $null
}

function Ensure-DockerReady {
  $dockerCommand = Get-Command docker -ErrorAction Stop

  $serviceName = Get-DockerServiceName
  if ($serviceName) {
    try {
      Set-Service -Name $serviceName -StartupType Automatic -ErrorAction SilentlyContinue
    } catch {
      Write-Host "Could not set $serviceName to Automatic: $($_.Exception.Message)"
    }

    $service = Get-Service -Name $serviceName
    if ($service.Status -ne "Running") {
      Write-Host "Starting Docker service: $serviceName"
      Start-Service -Name $serviceName
    }
  }

  $deadline = (Get-Date).AddSeconds($DockerTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    & $dockerCommand.Source info *> $null
    if ($LASTEXITCODE -eq 0) {
      return
    }

    Start-Sleep -Seconds 2
  }

  throw "Docker daemon is not ready after $DockerTimeoutSeconds seconds."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $projectRoot

Ensure-DockerReady

Write-Host "Starting compose stack from $projectRoot with $WorkerCount worker containers..."
& docker compose -f $ComposeFile up -d --build --scale worker-service=$WorkerCount
exit $LASTEXITCODE