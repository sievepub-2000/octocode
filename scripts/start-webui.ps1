param(
    [int]$Port = 999,
    [string]$SessionId = "demo"
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    cargo run -p octocode-cli -- desktop $Port $SessionId
}
finally {
    Pop-Location
}
