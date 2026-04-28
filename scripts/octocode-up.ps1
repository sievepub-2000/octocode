<#
.SYNOPSIS
    One-key launcher for the Octocode WebUI on Windows.

.DESCRIPTION
    Performs a complete startup:
      1. Stops any previous octocode-cli / msedge debug processes that
         could collide on the same port or browser profile.
      2. Builds the workspace if the binary is missing or stale.
      3. Frees the requested TCP port.
      4. Starts the WebUI server in a detached job, waits for the
         /api/state endpoint to respond, and prints the URL.

.PARAMETER Port
    Port for the WebUI (990-999). Defaults to 999.

.PARAMETER SessionId
    Session identifier passed to `octocode-cli serve`. Defaults to "main".

.PARAMETER NoBuild
    Skip the cargo build step (assumes the binary is already current).

.PARAMETER Provider
    Optional provider id to write into config before starting (e.g.
    nvidia-free). Useful for "Plan B" switches without editing config.

.PARAMETER OpenBrowser
    Launch the system default browser at the WebUI URL after readiness.

.EXAMPLE
    .\scripts\octocode-up.ps1 -Port 999 -SessionId main -OpenBrowser

.EXAMPLE
    .\scripts\octocode-up.ps1 -Provider nvidia-free
#>
param(
    [int]$Port = 999,
    [string]$SessionId = 'main',
    [switch]$NoBuild,
    [string]$Provider = '',
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

if ($Port -lt 990 -or $Port -gt 999) {
    throw "Port must be between 990 and 999. Received: $Port"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    # 1) Pre-flight: stop colliding processes.
    Write-Host '[octocode-up] stopping any previous octocode-cli/msedge debug instances...'
    Get-Process octocode-cli -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match 'remote-debugging-port'
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    # 2) Free the requested TCP port.
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $owners = $listener | Select-Object -ExpandProperty OwningProcess -Unique
        Write-Host ("[octocode-up] port $Port held by pids: " + ($owners -join ',') + ' — terminating')
        foreach ($pidValue in $owners) {
            try { Stop-Process -Id $pidValue -Force -ErrorAction Stop } catch {}
        }
        Start-Sleep -Milliseconds 500
    }

    # 3) Configure cargo home for this project.
    $env:CARGO_HOME = Join-Path (Split-Path -Parent $repoRoot) '.cargo'
    $cargoBin = Join-Path $env:CARGO_HOME 'bin'
    if (Test-Path $cargoBin) {
        $env:PATH = "$cargoBin;$env:PATH"
    }

    # 4) Build if requested.
    if (-not $NoBuild) {
        Write-Host '[octocode-up] cargo build -p octocode-cli (release of changed sources)...'
        cargo build -p octocode-cli | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }
    }

    # 5) Optional Plan-B provider switch via filesystem config.
    if ($Provider) {
        $configHome = Join-Path $env:APPDATA 'octocode'
        $configPath = Join-Path $configHome 'config.json'
        if (Test-Path $configPath) {
            $cfg = Get-Content -Raw $configPath | ConvertFrom-Json
            $cfg | Add-Member -Force -NotePropertyName 'providerId' -NotePropertyValue $Provider
            ($cfg | ConvertTo-Json -Depth 8) | Set-Content -NoNewline -Encoding UTF8 $configPath
            Write-Host "[octocode-up] config providerId set to '$Provider'"
        }
        else {
            Write-Host "[octocode-up] config not found at $configPath — provider override skipped"
        }
    }

    # 6) Start the server detached.
    $logDir = Join-Path $repoRoot 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $logPath = Join-Path $logDir ("webui-{0}.log" -f $Port)
    Write-Host "[octocode-up] launching octocode-cli serve $Port $SessionId (log: $logPath)"
    $proc = Start-Process -FilePath 'cargo' `
        -ArgumentList @('run','-p','octocode-cli','--','serve',"$Port",$SessionId) `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError "$logPath.err" `
        -PassThru -WindowStyle Hidden

    # 7) Wait for readiness on /api/state.
    $url = "http://127.0.0.1:$Port/api/state"
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        }
        catch {
            Start-Sleep -Milliseconds 800
        }
    }
    if (-not $ready) {
        throw "WebUI did not become ready within 60s. See $logPath / $logPath.err"
    }

    $webUrl = "http://127.0.0.1:$Port/ui-shell/?session=$SessionId"
    Write-Host "[octocode-up] READY pid=$($proc.Id) url=$webUrl"
    if ($OpenBrowser) { Start-Process $webUrl | Out-Null }

    # Persist the spawned pid for octocode-down.ps1 to consume.
    Set-Content -NoNewline -Path (Join-Path $logDir "webui-$Port.pid") -Value $proc.Id
    Write-Host "[octocode-up] pid file: $logDir\webui-$Port.pid"
}
finally {
    Pop-Location
}
