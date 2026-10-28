# Post-install acceptance probe for the installed OctoCode product.
#
# Reports what is actually on disk and running. Every path below is the layout
# the current installer produces (portable data root under the install
# directory); the previous version of this script still probed the pre-2026
# `resources\app\extensions\octocode` + `%APPDATA%\OctoCode` layout, so it
# reported success against files that no longer exist.
$ErrorActionPreference = 'Continue'
$install = 'E:\Program Files\octocode'
$data = Join-Path $install 'data'
$manifestPath = 'D:\gpt-workspace\octocode\releases\release-manifest.json'
$manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$expectedVersion = if ($manifest) { $manifest.version } else { $null }
$extension = if ($expectedVersion) { Join-Path $data "extensions\octocode.octocode-$expectedVersion" } else { Join-Path $data 'extensions\octocode.octocode-MISSING-MANIFEST' }
$userData = Join-Path $data 'user-data'
$globalStorage = Join-Path $userData 'User\globalStorage\octocode.octocode'
$binaries = Join-Path $extension 'bin\win32-x64'
$node = Join-Path $install 'environments\node\node.exe'
$failures = [System.Collections.Generic.List[string]]::new()
if (!$expectedVersion) { $failures.Add("release manifest has no version: $manifestPath") }
$installedVersions = @(Get-ChildItem -LiteralPath (Join-Path $data 'extensions') -Directory -Filter 'octocode.octocode-*' -ErrorAction SilentlyContinue)
if ($installedVersions.Count -ne 1) { $failures.Add("expected one installed OctoCode extension, found: $($installedVersions.Name -join ', ')") }

function Require-Path([string]$Path, [string]$What) {
    if (Test-Path -LiteralPath $Path) { return $true }
    $failures.Add("missing $What`: $Path")
    return $false
}

Require-Path (Join-Path $install 'OctoCode.exe') 'product executable' | Out-Null
Require-Path $extension 'installed extension' | Out-Null
Require-Path (Join-Path $binaries 'octocode-host.exe') 'Rust host' | Out-Null
Require-Path (Join-Path $binaries 'octocode-harness.exe') 'unified harness' | Out-Null
Require-Path (Join-Path $binaries 'code-graph.exe') 'native project index' | Out-Null
$nodeAvailable = Require-Path $node 'bundled Node runtime'
Require-Path (Join-Path $install 'workspace') 'default workspace' | Out-Null

# The harness must be the product binary built from this tree, not a renamed copy.
$harnessExitCode = $null
$harnessVersion = if (Test-Path -LiteralPath (Join-Path $binaries 'octocode-harness.exe')) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Stop'
        $harnessOutput = & (Join-Path $binaries 'octocode-harness.exe') --version
        $harnessExitCode = $LASTEXITCODE
        if ($harnessExitCode -ne 0) { $failures.Add("harness version probe failed (exit $harnessExitCode)") }
        $harnessOutput -join ''
    } catch {
        $failures.Add("harness version probe could not run: $($_.Exception.GetType().Name)")
        ''
    } finally { $ErrorActionPreference = $previousPreference }
} else { '' }
if ($harnessVersion -notmatch '^octocode-harness ') {
    $failures.Add("harness does not self-identify as the product binary: '$harnessVersion'")
}

# A duplicate built-in copy of the extension makes it ambiguous which one runs.
$duplicate = @(if ($nodeAvailable) { Get-ChildItem -LiteralPath (Join-Path $install 'resources\app\extensions') -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -ne 'node_modules' |
    Where-Object {
        try {
            $identity = (& $node -p "require(process.argv[1]).publisher + '.' + require(process.argv[1]).name" (Join-Path $_.FullName 'package.json') 2>$null) -join ''
            if ($LASTEXITCODE -ne 0) { throw 'built-in extension manifest could not be parsed' }
        } catch {
            $failures.Add("cannot parse built-in extension manifest: $($_.Exception.GetType().Name)")
            return $false
        }
        $identity -ieq 'octocode.octocode'
    } })
if ($duplicate) { $failures.Add("duplicate built-in extension: $($duplicate.Name -join ', ')") }

