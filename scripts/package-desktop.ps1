param(
  [string]$Profile = "release",
  [string]$SessionId = "demo",
  [int]$Port = 999
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
Set-Location $repoRoot

$cargoArgs = @("build", "-p", "octocode-cli")
if ($Profile -eq "release") {
  $cargoArgs += "--release"
}

& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) {
  throw "cargo build failed with exit code $LASTEXITCODE"
}

$profileDir = if ($Profile -eq "release") { "release" } else { "debug" }
$bundleRoot = Join-Path $repoRoot "out/desktop/octocode-windows-x64"
$appRoot = Join-Path $bundleRoot "app"

if (Test-Path $bundleRoot) {
  Remove-Item $bundleRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item (Join-Path $repoRoot "target/$profileDir/octocode-cli.exe") (Join-Path $appRoot "octocode-cli.exe") -Force
Copy-Item (Join-Path $repoRoot "ui-shell") (Join-Path $appRoot "ui-shell") -Recurse -Force
Copy-Item (Join-Path $repoRoot "README.md") (Join-Path $appRoot "README.md") -Force

$launcher = @"
@echo off
setlocal
cd /d "%~dp0app"
octocode-cli.exe desktop $Port $SessionId
"@
Set-Content -Path (Join-Path $bundleRoot "start-octocode-desktop.cmd") -Value $launcher -Encoding ASCII

$manifest = @{
  profile = $Profile
  sessionId = $SessionId
  port = $Port
  generatedAt = (Get-Date).ToString("s")
} | ConvertTo-Json
Set-Content -Path (Join-Path $bundleRoot "bundle-manifest.json") -Value $manifest -Encoding ASCII

Write-Host "Desktop bundle ready: $bundleRoot"