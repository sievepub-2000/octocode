$ErrorActionPreference = "Stop"
$root = "D:\gpt-workspace\octocode\source\desktop-shell"
$nodeRoot = Join-Path $root ".build\environments\node"
$node = Join-Path $nodeRoot "node.exe"
$gulp = Join-Path $root "node_modules\gulp\bin\gulp.js"
$logs = Join-Path $root "work\verification"
. (Join-Path $PSScriptRoot 'build-log-policy.ps1')
. (Join-Path $PSScriptRoot 'build-product-safety.ps1')
$log = Join-Path $logs "vscode-win32-x64-system-setup-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).log"
$env:PATH = "$nodeRoot;$env:PATH"
$env:OCTOCODE_ISCC = "D:\Program Files\develop\Inno Setup 7\ISCC.exe"
if (-not (Test-Path -LiteralPath $env:OCTOCODE_ISCC)) { throw "Inno Setup 7 compiler missing" }
$productRoot = [IO.Path]::GetFullPath('D:\gpt-workspace\octocode\source\VSCode-win32-x64').TrimEnd('\')
$manifest = Join-Path (Split-Path $PSScriptRoot -Parent) 'releases\release-manifest.json'
$coreRoot = Join-Path (Split-Path $root -Parent) 'octocode-core'
Assert-InstallerBuildInputs -ProductRoot $productRoot -DesktopRoot $root -CoreRoot $coreRoot -ManifestPath $manifest -ScopeDirectory $PSScriptRoot
Copy-Harness2BuildInputs -DesktopRoot $root -ProductRoot (Join-Path $root '.build')
Copy-Harness2BuildInputs -DesktopRoot $root -ProductRoot $productRoot
foreach ($targetRoot in @((Join-Path $root '.build'), $productRoot)) {
	& (Join-Path $root 'build\win32\octocode-validate-tools.ps1') -AppRoot $targetRoot
}
# A release stage must contain no installed extensions or interactive state.
$extensionDirectory = Join-Path $productRoot 'data\extensions'
New-Item -ItemType Directory -Path $extensionDirectory -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $extensionDirectory 'extensions.json'), '[]', [Text.UTF8Encoding]::new($false))
$settingsPath = Join-Path $productRoot 'data\user-data\User\settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
	Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else { [pscustomobject]@{} }
# Do not distribute a builder-local update URL to users.
$settings.PSObject.Properties.Remove('octocode.update.manifestUrl')
$settings | Add-Member -MemberType NoteProperty -Name 'octocode.update.mode' -Value 'manual' -Force
New-Item -ItemType Directory -Path (Split-Path $settingsPath -Parent) -Force | Out-Null
[IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
# Installer-only builds must use the authoritative helpers, too.
foreach ($name in @('initialize', 'uninitialize', 'self-test', 'mcp-self-test', 'octocode_api')) {
	$source = if ($name -eq 'octocode_api') { Join-Path $root 'build\environment-scripts\octocode_api.py' } else { Join-Path $root "build\win32\octocode-$name.ps1" }
	$relative = if ($name -eq 'octocode_api') { 'environments\scripts\octocode_api.py' } elseif ($name -like '*self-test') { "test\$name.ps1" } else { "environments\scripts\$name.ps1" }
	foreach ($targetRoot in @((Join-Path $root '.build'), $productRoot)) {
		$target = Join-Path $targetRoot $relative
		Copy-Item -LiteralPath $source -Destination $target -Force
		if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "Packaged helper mismatch: $name" }
	}
}
$uninitialize = Get-Content (Join-Path $productRoot 'environments\scripts\uninitialize.ps1') -Raw
foreach ($targetRoot in @((Join-Path $root '.build'), $productRoot)) {
	Copy-Item -LiteralPath (Join-Path $root 'build\environment-scripts\TOOLS.md') -Destination (Join-Path $targetRoot 'environments\TOOLS.md') -Force
}
foreach ($name in @('runtime-python-requirements.txt', 'test_runtime_python_security.py', 'system_tools.py', 'product_tools.py', 'mcp_defaults.json', 'scrapling_mcp.py')) {
    foreach ($targetRoot in @((Join-Path $root '.build'), $productRoot)) {
        Copy-Item -LiteralPath (Join-Path $root "build\environment-scripts\$name") -Destination (Join-Path $targetRoot "environments\scripts\$name") -Force
        if ((Get-FileHash -LiteralPath (Join-Path $root "build\environment-scripts\$name")).Hash -ne (Get-FileHash -LiteralPath (Join-Path $targetRoot "environments\scripts\$name")).Hash) { throw "Packaged helper mismatch: $name" }
    }
}
$graphWheel = Join-Path $coreRoot 'src\resources\python\code_review_graph-2.3.8+octocode.1-py3-none-any.whl'
if ((Get-FileHash -LiteralPath $graphWheel -Algorithm SHA256).Hash -ne 'BF9FCAC8B81FE7D6E123A4726EE1AAF610021DA9DDA7DCF4221ADC42AE06F6C5') { throw 'CodeGraph wheel verification failed.' }
foreach ($targetRoot in @((Join-Path $root '.build'), $productRoot)) {
	$python = Join-Path $targetRoot 'environments\python\python.exe'
	& $python -m pip install --force-reinstall --no-index --no-deps --no-warn-script-location $graphWheel
	if ($LASTEXITCODE -ne 0) { throw 'CodeGraph installer input update failed.' }
	& $python (Join-Path $targetRoot 'environments\scripts\system_tools.py') --root $targetRoot --build-bundle
	if ($LASTEXITCODE -ne 0) { throw 'Installer product programs consolidation failed.' }
}
& (Join-Path $productRoot 'environments\python\python.exe') (Join-Path $productRoot 'environments\scripts\test_runtime_python_security.py')
if ($LASTEXITCODE -ne 0) { throw 'Staged Python security regression failed' }
& (Join-Path $productRoot 'environments\python\python.exe') -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Staged Python dependency graph is inconsistent' }
if ($uninitialize -match '--unregister' -or $uninitialize -notmatch '--terminate') { throw 'Unsafe WSL uninstall helper' }
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
$payload = @(Get-ChildItem -LiteralPath $outputDirectory -File -Force | Sort-Object Name)
if ($payload.Count -ne 1 -or -not $payload[0].FullName.Equals($expectedInstaller, [StringComparison]::OrdinalIgnoreCase)) {
	throw "Installer must be one complete EXE; found: $($payload.Name -join ', ')"
}
$installer = $payload[0]
[pscustomobject]@{
	log = $log
	installer = $installer.FullName
	totalBytes = ($payload | Measure-Object Length -Sum).Sum
	files = @($payload | ForEach-Object { [pscustomobject]@{ path = $_.FullName; length = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
}