# Workspace must be writable by the running user, or every file tool fails.
$probe = Join-Path $install ('workspace\.acceptance-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
$crud = [ordered]@{ Create = $false; Update = $false; Delete = $false }
try {
    [IO.File]::WriteAllText($probe, 'create', [Text.UTF8Encoding]::new($false))
    $crud.Create = (Get-Content -LiteralPath $probe -Raw) -eq 'create'
    [IO.File]::WriteAllText($probe, 'update', [Text.UTF8Encoding]::new($false))
    $crud.Update = (Get-Content -LiteralPath $probe -Raw) -eq 'update'
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
    $crud.Delete = -not (Test-Path -LiteralPath $probe)
} catch {
    $crud.Create = $false
    $crud.Update = $false
} finally {
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
}
foreach ($operation in $crud.Keys) { if (-not $crud[$operation]) { $failures.Add("workspace $operation failed") } }

$logRoot = Join-Path $userData 'logs'
$latestLog = Get-ChildItem -LiteralPath $logRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (!$latestLog) { $failures.Add("missing installed log directory: $logRoot") }
$severe = if ($latestLog) {
    @(Get-ChildItem -LiteralPath $latestLog.FullName -File -Recurse -ErrorAction SilentlyContinue |
        Select-String -Pattern '\[(error|warning)\]' -CaseSensitive:$false |
        ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line.Trim())" })
} else { @() }

foreach ($entry in $severe) { $failures.Add($entry) }
$effectiveConfig = Get-ChildItem -LiteralPath (Join-Path $globalStorage 'harness-runtime\sessions') -Filter config.toml -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$effectiveConfig) { $failures.Add("missing materialized model config under: $globalStorage\harness-runtime\sessions") }
# Presence is checked here; freshness and cold-start health need a separate live test.
$rust = Join-Path $install 'environments\rust\cargo\bin\rustc.exe'
$rustVersion = 'not provisioned (not tested)'
if (Test-Path -LiteralPath $rust) {
    $previousRustupHome = $env:RUSTUP_HOME
    $previousCargoHome = $env:CARGO_HOME
    try {
        $env:RUSTUP_HOME = Join-Path $install 'environments\rust\rustup'
        $env:CARGO_HOME = Join-Path $install 'environments\rust\cargo'
        $rustVersion = @(& $rust --version 2>&1 | ForEach-Object { [string]$_ }) -join "`n"
        if ($LASTEXITCODE -ne 0) { $failures.Add("bundled Rust version probe failed: $rustVersion") }
    } finally {
        $env:RUSTUP_HOME = $previousRustupHome
        $env:CARGO_HOME = $previousCargoHome
    }
}

$result = [pscustomobject]@{
    Pass = $failures.Count -eq 0
    Failures = @($failures)
    HarnessVersion = $harnessVersion
    HarnessProbeExitCode = $harnessExitCode
    ExtensionVersion = $(if ($nodeAvailable -and (Test-Path -LiteralPath (Join-Path $extension 'package.json'))) {
        (& $node -p "require(process.argv[1]).version" (Join-Path $extension 'package.json') 2>$null) -join ''
    } else { $null })
    ExpectedVersion = $expectedVersion
    Binaries = @(Get-ChildItem -LiteralPath $binaries -File -ErrorAction SilentlyContinue |
        ForEach-Object { [pscustomobject]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } })
    Processes = @(Get-CimInstance Win32_Process |
        Where-Object { $_.Name -in @('OctoCode.exe', 'octocode-host.exe', 'octocode-harness.exe') } |
        Select-Object Name, ProcessId, ExecutablePath)
    Databases = @(Get-ChildItem -LiteralPath $globalStorage -Filter '*.db' -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object FullName, Length)
    WorkspaceCrud = $crud
    BundledToolchain = [ordered]@{
        node = $(if ($nodeAvailable) { & $node --version 2>&1 } else { 'missing (not tested)' })
        rust = $rustVersion
    }
    Installer = @(Get-ChildItem 'D:\gpt-workspace\octocode\source\desktop-shell\.build\win32-x64\system-setup' -File -ErrorAction SilentlyContinue |
        ForEach-Object { [pscustomobject]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } })
    LatestMaterializedModelConfig = $effectiveConfig.FullName
    SettingsDatabase = Join-Path $userData 'User\globalStorage\state.vscdb'
    LatestLog = $latestLog.FullName
    ErrorsOrWarnings = $severe
}
$result | ConvertTo-Json -Depth 6
if (-not $result.Pass) { exit 1 }
exit 0
