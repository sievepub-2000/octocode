function Get-NativeCliBuildInput {
	param([Parameter(Mandatory)][string]$DesktopRoot)
	if ($env:VSCODE_CLI_PRODUCT_JSON) { throw 'Custom CLI product overrides are not release inputs' }
	$binary = Join-Path $DesktopRoot 'cli\target\release\code.exe'
	$receiptPath = $binary + '.build.json'
	foreach ($file in @($binary, $receiptPath)) {
		if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Fresh native CLI build input missing: $file" }
		Assert-PhysicalBuildPath -Path $file -ScopeDirectory $DesktopRoot
	}
	$receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
	$prefix = (& git -C $DesktopRoot rev-parse --show-prefix) -join ''
	if ($LASTEXITCODE -ne 0 -or $prefix -notmatch '^([A-Za-z0-9._-]+/)*$') { throw 'Cannot identify native CLI repository path' }
	$cliTree = (& git -C $DesktopRoot rev-parse ('HEAD:' + $prefix + 'cli')) -join ''
	if ($LASTEXITCODE -ne 0 -or $cliTree -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify native CLI source tree' }
	$dirty = @(& git -C $DesktopRoot status --porcelain -- cli)
	if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw 'Native CLI source has uncommitted changes; commit it before packaging' }
	$version = (Get-Content -LiteralPath (Join-Path $DesktopRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
	$lockHash = (Get-FileHash -LiteralPath (Join-Path $DesktopRoot 'cli\Cargo.lock') -Algorithm SHA256).Hash
	$binaryHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
	$productHash = (Get-FileHash -LiteralPath (Join-Path $DesktopRoot 'product.json')).Hash
	$overrides = Join-Path $DesktopRoot 'product.overrides.json'
	$overrideHash = if (Test-Path -LiteralPath $overrides) { (Get-FileHash -LiteralPath $overrides).Hash } else { $null }
	if ($receipt.productJsonSha256 -ine $productHash -or $receipt.productOverridesSha256 -ine $overrideHash) {
		throw 'Native CLI product configuration changed; rebuild it'
	}
	if ($receipt.cliTree -cne $cliTree -or $receipt.sourceCommit -notmatch '^[a-f0-9]{40}$' -or $receipt.version -cne $version -or
		$receipt.cargoLockSha256 -ine $lockHash -or $receipt.sha256 -ine $binaryHash) {
		throw 'Native CLI build receipt differs from current source, Cargo.lock or executable; rebuild it'
	}
	$productName = (Get-Content -LiteralPath (Join-Path $DesktopRoot 'product.json') -Raw -Encoding UTF8 | ConvertFrom-Json).nameShort
	$expected = '{0} {1} (commit {2})' -f $productName, $version, $receipt.sourceCommit
	$reported = Invoke-BuildVersionProbe -FilePath $binary -Arguments @('--version') -Pattern ('^' + [regex]::Escape($expected) + '$') -Label 'Native CLI'
	[pscustomobject]@{ Path = $binary; Sha256 = $binaryHash; ReportedVersion = $reported }
}

function Copy-NativeCliBuildInput {
	param([Parameter(Mandatory)][string]$DesktopRoot, [Parameter(Mandatory)][string]$ProductRoot)
	$inputBinary = Get-NativeCliBuildInput -DesktopRoot $DesktopRoot
	Assert-StoppedBuildProduct -ProductRoot $ProductRoot
	Assert-PhysicalBuildPath -Path $ProductRoot -ScopeDirectory (Split-Path $DesktopRoot -Parent)
	$bin = Join-Path $ProductRoot 'bin'
	if (Test-Path -LiteralPath $bin) { Assert-PhysicalBuildPath -Path $bin -ScopeDirectory $ProductRoot -InspectChildren }
	New-Item -ItemType Directory -Force -Path $bin | Out-Null
	$destination = Join-Path $bin 'octocode-tunnel.exe'
	Copy-Item -LiteralPath $inputBinary.Path -Destination $destination -Force
	if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $inputBinary.Sha256) { throw 'Native CLI build copy differs from fresh input' }
}

function Copy-Harness2BuildInputs {
	param([Parameter(Mandatory)][string]$DesktopRoot, [Parameter(Mandatory)][string]$ProductRoot)
	$source = Join-Path $DesktopRoot 'build\environment-scripts'
	$target = Join-Path $ProductRoot 'environments\scripts'
	New-Item -ItemType Directory -Force -Path $target | Out-Null
	foreach ($name in @('octocode_api.py', 'octocode_harness2.py', 'octocode_credentials.py')) {
		Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target -Force
	}
	$vendor = Join-Path $source 'harness2_vendor'
	foreach ($file in Get-ChildItem -LiteralPath $vendor -Recurse -File) {
		if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Harness2 source cannot contain linked files' }
		if ($file.Extension -ne '.py' -and $file.Name -notin @('LICENSE', 'PROVENANCE.md', 'pyproject.toml')) { continue }
		$relative = $file.FullName.Substring($vendor.Length).TrimStart('\')
		$destination = Join-Path $target ('harness2_vendor\' + $relative)
		New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
		Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
		if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Harness2 build copy mismatch' }
	}
	$bin = Join-Path $ProductRoot 'bin'
	New-Item -ItemType Directory -Force -Path $bin | Out-Null
	Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'maintenance\octocode-harness2.cmd') -Destination $bin -Force
}

function Invoke-BuildVersionProbe {
	param(
		[Parameter(Mandatory)][string]$FilePath,
		[Parameter(Mandatory)][string[]]$Arguments,
		[Parameter(Mandatory)][string]$Pattern,
		[Parameter(Mandatory)][string]$Label
	)
	$output = & $FilePath @Arguments
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) { throw "$Label version probe failed (exit $exitCode)" }
	$value = (@($output) -join "`n").Trim()
	if ($value -notmatch $Pattern) { throw "Unexpected $Label version output" }
	$value
}

function Assert-PhysicalBuildPath {
	param(
		[Parameter(Mandatory)][string]$Path,
		[Parameter(Mandatory)][string]$ScopeDirectory,
		[switch]$InspectChildren
	)
	$resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
	$scope = [IO.Path]::GetFullPath($ScopeDirectory).TrimEnd('\')
	if (-not $resolved.StartsWith($scope + '\', [StringComparison]::OrdinalIgnoreCase)) {
		throw "Build path escaped source directory: $resolved"
	}
	$cursor = $resolved
	while ($cursor.Equals($scope, [StringComparison]::OrdinalIgnoreCase) -or
		$cursor.StartsWith($scope + '\', [StringComparison]::OrdinalIgnoreCase)) {
		if ((Get-Item -LiteralPath $cursor -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) {
			throw "Build path contains a reparse point: $cursor"
		}
		$cursor = [IO.Path]::GetDirectoryName($cursor)
	}
	if ($InspectChildren) {
		$pending = [Collections.Generic.Stack[string]]::new()
		$pending.Push($resolved)
		while ($pending.Count) {
			foreach ($entry in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
				if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
					throw "Build tree contains a reparse point: $($entry.FullName)"
				}
				if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
			}
		}
	}
}

function Assert-StoppedBuildProduct {
	param([Parameter(Mandatory)][string]$ProductRoot)
	$resolved = [IO.Path]::GetFullPath($ProductRoot).TrimEnd('\')
	$running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
		$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)
	})
	if ($running) { throw "Product tree is running; stop it before changing the build: $($running.ProcessId -join ', ')" }
}

function Assert-InstallerLegalInputs {
	param([Parameter(Mandatory)][string]$ProductRoot, [Parameter(Mandatory)][string]$DesktopRoot)
	$desktopPackage = Get-Content -LiteralPath (Join-Path $DesktopRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
	$electronRoot = Join-Path $DesktopRoot 'node_modules\electron'
	$electronPackage = Join-Path $electronRoot 'package.json'
	$electronVersionFile = Join-Path $electronRoot 'dist\version'
	foreach ($file in @($electronPackage, $electronVersionFile)) {
		if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Pinned Electron source metadata missing: $file" }
		Assert-PhysicalBuildPath -Path $file -ScopeDirectory $DesktopRoot
	}
	$pin = [string]$desktopPackage.devDependencies.electron
	$installed = [string](Get-Content -LiteralPath $electronPackage -Raw -Encoding UTF8 | ConvertFrom-Json).version
	$binaryVersion = (Get-Content -LiteralPath $electronVersionFile -Raw -Encoding UTF8).Trim()
	if ($pin -notmatch '^\d+\.\d+\.\d+$' -or $installed -cne $pin -or $binaryVersion -cne $pin) {
		throw 'Electron source version differs from the exact desktop package pin'
	}
	$licenses = @(
		@{ source = 'ThirdPartyNotices.txt'; payload = 'resources\app\ThirdPartyNotices.txt' },
		@{ source = 'node_modules\electron\dist\LICENSES.chromium.html'; payload = 'LICENSES.chromium.html' },
		@{ source = '.build\environments\node\LICENSE'; payload = 'environments\node\LICENSE' }
	)
	foreach ($license in $licenses) {
		$original = Join-Path $DesktopRoot $license.source
		$packaged = Join-Path $ProductRoot $license.payload
		foreach ($file in @($original, $packaged)) {
			if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installer license input missing: $file" }
		}
		Assert-PhysicalBuildPath -Path $original -ScopeDirectory $DesktopRoot
		Assert-PhysicalBuildPath -Path $packaged -ScopeDirectory $ProductRoot
		if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $packaged -Algorithm SHA256).Hash) {
			throw "Installer license differs from current source: $($license.payload)"
		}
	}
}

function Assert-InstallerBuildInputs {
	param(
		[Parameter(Mandatory)][string]$ProductRoot,
		[Parameter(Mandatory)][string]$DesktopRoot,
		[Parameter(Mandatory)][string]$CoreRoot,
		[Parameter(Mandatory)][string]$ManifestPath,
		[Parameter(Mandatory)][string]$ScopeDirectory
	)
	Assert-StoppedBuildProduct -ProductRoot $ProductRoot
	Assert-PhysicalBuildPath -Path $ProductRoot -ScopeDirectory $ScopeDirectory -InspectChildren
	$nativeCli = Get-NativeCliBuildInput -DesktopRoot $DesktopRoot
	$packagedCli = Join-Path $ProductRoot 'bin\octocode-tunnel.exe'
	if (-not (Test-Path -LiteralPath $packagedCli -PathType Leaf) -or
		(Get-FileHash -LiteralPath $packagedCli -Algorithm SHA256).Hash -ine $nativeCli.Sha256) {
		throw 'Installer native CLI missing or different from the fresh source build'
	}
	$integrityScript = Join-Path $PSScriptRoot 'maintenance\verification\check-packaged-native-integrity.mjs'
	& (Join-Path $DesktopRoot '.build\environments\node\node.exe') $integrityScript $ProductRoot
	if ($LASTEXITCODE -ne 0) { throw 'Packaged native ASAR integrity verification failed' }
	Assert-InstallerLegalInputs -ProductRoot $ProductRoot -DesktopRoot $DesktopRoot
	$scriptSource = Join-Path $DesktopRoot 'build\environment-scripts'
	$requiredScripts = @('octocode_api.py', 'octocode_credentials.py', 'octocode_harness2.py',
		'harness2_vendor\LICENSE', 'harness2_vendor\PROVENANCE.md', 'harness2_vendor\pyproject.toml',
		'harness2_vendor\harness2\core\recursion.py')
	foreach ($relative in $requiredScripts) {
		$source = Join-Path $scriptSource $relative
		$packaged = Join-Path $ProductRoot ('environments\scripts\' + $relative)
		if (!(Test-Path -LiteralPath $packaged -PathType Leaf) -or
			(Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $packaged).Hash) {
			throw "Installer script/license differs from reviewed source: $relative"
		}
	}
	$userData = Join-Path $ProductRoot 'data\user-data'
	$forbiddenRuntimeState = @(
		'logs', 'Backups', 'User\History', 'User\workspaceStorage',
		'User\globalStorage\octocode.octocode\octocode.db',
		'User\globalStorage\octocode.octocode\octocode.db.runtime-lock',
		'code.lock', 'DevToolsActivePort'
	)
	$foundRuntimeState = @($forbiddenRuntimeState | Where-Object { Test-Path -LiteralPath (Join-Path $userData $_) })
	if ($foundRuntimeState) { throw "Product tree contains runtime state; rebuild it before packaging: $($foundRuntimeState -join ', ')" }
	if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Release manifest missing: $ManifestPath" }
	$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
	$expectedVsixHash = $manifest.extensionVsixSha256
	if ($expectedVsixHash -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Release manifest VSIX hash missing or invalid' }
	$stagedVsix = Join-Path $ProductRoot 'environments\installer\octocode.vsix'
	foreach ($vsix in @($stagedVsix, (Join-Path $DesktopRoot '.build\environments\installer\octocode.vsix'))) {
		if ((Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash -ne $expectedVsixHash) { throw "Installer VSIX does not match release manifest: $vsix" }
	}
	$extensions = Join-Path $ProductRoot 'data\extensions'
	if (Test-Path -LiteralPath $extensions) {
		$unexpected = @(Get-ChildItem -LiteralPath $extensions -Force -ErrorAction Stop | Where-Object { $_.Name -ne 'extensions.json' })
		if ($unexpected.Count) { throw "Product stage contains installed extensions: $($unexpected.Name -join ', ')" }
		$index = Join-Path $extensions 'extensions.json'
		if (Test-Path -LiteralPath $index) {
			# Do not erase installed-extension records to make a dirty stage look clean.
			$content = Get-Content -LiteralPath $index -Raw -Encoding UTF8
			if ($content -notmatch '^\s*\[\s*\]\s*$') {
				$null = ConvertFrom-Json -InputObject $content -ErrorAction Stop
				throw 'Product stage extension index must be an empty JSON array'
			}
		}
	}
	Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
	$archive = [IO.Compression.ZipFile]::OpenRead($stagedVsix)
	try {
		foreach ($relative in @('bin/win32-x64/octocode-host.exe', 'bin/win32-x64/octocode-harness.exe', 'bin/win32-x64/code-graph.exe', 'dist/runtime/hostBroker.js')) {
			$built = Join-Path $CoreRoot "src/$relative"
			$entries = @($archive.Entries | Where-Object { $_.FullName -ieq "extension/$relative" })
			if (-not (Test-Path -LiteralPath $built -PathType Leaf) -or $entries.Count -ne 1) { throw "Fresh VSIX payload missing or ambiguous: $relative" }
			$stream = $entries[0].Open()
			$hasher = [Security.Cryptography.SHA256]::Create()
			try { $embeddedHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
			finally { $stream.Dispose(); $hasher.Dispose() }
			if ((Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash -ne $embeddedHash) { throw "VSIX payload does not match the fresh build: $relative" }
		}
	} finally { $archive.Dispose() }
}
