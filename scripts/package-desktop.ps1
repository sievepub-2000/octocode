param(
  [string]$Profile = "release",
  [string]$SessionId = "demo",
  [int]$Port = 999
)

$ErrorActionPreference = "Stop"

if ($Port -lt 990 -or $Port -gt 999) {
  throw "Port must be between 990 and 999. Received: $Port"
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
Set-Location $repoRoot

$cargoToml = Get-Content (Join-Path $repoRoot "Cargo.toml") -Raw
if ($cargoToml -notmatch 'version\s*=\s*"([^"]+)"') {
  throw "failed to resolve workspace version from Cargo.toml"
}
$version = $matches[1]

$cargoArgs = @("build", "-p", "octocode-cli")
if ($Profile -eq "release") {
  $cargoArgs += "--release"
}

# T4 (release-hardening): cargo emits status lines to stderr; under
# PS5.1's strict ErrorActionPreference those would terminate the
# script even on success. Capture exit code explicitly and route
# stderr through stdout so non-zero exits are detected reliably.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & cargo @cargoArgs 2>&1 | ForEach-Object { "$_" } | Out-Host
  $cargoExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $savedEAP
}
if ($cargoExit -ne 0) {
  throw "cargo build failed with exit code $cargoExit"
}

$profileDir = if ($Profile -eq "release") { "release" } else { "debug" }
$bundleName = "octocode-v$version-windows-x64"
$bundleRoot = Join-Path $repoRoot "out/desktop/$bundleName"
$appRoot = Join-Path $bundleRoot "app"

if (Test-Path $bundleRoot) {
  Remove-Item $bundleRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item (Join-Path $repoRoot "target/$profileDir/octocode-cli.exe") (Join-Path $appRoot "octocode-cli.exe") -Force
Copy-Item (Join-Path $repoRoot "ui-shell") (Join-Path $appRoot "ui-shell") -Recurse -Force
Copy-Item (Join-Path $repoRoot "README.md") (Join-Path $appRoot "README.md") -Force

$startupDoc = @"
Octocode Desktop Bundle
Version: $version
Profile: $Profile

Start:
  1. Run start-octocode-desktop.cmd
  2. Or open app\\octocode-cli.exe and run: octocode-cli.exe desktop $Port $SessionId

Bundle layout:
  app\\octocode-cli.exe    Desktop and CLI entrypoint
  app\\ui-shell            Canvas workbench assets
  bundle-manifest.json     Build metadata
"@
Set-Content -Path (Join-Path $bundleRoot "START-HERE.txt") -Value $startupDoc -Encoding ASCII

$launcher = @"
@echo off
setlocal
cd /d "%~dp0app"
octocode-cli.exe desktop $Port $SessionId
"@
Set-Content -Path (Join-Path $bundleRoot "start-octocode-desktop.cmd") -Value $launcher -Encoding ASCII

$manifest = @{
  version = $version
  bundle = $bundleName
  profile = $Profile
  sessionId = $SessionId
  port = $Port
  generatedAt = (Get-Date).ToString("s")
} | ConvertTo-Json
Set-Content -Path (Join-Path $bundleRoot "bundle-manifest.json") -Value $manifest -Encoding ASCII

Write-Host "Desktop bundle ready: $bundleRoot"