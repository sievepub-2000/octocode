$ErrorActionPreference = "Stop"
$root = "D:\gpt-workspace\octocode\source\desktop-shell"
$nodeRoot = Join-Path $root ".build\environments\node"
$node = Join-Path $nodeRoot "node.exe"
$gulp = Join-Path $root "node_modules\gulp\bin\gulp.js"
$logs = Join-Path $root "work\verification"
. (Join-Path $PSScriptRoot 'build-log-policy.ps1')
$log = Join-Path $logs "vscode-win32-x64-system-setup-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).log"
$env:PATH = "$nodeRoot;$env:PATH"
$env:OCTOCODE_ISCC = "D:\Program Files\develop\Inno Setup 7\ISCC.exe"
if (-not (Test-Path -LiteralPath $env:OCTOCODE_ISCC)) { throw "Inno Setup 7 compiler missing" }
$productRoot = [IO.Path]::GetFullPath('D:\gpt-workspace\octocode\source\VSCode-win32-x64').TrimEnd('\')
$manifest = Join-Path (Split-Path $PSScriptRoot -Parent) 'updates\stable\latest.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Stable update manifest missing: $manifest" }
$stable = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVsixHash = $stable.sha256
foreach ($vsix in @((Join-Path $productRoot 'environments\installer\octocode.vsix'), (Join-Path $root '.build\environments\installer\octocode.vsix'))) {
	if ((Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash -ne $expectedVsixHash) { throw "Installer VSIX does not match stable manifest: $vsix" }
}
# The product stage installs the VSIX to verify its binaries. The native
# installer installs that same VSIX during initialization, so remove only the
# verified temporary copy before packaging the product tree.
$extensionDirectory = Join-Path $productRoot 'data\extensions'
$preinstalled = @(Get-ChildItem -LiteralPath $extensionDirectory -Directory -Filter 'octocode.octocode-*' -ErrorAction SilentlyContinue)
if ($preinstalled.Count -ne 1 -or $preinstalled[0].Name -cne "octocode.octocode-$($stable.version)") {
	throw "Expected one verified OctoCode extension $($stable.version) before installer packaging"
}
$temporaryExtension = $preinstalled[0]
$otherEntries = @(Get-ChildItem -LiteralPath $extensionDirectory -Force | Where-Object {
	$_.Name -ne $temporaryExtension.Name -and $_.Name -ne 'extensions.json'
})
if ($otherEntries.Count) { throw "Unexpected product extension entries: $($otherEntries.Name -join ', ')" }
$expectedPath = [IO.Path]::GetFullPath((Join-Path $extensionDirectory $temporaryExtension.Name))
if ($temporaryExtension.FullName -ine $expectedPath -or
	($temporaryExtension.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
	throw 'Temporary extension path is not a physical child of the product tree'
}
$coreBinaries = Join-Path (Split-Path $root -Parent) 'octocode-core\src\bin\win32-x64'
foreach ($binary in @('octocode-host.exe', 'octocode-harness.exe')) {
	$built = Join-Path $coreBinaries $binary
	$packaged = Join-Path $temporaryExtension.FullName "bin\win32-x64\$binary"
	if (!(Test-Path -LiteralPath $built) -or !(Test-Path -LiteralPath $packaged) -or
		(Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $packaged -Algorithm SHA256).Hash) {
		throw "Temporary extension binary does not match the fresh build: $binary"
	}
}
Remove-Item -LiteralPath $temporaryExtension.FullName -Recurse -Force
if (Test-Path -LiteralPath $temporaryExtension.FullName) { throw 'Temporary extension removal failed' }
[IO.File]::WriteAllText((Join-Path $extensionDirectory 'extensions.json'), '[]', [Text.UTF8Encoding]::new($false))
$settingsPath = Join-Path $productRoot 'data\user-data\User\settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
	Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else { [pscustomobject]@{} }
$settings | Add-Member -MemberType NoteProperty -Name 'octocode.update.manifestUrl' -Value ([Uri]$manifest).AbsoluteUri -Force
$settings | Add-Member -MemberType NoteProperty -Name 'octocode.update.mode' -Value 'start' -Force
New-Item -ItemType Directory -Path (Split-Path $settingsPath -Parent) -Force | Out-Null
[IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
$runningProduct = @(Get-CimInstance Win32_Process | Where-Object {
	$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($productRoot + '\', [StringComparison]::OrdinalIgnoreCase)
})
if ($runningProduct) { throw "Product tree is running; stop it before packaging: $($runningProduct.ProcessId -join ', ')" }
# Installer-only builds must use the authoritative helpers, too.
foreach ($name in @('initialize', 'uninitialize', 'self-test', 'mcp-self-test')) {
	$source = Join-Path $root "build\win32\octocode-$name.ps1"
	$relative = if ($name -like '*self-test') { "test\$name.ps1" } else { "environments\scripts\$name.ps1" }
	foreach ($targetRoot in @((Join-Path $root '.build'), $productRoot)) {
		$target = Join-Path $targetRoot $relative
		Copy-Item -LiteralPath $source -Destination $target -Force
		if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "Packaged helper mismatch: $name" }
	}
}
$uninitialize = Get-Content (Join-Path $productRoot 'environments\scripts\uninitialize.ps1') -Raw
if ($uninitialize -match '--unregister' -or $uninitialize -notmatch '--terminate') { throw 'Unsafe WSL uninstall helper' }
$userData = Join-Path $productRoot 'data\user-data'
$forbiddenRuntimeState = @(
	'logs',
	'Backups',
	'User\History',
	'User\workspaceStorage',
	'User\globalStorage\octocode.octocode\octocode.db',
	'User\globalStorage\octocode.octocode\octocode.db.runtime-lock',
	'code.lock',
	'DevToolsActivePort'
)
$foundRuntimeState = @($forbiddenRuntimeState | Where-Object { Test-Path -LiteralPath (Join-Path $userData $_) })
if ($foundRuntimeState) { throw "Product tree contains runtime state; rebuild it before packaging: $($foundRuntimeState -join ', ')" }
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Location -LiteralPath $root
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
	& $node --experimental-strip-types --max-old-space-size=8192 $gulp "vscode-win32-x64-system-setup" *> $log
	$exitCode = $LASTEXITCODE
} finally {
	$ErrorActionPreference = $previousPreference
}
if ($exitCode -ne 0) {
	Get-Content -LiteralPath $log -Tail 200
	throw "Desktop installer build failed"
}
Assert-CleanBuildLog -Log $log
$outputDirectory = Join-Path $root ".build\win32-x64\system-setup"
$sidecar = Join-Path $outputDirectory 'product.json'
if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
$expectedInstaller = Join-Path $outputDirectory "OctoCodeSetup.exe"
$payload = @(Get-ChildItem $outputDirectory -File | Sort-Object Name)
if ($payload.Count -ne 1 -or -not $payload[0].FullName.Equals($expectedInstaller, [StringComparison]::OrdinalIgnoreCase)) {
	throw "Installer must be one complete EXE; found: $($payload.Name -join ', ')"
}
$installer = $payload[0]
[pscustomobject]@{
	log = $log
	installer = $installer.FullName
	totalBytes = ($payload | Measure-Object Length -Sum).Sum
	files = @($payload | ForEach-Object { [pscustomobject]@{ path = $_.FullName; length = $_.Length; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } })
}
