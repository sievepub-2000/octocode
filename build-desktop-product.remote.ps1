$ErrorActionPreference = "Stop"
function Remove-BuildDirectory([string]$Directory) {
	$resolved = [IO.Path]::GetFullPath($Directory)
	$scope = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
	if (!$resolved.StartsWith($scope, [StringComparison]::OrdinalIgnoreCase)) { throw "Cleanup escaped source directory: $resolved" }
	if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup target is a junction: $resolved" }
	Remove-Item -LiteralPath $resolved -Recurse -Force
}
$root = "D:\gpt-workspace\octocode\source\desktop-shell"
$nodeRoot = Join-Path $root ".build\environments\node"
$node = Join-Path $nodeRoot "node.exe"
$core = Join-Path $PSScriptRoot 'octocode-core'
$extensionVersion = (& $node -p 'require(process.argv[1]).version' (Join-Path $core 'src\package.json')).Trim()
if ($extensionVersion -notmatch '^0\.1\.\d+$') { throw "Unexpected extension version: $extensionVersion" }
$gulp = Join-Path $root "node_modules\gulp\bin\gulp.js"
$logs = Join-Path $root "work\verification"
$env:PATH = "$nodeRoot;$env:PATH"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$staleBuiltins = @(
	(Join-Path $root "extensions\octocode"),
	(Join-Path $root ".build\extensions\OctoCode.octocode")
)
foreach ($staleBuiltin in $staleBuiltins) {
	if (Test-Path -LiteralPath $staleBuiltin) { Remove-BuildDirectory $staleBuiltin }
}
Set-Location -LiteralPath $root
$vsixSource = Join-Path $core "bin\octocode-$extensionVersion.vsix"
$vsix = Join-Path $root ".build\input\octocode-$extensionVersion.vsix"
if (-not (Test-Path -LiteralPath $vsixSource)) { throw "Fresh OctoCode VSIX missing: $vsixSource" }
New-Item -ItemType Directory -Force -Path (Split-Path $vsix -Parent) | Out-Null
Copy-Item -LiteralPath $vsixSource -Destination $vsix -Force
$speechSetup = 'D:\gpt-workspace\octocode\source\octocode-core\scripts\audio\prepare-funasr.ps1'
$environmentSource = Join-Path $root '.build\environments'
New-Item -ItemType Directory -Force -Path (Join-Path $environmentSource 'installer') | Out-Null
Copy-Item -LiteralPath $vsixSource -Destination (Join-Path $environmentSource 'installer\octocode.vsix') -Force
foreach ($script in @('initialize', 'uninitialize')) {
	Copy-Item -LiteralPath (Join-Path $root "build\win32\octocode-$script.ps1") -Destination (Join-Path $environmentSource "scripts\$script.ps1") -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $root '.build\test') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'build\win32\mcp-stdio-smoke.mjs') -Destination (Join-Path $root '.build\test\mcp-stdio-smoke.mjs') -Force
