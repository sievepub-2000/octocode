param(
    [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    python -m http.server $Port --directory .
}
finally {
    Pop-Location
}
