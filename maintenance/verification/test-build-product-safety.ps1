$ErrorActionPreference = 'Stop'
$source = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $source 'build-product-safety.ps1')
. (Join-Path $source 'build-log-policy.ps1')
$audit = 'E:\Program Files\octocode\test\build-product-safety-verification'
New-Item -ItemType Directory -Path $audit -Force | Out-Null
$owned = Join-Path $audit ('owned-build-safety-' + [guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($owned).StartsWith($audit + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped audit' }
$scope = Join-Path $owned 'scope [literal]'
$outside = Join-Path $owned 'outside'
$rows = [Collections.Generic.List[object]]::new()
$junctions = [Collections.Generic.List[string]]::new()
$ownedProcess = $null
function Expect-Rejected([string]$Name, [scriptblock]$Action) {
	$rejected = $false
	try { & $Action } catch { $rejected = $true }
	if (-not $rejected) { throw "Expected rejection: $Name" }
	$rows.Add([pscustomobject]@{name=$Name;passed=$true})
}
try {
	New-Item -ItemType Directory -Path $scope, $outside -Force | Out-Null
	$sentinel = Join-Path $outside 'preserved.txt'
	[IO.File]::WriteAllText($sentinel, 'owned-preserved-sentinel')
	$beforeHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
	$normal = Join-Path $scope 'normal'
	New-Item -ItemType Directory -Path (Join-Path $normal 'nested') -Force | Out-Null
	Assert-PhysicalBuildPath -Path $normal -ScopeDirectory $scope -InspectChildren
	$rows.Add([pscustomobject]@{name='physical-tree-and-literal-brackets';passed=$true})
	Expect-Rejected 'outside-scope' { Assert-PhysicalBuildPath -Path $outside -ScopeDirectory $scope }
	Expect-Rejected 'scope-itself' { Assert-PhysicalBuildPath -Path $scope -ScopeDirectory $scope }
	$leaf = Join-Path $scope 'leaf-link'
	New-Item -ItemType Junction -Path $leaf -Target $outside | Out-Null
	$junctions.Add($leaf)
	Expect-Rejected 'actual-leaf-junction' { Assert-PhysicalBuildPath -Path $leaf -ScopeDirectory $scope }
	$outsideChild = Join-Path $outside 'child'
	New-Item -ItemType Directory -Path $outsideChild | Out-Null
	Expect-Rejected 'actual-ancestor-junction' { Assert-PhysicalBuildPath -Path (Join-Path $leaf 'child') -ScopeDirectory $scope }
	$nestedLink = Join-Path $normal 'nested\outside-link'
	New-Item -ItemType Junction -Path $nestedLink -Target $outside | Out-Null
	$junctions.Add($nestedLink)
	Expect-Rejected 'actual-descendant-junction' { Assert-PhysicalBuildPath -Path $normal -ScopeDirectory $scope -InspectChildren }
	if ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Guard changed external sentinel' }
	$rows.Add([pscustomobject]@{name='external-sentinel-unchanged';passed=$true})
	$runningRoot = Join-Path $scope 'running-product'
	New-Item -ItemType Directory -Path $runningRoot | Out-Null
	$ownedExe = Join-Path $runningRoot 'owned-cmd.exe'
	Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $ownedExe
	$ownedProcess = Start-Process -FilePath $ownedExe -ArgumentList '/d /c ping -n 30 127.0.0.1 >nul' -WindowStyle Hidden -PassThru
	Start-Sleep -Milliseconds 300
	if ($ownedProcess.HasExited) { throw 'Owned executable exited before process guard test' }
	Expect-Rejected 'actual-running-executable-under-product' { Assert-StoppedBuildProduct -ProductRoot $runningRoot }
	Get-CimInstance Win32_Process -Filter "ParentProcessId=$($ownedProcess.Id)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	Stop-Process -Id $ownedProcess.Id -Force
	$ownedProcess = $null
	Assert-StoppedBuildProduct -ProductRoot $runningRoot
	$rows.Add([pscustomobject]@{name='stopped-product-accepted';passed=$true})
	$log = Join-Path $owned 'warning.log'
	[IO.File]::WriteAllText($log, 'warning: owned regression diagnostic')
	Expect-Rejected 'real-warning-policy-rejects-with-empty-allowlist' { Assert-CleanBuildLog -Log $log -Allowlist @() | Out-Null }
	[IO.File]::WriteAllText($log, 'Finished with 0 warnings')
	Assert-CleanBuildLog -Log $log
	$rows.Add([pscustomobject]@{name='allowed-zero-warning-summary';passed=$true})
	$probe = Join-Path $owned 'version-probe.cjs'
	$probeNode = Join-Path $owned 'node.exe'
	Copy-Item -LiteralPath (Join-Path $source 'desktop-shell\.build\environments\node\node.exe') -Destination $probeNode
	[IO.File]::WriteAllText($probe, 'process.stdout.write("0.1.8\n");process.exit(0)')
	$version = Invoke-BuildVersionProbe -FilePath $probeNode -Arguments @($probe) -Pattern '^0\.1\.\d+$' -Label 'Owned fixture'
	if ($version -cne '0.1.8') { throw 'Successful probe failed read-back' }
	$rows.Add([pscustomobject]@{name='actual-successful-version-probe';passed=$true})
	[IO.File]::WriteAllText($probe, 'process.stdout.write("0.1.8\n");process.exit(7)')
	Expect-Rejected 'matching-output-with-nonzero-exit-rejected' { Invoke-BuildVersionProbe -FilePath $probeNode -Arguments @($probe) -Pattern '^0\.1\.\d+$' -Label 'Owned fixture' }
	[IO.File]::WriteAllText($probe, 'process.exit(0)')
	Expect-Rejected 'empty-successful-probe-rejected' { Invoke-BuildVersionProbe -FilePath $probeNode -Arguments @($probe) -Pattern '^0\.1\.\d+$' -Label 'Owned fixture' }
	[IO.File]::WriteAllText($probe, 'process.stdout.write("unexpected\n");process.exit(0)')
	Expect-Rejected 'malformed-successful-probe-rejected' { Invoke-BuildVersionProbe -FilePath $probeNode -Arguments @($probe) -Pattern '^0\.1\.\d+$' -Label 'Owned fixture' }
	& {
		$desktop = Join-Path $scope 'cli-fixture'
		$cli = Join-Path $desktop 'cli\target\release\code.exe'
		New-Item -ItemType Directory -Path (Split-Path $cli -Parent) -Force | Out-Null
		[IO.File]::WriteAllText($cli, 'owned native CLI bytes')
		[IO.File]::WriteAllText((Join-Path $desktop 'package.json'), '{"version":"2.0.0"}')
		[IO.File]::WriteAllText((Join-Path $desktop 'product.json'), '{"nameShort":"OctoCode"}')
		$lock = Join-Path $desktop 'cli\Cargo.lock'
		[IO.File]::WriteAllText($lock, 'owned lock bytes')
		function Commit-OwnedFixture([string]$Repository, [string[]]$Files) {
			foreach ($name in @('GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE')) {
				if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw 'Clear Git directory/index overrides before isolated fixture tests' }
			}
			& git init -q $Repository
			if ($LASTEXITCODE -ne 0) { throw 'Owned Git fixture init failed' }
			& git -C $Repository config core.autocrlf false
			if ($LASTEXITCODE -ne 0) { throw 'Owned Git fixture line-ending configuration failed' }
			& git -C $Repository add -- @Files
			if ($LASTEXITCODE -ne 0) { throw 'Owned Git fixture add failed' }
			$tree = (& git -C $Repository write-tree) -join ''
			$commit = ('Owned fixture only' | & git -C $Repository -c user.name=Fixture -c user.email=fixture@example.invalid commit-tree $tree) -join ''
			if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Owned Git fixture commit failed' }
			[IO.File]::WriteAllText((Join-Path $Repository '.git\HEAD'), $commit + "`n")
		}
		[IO.File]::WriteAllText((Join-Path $desktop '.gitignore'), "/cli/target/`n")
		Commit-OwnedFixture $desktop @('.gitignore','package.json','product.json','cli/Cargo.lock')
		$cliTree = (& git -C $desktop rev-parse HEAD:cli) -join ''
		# Version execution itself is tested above with a real copied Node binary;
		# these receipt tests stub only the synthetic CLI's version subprocess.
		function Invoke-BuildVersionProbe { 'OctoCode 2.0.0 (commit ' + ('a' * 40) + ')' }
		$receipt = @{ sourceCommit = 'a' * 40; cliTree = $cliTree; version = '2.0.0'; cargoLockSha256 = (Get-FileHash -LiteralPath $lock).Hash; sha256 = (Get-FileHash -LiteralPath $cli).Hash; productJsonSha256 = (Get-FileHash -LiteralPath (Join-Path $desktop 'product.json')).Hash; productOverridesSha256 = $null }
		function Save-CliReceipt { $receipt | ConvertTo-Json | Set-Content -LiteralPath ($cli + '.build.json') -Encoding UTF8 }
		Expect-Rejected 'cli-missing-receipt' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		Save-CliReceipt
		$valid = Get-NativeCliBuildInput -DesktopRoot $desktop
		if ($valid.Path -ne $cli) { throw 'Verified CLI input path changed' }
		$rows.Add([pscustomobject]@{name='cli-current-tree-lock-version-hash-accepted';passed=$true})
		$receipt.productJsonSha256 = '0' * 64; Save-CliReceipt
		Expect-Rejected 'cli-stale-product-configuration' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		$receipt.productJsonSha256 = (Get-FileHash -LiteralPath (Join-Path $desktop 'product.json')).Hash; Save-CliReceipt
		[IO.File]::WriteAllText((Join-Path $desktop 'product.overrides.json'), '{}')
		Expect-Rejected 'cli-new-optional-product-override' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		Remove-Item -LiteralPath (Join-Path $desktop 'product.overrides.json')
		$receipt.cliTree = 'c' * 40; Save-CliReceipt
		Expect-Rejected 'cli-stale-source-tree' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		$receipt.cliTree = $cliTree; $receipt.version = '1.0.0'; Save-CliReceipt
		Expect-Rejected 'cli-stale-version' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		$receipt.version = '2.0.0'; $receipt.cargoLockSha256 = '0' * 64; Save-CliReceipt
		Expect-Rejected 'cli-stale-lock' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		$receipt.cargoLockSha256 = (Get-FileHash -LiteralPath $lock).Hash; $receipt.sha256 = '0' * 64; Save-CliReceipt
		Expect-Rejected 'cli-tampered-binary' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		$receipt.sha256 = (Get-FileHash -LiteralPath $cli).Hash; Save-CliReceipt
		[IO.File]::WriteAllText((Join-Path $desktop 'cli\uncommitted.rs'), 'owned uncommitted fixture')
		Expect-Rejected 'cli-uncommitted-source' { Get-NativeCliBuildInput -DesktopRoot $desktop }
		Remove-Item -LiteralPath (Join-Path $desktop 'cli\uncommitted.rs')
		$flat = Join-Path $scope 'flat-repository'
		$flatDesktop = Join-Path $flat 'desktop-shell'
		New-Item -ItemType Directory -Path (Join-Path $flatDesktop 'cli\target\release') -Force | Out-Null
		foreach ($name in @('.gitignore','package.json','product.json','cli\Cargo.lock','cli\target\release\code.exe','cli\target\release\code.exe.build.json')) {
			Copy-Item -LiteralPath (Join-Path $desktop $name) -Destination (Join-Path $flatDesktop $name)
		}
		Commit-OwnedFixture $flat @('desktop-shell/.gitignore','desktop-shell/package.json','desktop-shell/product.json','desktop-shell/cli/Cargo.lock')
		$flatInput = Get-NativeCliBuildInput -DesktopRoot $flatDesktop
		if ($flatInput.Sha256 -ne $receipt.sha256) { throw 'Flat Git tree input differed' }
		$rows.Add([pscustomobject]@{name='cli-real-flattened-and-nested-git-repositories';passed=$true})
		$product = Join-Path $scope 'cli-product'
		New-Item -ItemType Directory -Path $product | Out-Null
		Copy-NativeCliBuildInput -DesktopRoot $desktop -ProductRoot $product
		$packaged = Join-Path $product 'bin\octocode-tunnel.exe'
		if ((Get-FileHash -LiteralPath $packaged).Hash -ne $receipt.sha256) { throw 'Native CLI copy failed' }
		$rows.Add([pscustomobject]@{name='cli-copied-to-only-runtime-lookup-location';passed=$true})
		[IO.File]::WriteAllText($packaged, 'tampered packaged CLI')
		Expect-Rejected 'installer-cli-tamper' { Assert-InstallerBuildInputs -ProductRoot $product -DesktopRoot $desktop -CoreRoot $desktop -ManifestPath (Join-Path $scope 'absent.json') -ScopeDirectory $scope }
	}
	$legalDesktop = Join-Path $scope 'legal-desktop'
	$legalProduct = Join-Path $scope 'legal-product'
	New-Item -ItemType Directory -Path $legalDesktop, $legalProduct -Force | Out-Null
	[IO.File]::WriteAllText((Join-Path $legalDesktop 'package.json'), '{"devDependencies":{"electron":"43.8.3"}}')
	$legalPairs = @(
		@{ source='ThirdPartyNotices.txt'; payload='resources\app\ThirdPartyNotices.txt' },
		@{ source='node_modules\electron\dist\LICENSES.chromium.html'; payload='LICENSES.chromium.html' },
		@{ source='.build\environments\node\LICENSE'; payload='environments\node\LICENSE' }
	)
	foreach ($pair in $legalPairs) {
		foreach ($file in @((Join-Path $legalDesktop $pair.source), (Join-Path $legalProduct $pair.payload))) {
			New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
			[IO.File]::WriteAllText($file, 'owned current license bytes')
		}
	}
	$electronPackage = Join-Path $legalDesktop 'node_modules\electron\package.json'
	$electronVersion = Join-Path $legalDesktop 'node_modules\electron\dist\version'
	[IO.File]::WriteAllText($electronPackage, '{"version":"43.8.3"}')
	[IO.File]::WriteAllText($electronVersion, "43.8.3`n")
	Assert-InstallerLegalInputs -ProductRoot $legalProduct -DesktopRoot $legalDesktop
	$rows.Add([pscustomobject]@{name='current-electron-and-three-byte-identical-license-inputs';passed=$true})
	foreach ($pair in $legalPairs) {
		$payload = Join-Path $legalProduct $pair.payload
		[IO.File]::WriteAllText($payload, 'owned stale legal text')
		$message = $null
		try { Assert-InstallerLegalInputs -ProductRoot $legalProduct -DesktopRoot $legalDesktop } catch { $message = $_.Exception.Message }
		if ($message -notlike 'Installer license differs from current source:*') { throw "Stale legal payload was not rejected by the license guard: $($pair.payload)" }
		$rows.Add([pscustomobject]@{name=('stale-legal-payload-'+$pair.payload);passed=$true})
		[IO.File]::WriteAllText($payload, 'owned current license bytes')
	}
	foreach ($versionSource in @($electronPackage, $electronVersion)) {
		$value = [IO.File]::ReadAllText($versionSource)
		[IO.File]::WriteAllText($versionSource, $value.Replace('43.8.3', '42.11.12'))
		$message = $null
		try { Assert-InstallerLegalInputs -ProductRoot $legalProduct -DesktopRoot $legalDesktop } catch { $message = $_.Exception.Message }
		if ($message -cne 'Electron source version differs from the exact desktop package pin') { throw 'Old Electron source was not rejected by the version guard' }
		$rows.Add([pscustomobject]@{name=('stale-electron-version-'+[IO.Path]::GetFileName($versionSource));passed=$true})
		[IO.File]::WriteAllText($versionSource, $value)
	}
	foreach ($name in @('build-product-safety.ps1','build-desktop-installer.ps1','build-desktop-product.remote.ps1','build-log-policy.ps1','octocode-build.ps1','maintenance\build-native-cli.ps1')) {
		$parseErrors = $null; $tokens = $null
		$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $source $name), [ref]$tokens, [ref]$parseErrors)
		if ($parseErrors.Count) { throw "PowerShell parse failed: $name" }
		if ($name -eq 'build-desktop-installer.ps1') {
			$commands = $ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]}, $true)
			$stopGuard = @($commands | Where-Object { $_.GetCommandName() -in @('Assert-StoppedBuildProduct','Assert-InstallerBuildInputs') })[0]
			$mutations = @($commands | Where-Object { $_.GetCommandName() -in @('Remove-Item','Copy-Item','New-Item') })
			$firstWrite = $ast.Extent.Text.IndexOf('[IO.File]::WriteAllText')
			if (-not $stopGuard -or $mutations[0].Extent.StartOffset -le $stopGuard.Extent.StartOffset -or $firstWrite -le $stopGuard.Extent.StartOffset) { throw 'Installer guard occurs after mutation' }
		}
	}
	$rows.Add([pscustomobject]@{name='scripts-parse-and-installer-guard-precedes-mutation';passed=$true})
	$result = [ordered]@{powershell=$PSVersionTable.PSVersion.ToString();tests=$rows.Count;passed=$rows.Count;rows=@($rows);sourceHashes=@('build-product-safety.ps1','build-desktop-installer.ps1','build-desktop-product.remote.ps1','build-log-policy.ps1' | ForEach-Object { [pscustomobject]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $source $_) -Algorithm SHA256).Hash} });productionTouched=$false}
	$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $audit ('build-product-safety-ps'+$PSVersionTable.PSVersion.Major+'-r2.json')) -Encoding UTF8
	[pscustomobject]@{powershell=$result.powershell;tests=$result.tests;passed=$result.passed;productionTouched=$false} | ConvertTo-Json -Compress
} finally {
	if ($ownedProcess) {
		Get-CimInstance Win32_Process -Filter "ParentProcessId=$($ownedProcess.Id)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
		Stop-Process -Id $ownedProcess.Id -Force -ErrorAction SilentlyContinue
	}
	foreach ($junction in $junctions) {
		if (-not [IO.Path]::GetFullPath($junction).StartsWith($owned + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Junction cleanup escaped fixture' }
		if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction, $false) }
	}
	if (Test-Path -LiteralPath $owned) {
		Assert-PhysicalBuildPath -Path $owned -ScopeDirectory $audit -InspectChildren
		Remove-Item -LiteralPath $owned -Recurse -Force
	}
}
