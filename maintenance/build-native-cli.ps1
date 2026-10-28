$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$desktop = Join-Path $source 'desktop-shell'
. (Join-Path $source 'build-product-safety.ps1')
if ($env:VSCODE_CLI_PRODUCT_JSON) { throw 'Custom CLI product overrides are not release inputs' }
try { $null = Get-NativeCliBuildInput -DesktopRoot $desktop; Write-Host 'Native CLI verified current'; return } catch { Write-Host 'Building native CLI from current source' }
$sdk = Join-Path $desktop '.build\environments'
$env:CARGO_HOME = Join-Path $sdk 'rust\cargo'
$env:RUSTUP_HOME = Join-Path $sdk 'rust\rustup'
$cargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) { throw 'Prepare the source bundled Rust toolchain first' }
$vcvars = if ($env:vs2022_install) { Join-Path $env:vs2022_install 'VC\Auxiliary\Build\vcvars64.bat' } else { 'D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat' }
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'Set vs2022_install to a Visual Studio C++ Build Tools installation' }
$compilerEnvironment = & $env:ComSpec /d /s /c ('"{0}" >nul && set' -f $vcvars)
if ($LASTEXITCODE -ne 0) { throw 'MSVC environment import failed' }
foreach ($line in $compilerEnvironment) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
if (-not $env:OPENSSL_SRC_PERL) {
    $perl = Get-Command perl.exe -ErrorAction SilentlyContinue
    if (-not $perl) { throw 'Set OPENSSL_SRC_PERL to a portable Windows perl.exe for the vendored OpenSSL build' }
    $env:OPENSSL_SRC_PERL = $perl.Source
}
if (-not (Test-Path -LiteralPath $env:OPENSSL_SRC_PERL -PathType Leaf)) { throw 'OPENSSL_SRC_PERL does not name perl.exe' }
$sysroot = (& (Join-Path $env:CARGO_HOME 'bin\rustc.exe') --print sysroot).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Bundled Rust sysroot unavailable' }
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $sysroot 'lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe'
foreach ($name in @('RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { throw 'Native CLI release must retain repository Rust flags' }
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
foreach ($name in @('OPENSSL_DIR','OPENSSL_LIB_DIR','OPENSSL_INCLUDE_DIR','OPENSSL_NO_VENDOR')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$env:CFLAGS_x86_64_pc_windows_msvc = '/utf-8'
$env:CXXFLAGS_x86_64_pc_windows_msvc = '/utf-8'
$env:OPENSSL_STATIC = '1'
$env:CARGO_TARGET_DIR = Join-Path $desktop 'cli\target'
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
Assert-PhysicalBuildPath -Path $env:CARGO_TARGET_DIR -ScopeDirectory $desktop
$env:VSCODE_CLI_COMMIT = (& git -C $desktop rev-parse HEAD) -join ''
$prefix = (& git -C $desktop rev-parse --show-prefix) -join ''
if ($LASTEXITCODE -ne 0 -or $prefix -notmatch '^([A-Za-z0-9._-]+/)*$') { throw 'Native CLI repository path unavailable' }
$tree = (& git -C $desktop rev-parse ('HEAD:' + $prefix + 'cli')) -join ''
if ($LASTEXITCODE -ne 0 -or $env:VSCODE_CLI_COMMIT -notmatch '^[a-f0-9]{40}$' -or $tree -notmatch '^[a-f0-9]{40}$') { throw 'Native CLI source revision unavailable' }
if (@(& git -C $desktop status --porcelain -- cli).Count) { throw 'Commit native CLI source changes before a release build' }
Push-Location -LiteralPath (Join-Path $desktop 'cli')
try { & $cargo build --locked --release --bin code; if ($LASTEXITCODE -ne 0) { throw 'Native CLI release build failed' } } finally { Pop-Location }
if (@(& git -C $desktop status --porcelain -- cli).Count) { throw 'Native CLI source changed during build' }
$binary = Join-Path $env:CARGO_TARGET_DIR 'release\code.exe'
$receipt = [ordered]@{
    sourceCommit = $env:VSCODE_CLI_COMMIT
    cliTree = $tree
    version = (Get-Content -LiteralPath (Join-Path $desktop 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    cargoLockSha256 = (Get-FileHash -LiteralPath (Join-Path $desktop 'cli\Cargo.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
    productJsonSha256 = (Get-FileHash -LiteralPath (Join-Path $desktop 'product.json')).Hash.ToLowerInvariant()
    productOverridesSha256 = $(if (Test-Path -LiteralPath (Join-Path $desktop 'product.overrides.json')) { (Get-FileHash -LiteralPath (Join-Path $desktop 'product.overrides.json')).Hash.ToLowerInvariant() } else { $null })
    sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath ($binary + '.build.json') -Encoding UTF8
$null = Get-NativeCliBuildInput -DesktopRoot $desktop
Write-Host 'Native CLI release and receipt verified'
