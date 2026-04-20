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
    cargo run -p octocode-cli -- desktop $Port $SessionId
}
finally {
    Pop-Location
}
