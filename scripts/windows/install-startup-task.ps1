[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$TaskName = "Scale-WMS-AutoStart",
  [int]$WorkerCount = 10
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$scriptPath = Join-Path $PSScriptRoot "start-project.ps1"
$powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -WorkerCount $WorkerCount"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "It will start the compose stack with $WorkerCount workers at Windows startup."