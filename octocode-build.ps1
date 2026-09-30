# OctoCode product build — the single authoritative pipeline.
#
# Every shipped binary is produced here, from this tree, in this order:
#
#   1. harness  — octo-harness      -> src\bin\win32-x64\octocode-harness.exe
#   2. host     — octocode-core    -> src\bin\win32-x64\octocode-host.exe
#   3. extension— octocode-core    -> octocode-core\bin\octocode-<version>.vsix
#   4. desktop  — desktop-shell     -> VSCode-win32-x64\
#   5. installer— desktop-shell     -> .build\win32-x64\system-setup\OctoCodeSetup.exe
#
# Stages 4 and 5 re-verify that the host and harness inside the product are
# byte-identical to what stages 1 and 2 built, so a stale binary can never be
# packaged again.
[CmdletBinding()]
param(
    [ValidateSet('harness', 'host', 'extension', 'desktop', 'installer')]
    [string[]]$Stage = @('harness', 'host', 'extension', 'desktop', 'installer')
)
$ErrorActionPreference = 'Stop'
# Release builds share this workstation with the editor. Leave CPU time for UI/pty heartbeats.
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
if (!$env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = [string][Math]::Max(1, [Math]::Min(4, [Environment]::ProcessorCount - 1)) }
. "$PSScriptRoot\work\octo-env.ps1"
. "$PSScriptRoot\build-log-policy.ps1"

$core = "$PSScriptRoot\octocode-core"
$extensionVersion = (& (Join-Path $env:OCTO_ENV_ROOT 'node\node.exe') -p 'require(process.argv[1]).version' (Join-Path $core 'src\package.json')).Trim()
if ($extensionVersion -notmatch '^0\.1\.\d+$') { throw "Unexpected extension version: $extensionVersion" }
$harnessRoot = "$PSScriptRoot\octo-harness"
$binaries = Join-Path $core 'src\bin\win32-x64'
$logs = Join-Path $core 'work\verification'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# The settings page previews the harness base prompt from a copy inside the
# extension; the harness template is the only source.
Copy-Item -LiteralPath (Join-Path $harnessRoot 'crates\codegen\xai-grok-agent\templates\prompt.md') `
    -Destination (Join-Path $core 'src\resources\harness\system-prompt.md') -Force

# The versioned extension catalog is authoritative; ignored build inputs cannot
# overwrite reviewed source. Generate the installer's workspace seed from it.
$skillSeed = Join-Path $PSScriptRoot 'desktop-shell\.build\environments\tools\skills'
$skillCatalog = Join-Path $core 'src\assets\default-skills'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'maintenance\octocode-agent.cmd') -Destination (Join-Path $core 'src\bin\win32-x64\octocode-agent.cmd') -Force
if (Test-Path -LiteralPath $skillCatalog) {
    $safeSeed = [IO.Path]::GetFullPath($skillSeed)
    if (!$safeSeed.StartsWith([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Skill seed escaped source root' }
    if ((Test-Path -LiteralPath $safeSeed) -and ((Get-Item -LiteralPath $safeSeed -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Skill seed cannot be a junction' }
    & robocopy.exe $skillCatalog $safeSeed /MIR /R:2 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Default skill catalog sync failed: $LASTEXITCODE" }
}

function Invoke-Stage([string]$Name, [string]$WorkingDirectory, [scriptblock]$Body) {
    Write-Host "==> $Name"
    $started = [DateTime]::UtcNow
    Push-Location -LiteralPath $WorkingDirectory
    try { & $Body } finally { Pop-Location }
    Write-Host ("<== {0} ({1:N1} min)" -f $Name, ([DateTime]::UtcNow - $started).TotalMinutes)
}

function Assert-SameBinary([string]$Built, [string]$Packaged, [string]$What) {
    $a = (Get-FileHash -LiteralPath $Built -Algorithm SHA256).Hash
    $b = (Get-FileHash -LiteralPath $Packaged -Algorithm SHA256).Hash
    if ($a -ne $b) { throw "Packaged $What does not match the fresh release build ($Built)" }
}

if ($Stage -contains 'harness') {
    Invoke-Stage 'harness (release)' $harnessRoot {
        $log = Join-Path $logs 'harness-release.log'
        cmd /c "cargo build -p xai-grok-pager-bin --release --bin octocode-harness > `"$log`" 2>&1"
        if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 60; throw 'Harness release build failed' }
        $built = Join-Path $harnessRoot 'target\release\octocode-harness.exe'
        if (-not (Test-Path -LiteralPath $built)) { throw "Harness build produced no binary: $built" }
        $reported = (& $built --version) -join ''
        if ($reported -notmatch '^octocode-harness ') { throw "Harness does not self-identify: $reported" }
        Write-Host "    $reported"
        Copy-Item -LiteralPath $built -Destination (Join-Path $binaries 'octocode-harness.exe') -Force
    }
}

if ($Stage -contains 'host') {
    Invoke-Stage 'host (release)' $core {
        $log = Join-Path $logs 'host-release.log'
        cmd /c "cargo build -p octocode-host --release > `"$log`" 2>&1"
        if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 60; throw 'Host release build failed' }
        Copy-Item -LiteralPath (Join-Path $core 'target\release\octocode-host.exe') `
            -Destination (Join-Path $binaries 'octocode-host.exe') -Force
    }
}

if ($Stage -contains 'extension') {
    Invoke-Stage 'extension (check-types, lint, build, vsix)' $core {
        foreach ($task in @('check-types', 'lint', 'build', 'vsix')) {
            $log = Join-Path $logs "$task.log"
            cmd /c "pnpm $task > `"$log`" 2>&1"
            if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 80; throw "Extension task failed: $task" }
        }
        $vsix = Join-Path $core "bin\octocode-$extensionVersion.vsix"
        if (-not (Test-Path -LiteralPath $vsix)) { throw "VSIX missing: $vsix" }
        Write-Host ("    {0} ({1:N1} MB)" -f $vsix, ((Get-Item -LiteralPath $vsix).Length / 1MB))
    }
}

if ($Stage -contains 'desktop') {
    Invoke-Stage 'desktop product' $PSScriptRoot {
        & "$PSScriptRoot\build-desktop-product.remote.ps1"
        $extensionRoot = "$PSScriptRoot\VSCode-win32-x64\data\extensions\octocode.octocode-$extensionVersion\bin\win32-x64"
        Assert-SameBinary (Join-Path $binaries 'octocode-host.exe') (Join-Path $extensionRoot 'octocode-host.exe') 'host'
        Assert-SameBinary (Join-Path $binaries 'octocode-harness.exe') (Join-Path $extensionRoot 'octocode-harness.exe') 'harness'
    }
}

if ($Stage -contains 'installer') {
    Invoke-Stage 'single-file installer' $PSScriptRoot {
        & "$PSScriptRoot\build-desktop-installer.ps1"
    }
}
