param([string]$AppRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$ErrorActionPreference = "Stop"
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
$distro = Get-ChildItem Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss -ErrorAction SilentlyContinue |
	Get-ItemProperty | Where-Object { $_.DistributionName -eq "OctoCode" } | Select-Object -First 1
$basePath = if ($distro) { [string]$distro.BasePath } else { '' }
if ($basePath.StartsWith('\\?\')) { $basePath = $basePath.Substring(4) }
$environments = Join-Path $AppRoot 'environments'
$environmentDirectory = Get-Item -LiteralPath $environments -Force -ErrorAction SilentlyContinue
if ($environmentDirectory -and $environmentDirectory.LinkType -eq 'Junction') { $environments = [string]$environmentDirectory.Target[0] }
$expectedBasePath = [System.IO.Path]::GetFullPath((Join-Path $environments 'wsl\OctoCode')).TrimEnd('\')
if ($distro -and ([System.IO.Path]::GetFullPath($basePath)).TrimEnd('\').Equals($expectedBasePath, [StringComparison]::OrdinalIgnoreCase)) {
	# The registered VHD contains user files; unregistering would destroy them.
	wsl.exe --terminate OctoCode
	if ($LASTEXITCODE -ne 0) { throw "Unable to stop the OctoCode WSL environment" }
}
