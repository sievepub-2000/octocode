# Post-install acceptance probe for the installed OctoCode product.
#
# Reports what is actually on disk and running. Every path below is the layout
# the current installer produces (portable data root under the install
# directory); the previous version of this script still probed the pre-2026
# `resources\app\extensions\octocode` + `%APPDATA%\OctoCode` layout, so it
# reported success against files that no longer exist.
$ErrorActionPreference = 'Continue'
$install = 'D:\Program Files\OctoCode'
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
Require-Path (Join-Path $install 'environments\node\node.exe') 'bundled Node runtime' | Out-Null
Require-Path (Join-Path $install 'workspace') 'default workspace' | Out-Null

# The harness must be the product binary built from this tree, not a renamed copy.
$harnessVersion = if (Test-Path -LiteralPath (Join-Path $binaries 'octocode-harness.exe')) {
    (& (Join-Path $binaries 'octocode-harness.exe') --version) -join ''
} else { '' }
if ($harnessVersion -notmatch '^octocode-harness ') {
    $failures.Add("harness does not self-identify as the product binary: '$harnessVersion'")
}

# A duplicate built-in copy of the extension makes it ambiguous which one runs.
$duplicate = @(Get-ChildItem -LiteralPath (Join-Path $install 'resources\app\extensions') -Directory -ErrorAction SilentlyContinue |
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
    })
if ($duplicate) { $failures.Add("duplicate built-in extension: $($duplicate.Name -join ', ')") }

# Workspace must be writable by the running user, or every file tool fails.
$probe = Join-Path $install ('workspace\.acceptance-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
$crud = [ordered]@{}
try {
    [IO.File]::WriteAllText($probe, 'create', [Text.UTF8Encoding]::new($false))
    $crud.Create = (Get-Content -LiteralPath $probe -Raw) -eq 'create'
    [IO.File]::WriteAllText($probe, 'update', [Text.UTF8Encoding]::new($false))
    $crud.Update = (Get-Content -LiteralPath $probe -Raw) -eq 'update'
} catch {
    $crud.Create = $false
    $crud.Update = $false
} finally {
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
}
$crud.Delete = -not (Test-Path -LiteralPath $probe)
foreach ($operation in $crud.Keys) { if (-not $crud[$operation]) { $failures.Add("workspace $operation failed") } }

$logRoot = Join-Path $userData 'logs'
$latestLog = Get-ChildItem -LiteralPath $logRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
$severe = if ($latestLog) {
    @(Get-ChildItem -LiteralPath $latestLog.FullName -File -Recurse -ErrorAction SilentlyContinue |
        Select-String -Pattern '\[(error|warning)\]' -CaseSensitive:$false |
        ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line.Trim())" })
} else { @() }

foreach ($entry in $severe) { $failures.Add($entry) }
$effectiveConfig = Get-ChildItem -LiteralPath (Join-Path $globalStorage 'harness-runtime\sessions') -Filter config.toml -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$rust = Join-Path $install 'environments\rust\cargo\bin\rustc.exe'

[pscustomobject]@{
    Pass = $failures.Count -eq 0
    Failures = @($failures)
    HarnessVersion = $harnessVersion
    ExtensionVersion = $(if (Test-Path -LiteralPath (Join-Path $extension 'package.json')) {
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
        node = (& (Join-Path $install 'environments\node\node.exe') --version 2>&1)
        rust = $(if (Test-Path -LiteralPath $rust) { & $rust --version 2>&1 } else { 'not provisioned (not tested)' })
    }
    Installer = @(Get-ChildItem 'D:\gpt-workspace\octocode\source\desktop-shell\.build\win32-x64\system-setup' -File -ErrorAction SilentlyContinue |
        ForEach-Object { [pscustomobject]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } })
    LatestMaterializedModelConfig = $effectiveConfig.FullName
    SettingsDatabase = Join-Path $userData 'User\globalStorage\state.vscdb'
    LatestLog = $latestLog.FullName
    ErrorsOrWarnings = $severe
} | ConvertTo-Json -Depth 6
