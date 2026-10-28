param([string]$AppRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = "Stop"
function Invoke-SelfTestCommand([string]$FilePath,[string]$Arguments,[ValidateRange(1,60000)][int]$TimeoutMilliseconds=30000) {
	$process=[Diagnostics.Process]::new()
	$process.StartInfo=[Diagnostics.ProcessStartInfo]::new()
	$process.StartInfo.FileName=$FilePath
	$process.StartInfo.Arguments=$Arguments
	$process.StartInfo.UseShellExecute=$false
	$process.StartInfo.CreateNoWindow=$true
	$process.StartInfo.RedirectStandardOutput=$true
	$process.StartInfo.RedirectStandardError=$true
	$started=$false
	$clock=[Diagnostics.Stopwatch]::StartNew()
	try {
		$started=$process.Start()
		$stdout=$process.StandardOutput.ReadToEndAsync()
		$stderr=$process.StandardError.ReadToEndAsync()
		if (!$process.WaitForExit($TimeoutMilliseconds)) { throw "$FilePath self-test timed out" }
		foreach($read in @($stdout,$stderr)) {
			$remaining=[Math]::Max(0,$TimeoutMilliseconds-[int]$clock.ElapsedMilliseconds)
			if (!$read.Wait($remaining)) { throw "$FilePath self-test output timed out" }
		}
		if ($process.ExitCode -ne 0) { throw "$FilePath self-test failed with exit code $($process.ExitCode): $($stderr.Result.Trim())" }
		return $stdout.Result.Trim()
	} finally {
		# Stop only the command process started here; never unregister/terminate a distro.
		if ($started -and !$process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }
		$process.Dispose()
	}
}
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
$environmentRoot = Join-Path $AppRoot "environments"
$testRoot = Join-Path $AppRoot "test"
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$env:CARGO_HOME = Join-Path $environmentRoot "rust\cargo"
$env:RUSTUP_HOME = Join-Path $environmentRoot "rust\rustup"
$env:ANDROID_HOME = Join-Path $environmentRoot "android"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = Join-Path $environmentRoot "android\user-home"
$env:ANDROID_SDK_HOME = $env:ANDROID_USER_HOME
$env:DOTNET_NOLOGO = 'true'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = 'true'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = 'true'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'

$checks = [ordered]@{
	node = @("node\node.exe", "--version")
	npm = @("node\npm.cmd", "--version")
	pnpm = @("node\pnpm.cmd", "--version")
	powershell = @("powershell\pwsh.exe", "--version")
	python = @("python\python.exe", "--version")
	uv = @("uv\uv.exe", "--version")
	rust = @("rust\cargo\bin\rustc.exe", "--version")
	go = @("go\bin\go.exe", "version")
	java = @("jdk\bin\java.exe", "--version")
	dotnet = @("dotnet\dotnet.exe", "--version")
	pandoc = @("pandoc\pandoc.exe", "--version")
	ffmpeg = @("ffmpeg\bin\ffmpeg.exe", "-version")
	protoc = @("protobuf\bin\protoc.exe", "--version")
	android = @("scripts\android.cmd", "--version")
	adb = @("scripts\adb.cmd", "--version")
	codeReviewGraph = @("python\python.exe", "-m", "code_review_graph", "--version")
	codeReviewGraphLauncher = @("python\Scripts\code-review-graph.exe", "--version")
}
$results = [ordered]@{}
# These toolchains are provisioned on first use; absence is an explicit untested state.
$onDemand = @{ powershell='powershell'; uv='uv'; rust='rust'; go='go'; java='jdk'; dotnet='dotnet'; pandoc='pandoc'; ffmpeg='ffmpeg'; protoc='protobuf'; android='android'; adb='android' }
$notProvisioned = [Collections.Generic.List[string]]::new()
foreach ($entry in $checks.GetEnumerator()) {
	$exe = Join-Path $environmentRoot $entry.Value[0]
	$detect = switch ($entry.Key) {
		'android' { Join-Path $environmentRoot 'android\cmdline-tools\latest\bin\sdkmanager.bat' }
		'adb' { Join-Path $environmentRoot 'android\platform-tools\adb.exe' }
		default { $exe }
	}
	if ($onDemand.ContainsKey($entry.Key) -and !(Test-Path -LiteralPath $detect -PathType Leaf)) {
		$notProvisioned.Add($entry.Key)
		continue
	}
	if (-not (Test-Path -LiteralPath $exe)) { throw "Missing runtime: $exe" }
	$previousErrorActionPreference = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	$output = & $exe @($entry.Value[1..($entry.Value.Count - 1)]) 2>&1
	$exitCode = $LASTEXITCODE
	$ErrorActionPreference = $previousErrorActionPreference
	if ($exitCode -ne 0) { throw "$($entry.Key) self-test failed" }
	$results[$entry.Key] = [string]($output | Select-Object -First 1)
}
if ($results.node -ne 'v26.12.1') { throw "Node 26.12.1 is required, found: $($results.node)" }
if ($results.npm -ne '12.2.1') { throw "npm 12.2.1 is required, found: $($results.npm)" }
if ($results.pnpm -ne '11.25.0') { throw "pnpm 11.25.0 is required, found: $($results.pnpm)" }
if ($results.python -ne 'Python 3.14.7') { throw "Python 3.14.7 is required, found: $($results.python)" }
if ($results.Contains('uv') -and $results.uv -notmatch '^uv 0\.12\.5(?:\s|$)') { throw "uv 0.12.5 is required, found: $($results.uv)" }
if ($results.Contains('rust') -and $results.rust -notmatch '^rustc 1\.98\.0(?:\s|$)') { throw "Rust 1.98.0 is required, found: $($results.rust)" }
if ($results.Contains('protoc') -and $results.protoc -ne 'libprotoc 36.2') { throw "protoc 36.2 is required, found: $($results.protoc)" }
& (Join-Path $environmentRoot 'python\python.exe') (Join-Path $environmentRoot 'scripts\test_runtime_python_security.py')
if ($LASTEXITCODE -ne 0) { throw 'Installed Python security regression failed' }
$results.pythonSecurity = 'PASS: pinned dependency versions and adversarial JWT/protobuf checks'
$toolchainRoot = Join-Path $environmentRoot 'rust\rustup\toolchains'
$toolchains = @(Get-ChildItem -LiteralPath $toolchainRoot -Directory -ErrorAction SilentlyContinue)
if ($results.Contains('rust') -and ($toolchains.Count -ne 1 -or $toolchains[0].Name -notmatch '^1\.98\.0-')) {
	throw "Expected one Rust 1.98.0 toolchain, found: $($toolchains.Name -join ', ')"
}
if ($results.Contains('rust')) { $results.rustToolchain = $toolchains[0].Name }
$legacyCodeGraph = Join-Path $environmentRoot 'scripts\cgc.cmd'
if (Test-Path -LiteralPath $legacyCodeGraph) { throw "Legacy Code Graph wrapper remains: $legacyCodeGraph" }
$androidCli = Join-Path $environmentRoot 'android\cmdline-tools\latest\bin\android.exe'
if ($results.Contains('android')) {
	if (-not (Test-Path -LiteralPath $androidCli)) { throw "Android CLI is missing: $androidCli" }
	$results.androidCli = (Get-Item -LiteralPath $androidCli).Length
}
$results.notProvisionedNotTested = @($notProvisioned)
$wikiPackage = Join-Path $environmentRoot 'tools\mcp\llmwiki\node_modules\@llmwiki\core\package.json'
if (-not (Test-Path -LiteralPath $wikiPackage)) { throw "LLM Wiki package is missing: $wikiPackage" }
$wikiRoot = Join-Path $AppRoot 'workspace\.wiki'
if (-not (Test-Path -LiteralPath $wikiRoot -PathType Container)) { throw "Default LLM Wiki is not initialized: $wikiRoot" }
$results.llmWiki = (Get-Content -LiteralPath $wikiPackage -Encoding UTF8 -Raw | ConvertFrom-Json).version
$mcpSettings = Join-Path $AppRoot 'environments\tools\mcp\mcp_settings.json'
$servers = @(((Get-Content -LiteralPath $mcpSettings -Encoding UTF8 -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties))
$remoteServers = @($servers | Where-Object {
	$_.Value.url -or -not $_.Value.command -or $_.Value.type -in @('sse', 'streamable-http')
})
$missingLocalMcps = @('code-review-graph', 'llm-wiki', 'scrapling') | Where-Object { $_ -notin $servers.Name }
if ($missingLocalMcps -or $remoteServers.Count) { throw 'Required local MCP configuration is missing or contains remote servers' }
$results.localMcps = @($servers.Name | Sort-Object)
$mcpSelfTest = Join-Path $testRoot 'mcp-self-test.ps1'
if (-not (Test-Path -LiteralPath $mcpSelfTest -PathType Leaf)) { throw "MCP self-test is missing: $mcpSelfTest" }
$results.mcpSmoke = @(& $mcpSelfTest -AppRoot $AppRoot -SettingsPath $mcpSettings)

$builtins = Join-Path $AppRoot 'resources\app\extensions'
# GitHub authentication is required by the signed private release updater.
$accountAdapters = @('github', 'microsoft-authentication') |
	Where-Object { Test-Path -LiteralPath (Join-Path $builtins $_) }
if ($accountAdapters) { throw "Account-backed adapters remain: $($accountAdapters -join ', ')" }

$productJson = Join-Path $AppRoot 'resources\app\product.json'
$configuredUpdateUrl = (Get-Content -LiteralPath $productJson -Encoding UTF8 -Raw | ConvertFrom-Json).updateUrl
if ($configuredUpdateUrl -and (-not ([Uri]$configuredUpdateUrl).IsAbsoluteUri -or ([Uri]$configuredUpdateUrl).Scheme -ne 'https')) { throw 'Update service must use an absolute HTTPS URL' }
$allowedEndpointHosts = @('github.com', 'open-vsx.org', 'vscode-cdn.net')
$endpointUrls = @([regex]::Matches((Get-Content -LiteralPath $productJson -Encoding UTF8 -Raw), 'https://[^"\s]+') | ForEach-Object Value | Sort-Object -Unique)
$blockedEndpoints = @($endpointUrls | Where-Object {
	if ($_ -eq $configuredUpdateUrl) { return $false }
	$endpointHost = ([Uri]($_ -replace '\{\{uuid\}\}', 'endpoint')).DnsSafeHost
	-not @($allowedEndpointHosts | Where-Object { $endpointHost -eq $_ -or $endpointHost.EndsWith(".$_", [StringComparison]::OrdinalIgnoreCase) }).Count
})
if ($blockedEndpoints) { throw "Blocked commercial/account endpoint: $($blockedEndpoints -join ', ')" }
$results.allowedEndpoints = $endpointUrls
$results.updateSource = $configuredUpdateUrl

$skillRoot = Join-Path $AppRoot 'environments\tools\skills'
$requiredSkills = @(
	'agent-introspection-debugging',
	'agent-reach',
	'brainstorming',
	'dispatching-parallel-agents',
	'executing-plans',
	'finishing-a-development-branch',
	'opensec-review',
	'ponytail',
	'ponytail-audit',
	'ponytail-debt',
	'ponytail-help',
	'ponytail-review',
	'ralph-wiggum',
	'receiving-code-review',
	'requesting-code-review',
	'sia-local-evaluation',
	'subagent-driven-development',
	'systematic-debugging',
	'test-driven-development',
	'using-git-worktrees',
	'using-superpowers',
	'verification-before-completion',
	'writing-plans',
	'writing-skills'
)
$missingSkills = @($requiredSkills | Where-Object { -not (Test-Path -LiteralPath (Join-Path $skillRoot $_)) })
if ($missingSkills) { throw "Missing local skills: $($missingSkills -join ', ')" }
$results.localSkills = $requiredSkills
# WSL is optional and provisioned on demand; report it only when present.
$distro = Get-ChildItem Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss -ErrorAction SilentlyContinue |
	Get-ItemProperty | Where-Object { $_.DistributionName -eq 'OctoCode' } | Select-Object -First 1
$results.wsl = if ($distro) { Invoke-SelfTestCommand -FilePath 'wsl.exe' -Arguments '-d OctoCode -- sh -lc "uname -sr"' } else { 'not provisioned (on demand)' }
$results.timestamp = [DateTimeOffset]::Now.ToString("o")
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot "last-self-test.json") -Encoding utf8
$results
