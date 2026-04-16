param(
  [string]$Profile = "release",
  [string]$SessionId = "demo",
  [int]$Port = 999
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
Set-Location $repoRoot

$cargoToml = Get-Content (Join-Path $repoRoot "Cargo.toml") -Raw
if ($cargoToml -notmatch 'version\s*=\s*"([^"]+)"') {
  throw "failed to resolve workspace version from Cargo.toml"
}
$version = $matches[1]
$bundleName = "octocode-v$version-windows-x64"
$bundleRoot = Join-Path $repoRoot "out/desktop/$bundleName"

& (Join-Path $scriptRoot "package-desktop.ps1") -Profile $Profile -SessionId $SessionId -Port $Port
if ($LASTEXITCODE -ne 0) {
  throw "desktop bundle generation failed with exit code $LASTEXITCODE"
}

$installRoot = Join-Path $repoRoot "out/installers/windows"
$zipPath = Join-Path $installRoot "Octocode-$version-windows-x64.zip"
$installerPath = Join-Path $installRoot "Octocode-$version-windows-x64-setup.exe"
$stageRoot = "C:\octocode-dist"
$sourceRoot = Join-Path $stageRoot "source"
$stageInstallerPath = Join-Path $stageRoot "Octocode-$version-windows-x64-setup.exe"

if (Test-Path $installRoot) {
  Remove-Item $installRoot -Recurse -Force
}
if (Test-Path $stageRoot) {
  Remove-Item $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null

Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $zipPath -Force

$installScript = @'
param(
  [string]$Zip,
  [string]$Version,
  [string]$Quiet = "0"
)

$target = Join-Path $env:LOCALAPPDATA "Programs/Octocode/$Version"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Expand-Archive -Path $Zip -DestinationPath $target -Force
$readme = Join-Path $target "START-HERE.txt"
if ($Quiet -ne "1") {
  Write-Host "Installed Octocode to $target"
  if (Test-Path $readme) {
    Write-Host "See $readme for startup instructions"
  }
}
'@
Set-Content -Path (Join-Path $sourceRoot "install.ps1") -Value $installScript -Encoding ASCII
Copy-Item $zipPath (Join-Path $sourceRoot (Split-Path $zipPath -Leaf)) -Force

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=Octocode $version has been installed under %LOCALAPPDATA%\Programs\Octocode\$version
TargetName=$stageInstallerPath
FriendlyName=Octocode $version Setup
AppLaunched=powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Zip "Octocode-$version-windows-x64.zip" -Version "$version"
PostInstallCmd=<None>
AdminQuietInstCmd=powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Zip "Octocode-$version-windows-x64.zip" -Version "$version" -Quiet 1
UserQuietInstCmd=powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Zip "Octocode-$version-windows-x64.zip" -Version "$version" -Quiet 1
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$sourceRoot\\
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0=install.ps1
FILE1=Octocode-$version-windows-x64.zip
"@
Set-Content -Path (Join-Path $installRoot "octocode-installer.sed") -Value $sed -Encoding ASCII

$iexpress = Start-Process -FilePath iexpress.exe -ArgumentList @("/N", (Join-Path $installRoot "octocode-installer.sed")) -Wait -PassThru
if ($iexpress.ExitCode -ne 0) {
  throw "IExpress failed with exit code $($iexpress.ExitCode)"
}

if (-not (Test-Path $stageInstallerPath)) {
  throw "IExpress did not produce installer at $stageInstallerPath"
}

Copy-Item $stageInstallerPath $installerPath -Force

Write-Host "Windows installer ready: $installerPath"