Copy-Item -LiteralPath (Join-Path $root 'build\win32\octocode-self-test.ps1') -Destination (Join-Path $root '.build\test\self-test.ps1') -Force
Copy-Item -LiteralPath (Join-Path $root 'build\win32\octocode-mcp-self-test.ps1') -Destination (Join-Path $root '.build\test\mcp-self-test.ps1') -Force
# The daemon (HTTP API, routines, goals) and the Scrapling MCP are versioned here;
# .build/ is ignored by git, so it only ever receives copies.
foreach ($script in @('octocode_api.py', 'scrapling_mcp.py', 'system_tools.py')) {
	Copy-Item -LiteralPath (Join-Path $root "build\environment-scripts\$script") -Destination (Join-Path $environmentSource "scripts\$script") -Force
}
Copy-Item -LiteralPath (Join-Path $root 'build\environment-scripts\TOOLS.md') -Destination (Join-Path $environmentSource 'TOOLS.md') -Force
foreach ($kind in @('skills', 'mcp', 'hooks')) {
	New-Item -ItemType Directory -Force -Path (Join-Path $environmentSource "tools\$kind") | Out-Null
}
if (!(Test-Path -LiteralPath (Join-Path $environmentSource 'funasr\llama-funasr-sensevoice.exe'))) {
	& $speechSetup -EnvironmentsRoot $environmentSource
}
& $speechSetup -EnvironmentsRoot $environmentSource -VerifyOnly
$python = Join-Path $environmentSource 'python\python.exe'
$graphWheel = 'D:\gpt-workspace\octocode\source\octocode-core\src\resources\python\code_review_graph-2.3.8+octocode.1-py3-none-any.whl'
if ((Get-FileHash -LiteralPath $graphWheel -Algorithm SHA256).Hash -ne 'BF9FCAC8B81FE7D6E123A4726EE1AAF610021DA9DDA7DCF4221ADC42AE06F6C5') { throw 'CodeGraph wheel verification failed.' }
$graphVersion = & $python -c "import importlib.metadata; print(importlib.metadata.version('code-review-graph'))"
if ($LASTEXITCODE -ne 0 -or $graphVersion -ne '2.3.8+octocode.1') {
	& $python -m pip install --no-index --no-deps --no-warn-script-location $graphWheel
	if ($LASTEXITCODE -ne 0) { throw 'CodeGraph build environment update failed.' }
}

