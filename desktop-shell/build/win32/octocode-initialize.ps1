param([string]$AppRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$ErrorActionPreference = "Stop"
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
if (-not (Test-Path -LiteralPath (Join-Path $AppRoot "OctoCode.exe"))) { throw "Invalid OctoCode root: $AppRoot" }

@("data", "data\tmp", "data\user-data", "data\extensions", "data\shared-data", "workspace", "test") |
	ForEach-Object { New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot $_) | Out-Null }

$workspaceMarker = [IO.File]::Open((Join-Path $AppRoot 'workspace\Program'), [IO.FileMode]::OpenOrCreate)
$workspaceMarker.Dispose()
$legacyMarker = Join-Path ([IO.Path]::GetPathRoot($AppRoot)) 'Program'
if (Test-Path -LiteralPath $legacyMarker -PathType Leaf) {
	$legacy = Get-Item -LiteralPath $legacyMarker -Force
	if ($legacy.Length -eq 0 -and -not ($legacy.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
		Remove-Item -LiteralPath $legacyMarker -Force
	}
}

# Custom builds can change NLS indices while retaining the upstream commit ID.
# Regenerate the derived language cache; never reuse an older index mapping.
$languageCache = [IO.Path]::GetFullPath((Join-Path $AppRoot 'data\user-data\clp'))
if (!$languageCache.StartsWith($AppRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid language cache path' }
if (Test-Path -LiteralPath $languageCache) {
	if ((Get-Item -LiteralPath $languageCache -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Language cache must not be a reparse point' }
	Remove-Item -LiteralPath $languageCache -Recurse -Force
}

$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($relative in @('', 'data', 'workspace', 'environments')) {
	$directory = if ($relative) { Join-Path $AppRoot $relative } else { $AppRoot }
	New-Item -ItemType Directory -Force -Path $directory | Out-Null
	$access = @('/inheritancelevel:r', '/remove:g', '*S-1-5-11', '*S-1-5-32-545',
		'/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*${userSid}:(OI)(CI)F")
	if (!$relative) { $access += @('/grant:r', '*S-1-5-32-545:(OI)(CI)RX') }
	icacls.exe $directory @access | Out-Null
	if ($LASTEXITCODE -ne 0) { throw "Unable to secure OctoCode directory: $directory" }
}

# The portable extension registry can outlive an upgrade. Register the VSIX
# against this installation so the desktop never loads an older or staging path.
$vsix = Join-Path $AppRoot 'environments\installer\octocode.vsix'
$cli = Join-Path $AppRoot 'bin\octocode.cmd'
if (-not (Test-Path -LiteralPath $vsix) -or -not (Test-Path -LiteralPath $cli)) {
	throw 'Bundled OctoCode extension installer is missing'
}
& $cli --install-extension $vsix --force
if ($LASTEXITCODE -ne 0) { throw "Unable to register OctoCode extension: $LASTEXITCODE" }
$catalog = Join-Path $AppRoot 'data\extensions\extensions.json'
$registered = @((Get-Content -LiteralPath $catalog -Raw -Encoding UTF8 | ConvertFrom-Json) |
	Where-Object { $_.identifier.id -eq 'octocode.octocode' })
if ($registered.Count -ne 1) { throw 'OctoCode extension registration is ambiguous' }
$extensionRoot = [IO.Path]::GetFullPath($registered[0].location.fsPath)
$extensionScope = [IO.Path]::GetFullPath((Join-Path $AppRoot 'data\extensions')).TrimEnd('\') + '\'
if (-not $extensionRoot.StartsWith($extensionScope, [StringComparison]::OrdinalIgnoreCase)) {
	throw "OctoCode extension escaped the installation: $extensionRoot"
}
$installedVersion = (Get-Content -LiteralPath (Join-Path $extensionRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($installedVersion -ne $registered[0].version) { throw 'OctoCode extension registry version mismatch' }

# The extension CLI updates its registry but leaves older version directories in
# portable storage. Remove only confirmed OctoCode package directories after the
# new version has been installed and registered successfully.
$node = Join-Path $AppRoot 'environments\node\node.exe'
foreach ($candidate in Get-ChildItem -LiteralPath ($extensionScope.TrimEnd('\')) -Directory -Filter 'octocode.octocode-*') {
	if ($candidate.FullName.Equals($extensionRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
	if ($candidate.Name -notmatch '^octocode\.octocode-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
		throw "Unexpected extension directory: $($candidate.FullName)"
	}
	if ($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) {
		throw "Obsolete extension must not be a reparse point: $($candidate.FullName)"
	}
	$package = Join-Path $candidate.FullName 'package.json'
	if (!(Test-Path -LiteralPath $package)) { throw "Obsolete extension has no manifest: $package" }
	$identity = (& $node -p "const p=require(process.argv[1]); p.publisher+'.'+p.name" $package 2>$null) -join ''
	if ($LASTEXITCODE -ne 0 -or $identity -ine 'OctoCode.octocode') {
		throw "Obsolete extension identity mismatch: $($candidate.FullName)"
	}
	$links = @(Get-ChildItem -LiteralPath $candidate.FullName -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
	if ($links.Count) { throw "Obsolete extension contains reparse points: $($candidate.FullName)" }
	Remove-Item -LiteralPath $candidate.FullName -Recurse -Force
}

# Windows console launchers embed an interpreter path; bind them to this installation.
$python = Join-Path $AppRoot 'environments\python\python.exe'
& $python (Join-Path $AppRoot 'environments\scripts\system_tools.py') --root $AppRoot --relocate-launchers
if ($LASTEXITCODE -ne 0) { throw 'System tools migration failed; existing sources were preserved' }

# WSL is provisioned on demand by the extension (Ubuntu 24.04 from Canonical), not here.

$log = Join-Path $AppRoot "data\user-data\logs\installer.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log -Parent) | Out-Null
"$([DateTimeOffset]::Now.ToString('o')) OctoCode environment initialized" | Add-Content -LiteralPath $log -Encoding utf8
