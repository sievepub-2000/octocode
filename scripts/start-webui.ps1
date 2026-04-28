param(
    [int]$Port = 999,
    [string]$SessionId = "demo"
)

$ErrorActionPreference = 'Stop'

if ($Port -lt 990 -or $Port -gt 999) {
    throw "Port must be between 990 and 999. Received: $Port"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    Write-Host "Starting WebUI server on http://127.0.0.1:$Port/ui-shell/?session=$SessionId"
    cargo run -p octocode-cli -- serve $Port $SessionId
}
finally {
    Pop-Location
}