& $python (Join-Path $environmentSource 'scripts\system_tools.py') --root (Join-Path $root '.build')
if ($LASTEXITCODE -ne 0) { throw 'Build system tools consolidation failed' }
$tsgo = Join-Path $root 'node_modules\@typescript\native\bin\tsc'
if (-not (Test-Path -LiteralPath $tsgo)) { throw "Desktop type checker missing: $tsgo" }
$typecheckLog = Join-Path $logs "tsgo-typecheck-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).log"
& $node $tsgo --project (Join-Path $root 'src\tsconfig.json') --pretty false --incremental --noEmit *> $typecheckLog
if ($LASTEXITCODE -ne 0) {
	Get-Content -LiteralPath $typecheckLog -Tail 100
	throw 'Desktop TypeScript check failed'
}
# The product task uses esbuild and generates its own out-build tree. Running the
# legacy gulp-tsb compile first type-checks and emits thousands of test files,
# then the product task discards that output. Keep the check; skip the duplicate emit.
$tasks = @("vscode-win32-x64")
foreach ($task in $tasks) {
	$log = Join-Path $logs "$task-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).log"
	$previousPreference = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		& $node --experimental-strip-types --max-old-space-size=8192 $gulp $task *> $log
		$exitCode = $LASTEXITCODE
	} finally {
		$ErrorActionPreference = $previousPreference
	}
	if ($exitCode -ne 0) {
		Get-Content -LiteralPath $log -Tail 200
		throw "Desktop product task failed: $task"
	}
	if ($task -eq "vscode-win32-x64") {
		$environmentSource = Join-Path $root ".build\environments"
		$productRoot = "D:\gpt-workspace\octocode\source\VSCode-win32-x64"
		if (-not (Test-Path -LiteralPath (Join-Path $productRoot "OctoCode.exe"))) {
			throw "Desktop product output missing: $productRoot"
		}
		# OctoCode ships local-only by default: remove account-backed VS Code adapters.
		$builtins = Join-Path $productRoot "resources\app\extensions"
		foreach ($accountAdapter in @("github", "github-authentication", "microsoft-authentication")) {
			$adapterPath = Join-Path $builtins $accountAdapter
			if (Test-Path -LiteralPath $adapterPath) { Remove-BuildDirectory $adapterPath }
		}
		foreach ($buildArtifact in @(
			(Join-Path $environmentSource "node\cache")
		)) {
			if (Test-Path -LiteralPath $buildArtifact) { Remove-BuildDirectory $buildArtifact }
		}
		# OpenSec asks npm for a newer version every time its CLI starts, which is an
		# outbound request from a product meant to run entirely locally. The check is
		# fire-and-forget and swallows its own failure, so nothing reports it: the call
		# was found by reading the shipped bundle. The scanner itself is offline and
		# stays; only the version check goes, and it goes here so that re-provisioning
		# the environment cannot bring it back.
		$openSecUpdateChecker = Join-Path $environmentSource ("opensec" + [IO.Path]::DirectorySeparatorChar + "node_modules" + [IO.Path]::DirectorySeparatorChar + "opensec-intelligence" + [IO.Path]::DirectorySeparatorChar + "dist" + [IO.Path]::DirectorySeparatorChar + "src" + [IO.Path]::DirectorySeparatorChar + "cli" + [IO.Path]::DirectorySeparatorChar + "update-checker.js")
		if (Test-Path -LiteralPath $openSecUpdateChecker) {
			$neutralised = @'
/**
 * Neutralised by the OctoCode build.
 *
 * The original fetched https://registry.npmjs.org to compare versions on every
 * CLI start. This product runs without reaching outside the machine, so the call
 * is replaced rather than merely disabled: OpenSec offers no setting that turns
 * it off, and a removed call cannot be switched back on by configuration.
 */
export async function checkForUpdate(_currentVersion) {
	return;
}
'@
			Set-Content -LiteralPath $openSecUpdateChecker -Value $neutralised -Encoding utf8
			Write-Host "Neutralised OpenSec update check (no outbound npm request)"
		}

		$pythonSource = Join-Path $environmentSource "python"
		Get-ChildItem -LiteralPath $pythonSource -File -Recurse -Force -ErrorAction SilentlyContinue |
			Where-Object Extension -In ".pyc", ".pyo" | Remove-Item -Force
		Get-ChildItem -LiteralPath $pythonSource -Directory -Filter "__pycache__" -Recurse -Force -ErrorAction SilentlyContinue |
			Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { Remove-BuildDirectory $_.FullName }
		# Toolchains that OctoCode provisions on demand are deliberately kept OUT of
		# the installer; they are downloaded from their vendor the first time a
		# command needs them. Keep this list in sync with `shipped: false` in
		# octocode-core/src/services/environments/manifest.ts — a drift test in that
		# package asserts the two agree, because a mismatch fails silently.
		$onDemandEnvironments = @(
			'android', 'dotnet', 'ffmpeg', 'go', 'jdk', 'pandoc',
			'powershell', 'protobuf', 'rust', 'uv', 'wsl'
		)
		$excludedDirs = $onDemandEnvironments | ForEach-Object { Join-Path $environmentSource $_ }

		$copyLog = Join-Path $logs "copy-environments-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).log"
		& robocopy.exe $environmentSource (Join-Path $productRoot "environments") /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NP /NFL /NDL /NJH /NJS /XD @excludedDirs *> $copyLog

		# robocopy /E copies but never purges, so excluding a directory here is not
		# enough on its own: a copy left over from an earlier build would still be
		# sitting in the product tree, and code.iss packages it with Source: "*".
		# Remove them from the destination explicitly so the payload matches intent.
		foreach ($onDemand in $onDemandEnvironments) {
			$stale = Join-Path $productRoot "environments\$onDemand"
			if (Test-Path -LiteralPath $stale) {
				Remove-BuildDirectory $stale
				Write-Host "Excluded on-demand environment from payload: $onDemand"
			}
		}
		$copyExitCode = $LASTEXITCODE
		if ($copyExitCode -gt 7) {
			Get-Content -LiteralPath $copyLog -Tail 100
			throw "Desktop environment copy failed with exit code $copyExitCode"
		}
		$staleSelfTest = Join-Path $productRoot "environments\scripts\self-test.ps1"
		if (Test-Path -LiteralPath $staleSelfTest) { Remove-Item -LiteralPath $staleSelfTest -Force }
		$testSource = Join-Path $root ".build\test"
		if (-not (Test-Path -LiteralPath (Join-Path $testSource "self-test.ps1"))) { throw "Product self-test source missing" }
		if (-not (Test-Path -LiteralPath (Join-Path $testSource "mcp-stdio-smoke.mjs"))) { throw "Product MCP smoke source missing" }
		if (-not (Test-Path -LiteralPath (Join-Path $testSource "mcp-self-test.ps1"))) { throw "Product MCP self-test source missing" }
		$productTest = Join-Path $productRoot "test"
		if (Test-Path -LiteralPath $productTest) { Remove-BuildDirectory $productTest }
		New-Item -ItemType Directory -Force -Path $productTest | Out-Null
		Copy-Item -LiteralPath (Join-Path $testSource "self-test.ps1") -Destination (Join-Path $productRoot "test\self-test.ps1") -Force
		Copy-Item -LiteralPath (Join-Path $testSource "mcp-stdio-smoke.mjs") -Destination (Join-Path $productRoot "test\mcp-stdio-smoke.mjs") -Force
		Copy-Item -LiteralPath (Join-Path $testSource "mcp-self-test.ps1") -Destination (Join-Path $productRoot "test\mcp-self-test.ps1") -Force

		# Install OctoCode through VS Code's native extension lifecycle. The built-in
		# scanner rejects this third-party extension, while the portable user store is
		# both supported and remains under the product root.
		$dataRoot = Join-Path $productRoot "data"
		if (Test-Path -LiteralPath $dataRoot) { Remove-BuildDirectory $dataRoot }
		New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
		& (Join-Path $productRoot "bin\octocode.cmd") --install-extension $vsix --force
		if ($LASTEXITCODE -ne 0) { throw "OctoCode VSIX installation failed: $LASTEXITCODE" }
		$extensionRoot = Join-Path $dataRoot "extensions\octocode.octocode-$extensionVersion"
		$agentCmd = Join-Path $extensionRoot "bin\win32-x64\octocode-agent.cmd"
		if (-not (Test-Path -LiteralPath $agentCmd)) { throw "OctoCode agent CLI missing: $agentCmd" }
		# Both Rust binaries must be the ones this tree just built. The harness used
		# to be an orphan copy with no build chain behind it, so it is verified the
		# same way as the host, and must also self-identify as the product binary.
		foreach ($binary in @("octocode-host.exe", "octocode-harness.exe")) {
			$staged = Join-Path "D:\gpt-workspace\octocode\source\octocode-core\src\bin\win32-x64" $binary
			$packaged = Join-Path $extensionRoot "bin\win32-x64\$binary"
			if (-not (Test-Path -LiteralPath $staged)) { throw "Fresh release binary missing: $staged" }
			if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $packaged -Algorithm SHA256).Hash) {
				throw "Packaged $binary does not match the fresh release build"
			}
		}
		$harnessVersion = (& (Join-Path $extensionRoot "bin\win32-x64\octocode-harness.exe") --version) -join ''
		if ($harnessVersion -notmatch '^octocode-harness ') {
			throw "Packaged harness does not self-identify as the product binary: $harnessVersion"
		}
		$duplicateBuiltin = Get-ChildItem -LiteralPath (Join-Path $productRoot "resources\app\extensions") -Directory -ErrorAction SilentlyContinue |
			Where-Object Name -Match "^OctoCode(\.octocode)?$"
		if ($duplicateBuiltin) { throw "Duplicate built-in OctoCode extension: $($duplicateBuiltin.FullName -join ', ')" }
		Copy-Item -LiteralPath $agentCmd -Destination (Join-Path $productRoot "bin\octocode-agent.cmd") -Force

		$userData = Join-Path $dataRoot "user-data"
		if (Test-Path -LiteralPath $userData) { Remove-BuildDirectory $userData }
		$user = Join-Path $userData "User"
		New-Item -ItemType Directory -Force -Path $user | Out-Null
		$settings = @{
			"security.workspace.trust.enabled" = $false
			"security.workspace.trust.startupPrompt" = "never"
			"security.workspace.trust.banner" = "never"
			"security.workspace.trust.untrustedFiles" = "open"
			"security.workspace.trust.emptyWindow" = $true
			"window.autoDetectColorScheme" = $true
			# The extension restores the chat / multimodal / execution layout on
			# activation. Without this, every new window first paints VS Code's
			# welcome page and then swaps it out, which reads as the product
			# opening blank.
			"workbench.startupEditor" = "none"
			"workbench.colorTheme" = "Solarized Light"
			"workbench.preferredLightColorTheme" = "Solarized Light"
			"workbench.preferredDarkColorTheme" = "Dark 2026"
			"terminal.integrated.gpuAcceleration" = "off"
			# OctoCode drives the integrated browser through its own `browser`
			# tool and shows every page in the multimodal slot. Without these two
			# settings only `open` works: navigate/read/screenshot and the
			# click/type/drag tools stay unregistered, so the agent can open a
			# page but never read or act on it.
			"workbench.browser.enableChatTools" = $true
			"workbench.browser.experimentalUserTools.enabled" = $true
			# VS Code extensions are managed from the component market. Its own
			# recommendation prompts opened the Extensions view as an extra
			# column next to the OctoCode side bar.
			"extensions.ignoreRecommendations" = $true
			# No `workbench.colorCustomizations` here on purpose. Pinning the title
			# bar and status bar to fixed hex values overrode every theme the user
			# picked, which is why those two bars stayed dark while the rest of the
			# product switched. Their colours now come from the active theme.
		} | ConvertTo-Json -Depth 4
		[IO.File]::WriteAllText((Join-Path $user "settings.json"), $settings, [Text.UTF8Encoding]::new($false))

		$mcpDirectory = Join-Path $productRoot "environments\tools\mcp"
		New-Item -ItemType Directory -Force -Path $mcpDirectory | Out-Null
		$mcpSettings = @{
			mcpServers = [ordered]@{
				"code-review-graph" = @{
					command = '${env:OCTOCODE_PYTHON_BASE}'
					args = @("-m", "code_review_graph", "serve", "--repo", '${env:OCTOCODE_WORKSPACE}')
					env = @{ PYTHONPATH = '${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/code-review-graph' }
					disabled = $false
					alwaysAllow = @()
				}
				"llm-wiki" = @{
					command = '${env:OCTOCODE_NODE}'
					args = @(
						'${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/llmwiki/node_modules/@llmwiki/core/dist/mcp/bin.js',
						'${env:OCTOCODE_WORKSPACE}/.wiki'
					)
					disabled = $false
					alwaysAllow = @()
				}
				"scrapling" = @{
					command = '${env:OCTOCODE_PYTHON_BASE}'
					args = @('${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/scrapling/server.py')
					disabled = $false
					alwaysAllow = @()
				}
			}
		} | ConvertTo-Json -Depth 8
		[IO.File]::WriteAllText((Join-Path $mcpDirectory "mcp_settings.json"), $mcpSettings, [Text.UTF8Encoding]::new($false))

		$workspace = Join-Path $productRoot "workspace"
		New-Item -ItemType Directory -Force -Path $workspace, (Join-Path $productRoot "test") | Out-Null
		$workspaceSeed = Join-Path $root ".build\workspace"
		if (Test-Path -LiteralPath $workspaceSeed) {
			& robocopy.exe $workspaceSeed $workspace /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
			if ($LASTEXITCODE -gt 7) { throw "Workspace seed copy failed: $LASTEXITCODE" }
		}
		$wikiModule = Join-Path $productRoot "environments\tools\mcp\llmwiki\node_modules\@llmwiki\core\dist\index.js"
		$wikiRoot = Join-Path $workspace ".wiki"
		if (-not (Test-Path -LiteralPath $wikiRoot)) {
			& $node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { initWiki } = await import(pathToFileURL(process.argv[1])); await initWiki(process.argv[2]);" $wikiModule $workspace
			if ($LASTEXITCODE -ne 0) { throw "Default LLM Wiki initialization failed" }
		}
		if (-not (Test-Path -LiteralPath $wikiRoot)) { throw "Default LLM Wiki directory missing" }
		$seedLogs = Join-Path $userData "logs"
		if (Test-Path -LiteralPath $seedLogs) { Remove-BuildDirectory $seedLogs }
	}
	[pscustomobject]@{ task = $task; log = $log }
}
exit 0
