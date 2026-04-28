<#
.SYNOPSIS
    One-key shutdown for the Octocode WebUI on Windows.

.DESCRIPTION
    Performs a complete teardown:
      1. If a pid file exists for the requested port, kills that pid first.
      2. Kills any remaining octocode-cli processes.
      3. Frees the TCP port if anything still listens.
      4. Stops headless msedge debug sessions started for verification.
      5. Cleans the per-port pid file.

.PARAMETER Port
    Port to release (990-999). Defaults to 999. Pass 0 to skip port-based
    cleanup and just stop every octocode-cli process on the machine.

.PARAMETER All
    Stop all octocode-cli processes regardless of port.

.EXAMPLE
    .\scripts\octocode-down.ps1 -Port 999

.EXAMPLE
    .\scripts\octocode-down.ps1 -All
#>
param(
    [int]$Port = 999,
    [switch]$All
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot 'logs'

function Stop-PidSafely {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Host "[octocode-down] stopped pid=$ProcessId"
    }
    catch {
        # already gone, ignore
    }
}

# 1) Pid-file targeted shutdown.
if (-not $All -and $Port -gt 0) {
    $pidFile = Join-Path $logDir "webui-$Port.pid"
    if (Test-Path $pidFile) {
        $pidValue = (Get-Content $pidFile | Select-Object -First 1).Trim()
        if ($pidValue -match '^\d+$') {
            Stop-PidSafely -ProcessId ([int]$pidValue)
        }
        Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
    }
}

# 2) Stop every octocode-cli process (covers cargo-run children too).
Write-Host '[octocode-down] stopping octocode-cli processes...'
Get-Process octocode-cli -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-PidSafely -ProcessId $_.Id
}

# 3) Port cleanup.
if ($Port -gt 0) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $owners = $listener | Select-Object -ExpandProperty OwningProcess -Unique
        Write-Host ("[octocode-down] port $Port still held by pids: " + ($owners -join ','))
        foreach ($pidValue in $owners) { Stop-PidSafely -ProcessId $pidValue }
    }
}

# 4) Headless msedge cleanup (used for verification).
Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {
    try { ($_.CommandLine -match 'remote-debugging-port') } catch { $false }
} | ForEach-Object { Stop-PidSafely -ProcessId $_.Id }

# Fallback for hosts where CommandLine introspection is restricted.
Get-Process msedge -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        if ($_.MainWindowTitle -eq '' -and $_.StartTime -gt (Get-Date).AddHours(-2)) {
            Stop-PidSafely -ProcessId $_.Id
        }
    }
    catch {}
}

Write-Host '[octocode-down] done.'
