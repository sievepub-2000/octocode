# The single authoritative OctoCode toolchain.
#
# `desktop-shell\.build\environments` is the stack that gets packaged into the
# product, so building against it is what makes a build reproduce what ships.
# The installed product's `environments` folder is the same tree after packaging
# and is only used when a build-input tree is not present.
param([string[]]$EnvironmentRoots = @(
    'D:\gpt-workspace\octocode\source\desktop-shell\.build\environments',
    # The installed product is the only fallback within this project.
    'E:\Program Files\octocode\environments'
), [switch]$DesktopNative)
$env:OCTO_ENV_ROOT = $EnvironmentRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'node\node.exe') } | Select-Object -First 1
if (-not $env:OCTO_ENV_ROOT) { throw 'No OctoCode environment stack found' }
$env:CARGO_HOME = Join-Path $env:OCTO_ENV_ROOT 'rust\cargo'
$env:RUSTUP_HOME = Join-Path $env:OCTO_ENV_ROOT 'rust\rustup'
$env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin'
$prepend = @(
    (Join-Path $env:OCTO_ENV_ROOT 'node'),
    (Join-Path $env:CARGO_HOME 'bin'),
    (Join-Path $env:OCTO_ENV_ROOT 'python'),
    (Join-Path $env:OCTO_ENV_ROOT 'python\Scripts'),
    (Join-Path $env:OCTO_ENV_ROOT 'uv'),
    (Join-Path $env:OCTO_ENV_ROOT 'protobuf\bin'),
    (Join-Path $env:OCTO_ENV_ROOT 'go\bin'),
    (Join-Path $PSScriptRoot 'build-tools\nasm\nasm-3.02'),
    'D:\Program Files\Develop\nasm-3.02',
    $env:LIBCLANG_PATH,
    'D:\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
) | Where-Object { Test-Path -LiteralPath $_ }
$env:Path = ($prepend -join ';') + ';' + $env:Path

# An empty-but-present environment value also overrides Cargo repository flags.
foreach ($flagVariable in @('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($flagVariable, 'Process'))) {
        Remove-Item -LiteralPath "Env:$flagVariable" -ErrorAction SilentlyContinue
    }
}

# The bundled LLVM linker avoids localized MSVC export notices being reported as Rust warnings.
if ($env:OS -eq 'Windows_NT') {
    # Portable Windows Perl cannot load the POSIX C.UTF-8 locale.
    if ($env:LC_ALL -eq 'C.UTF-8') { $env:LC_ALL = 'C' }
    foreach ($compilerFlags in @('CFLAGS_x86_64_pc_windows_msvc', 'CXXFLAGS_x86_64_pc_windows_msvc')) {
        $currentFlags = [Environment]::GetEnvironmentVariable($compilerFlags, 'Process')
        if ($currentFlags -notmatch '(?:^|\s)/utf-8(?:\s|$)') {
            [Environment]::SetEnvironmentVariable($compilerFlags, ($currentFlags + ' /utf-8').Trim(), 'Process')
        }
    }
    $buildPerl = Join-Path $PSScriptRoot 'cli-build-tools\perl\perl\bin\perl.exe'
    if (!$env:OPENSSL_SRC_PERL -and (Test-Path -LiteralPath $buildPerl -PathType Leaf)) {
        $env:OPENSSL_SRC_PERL = $buildPerl
    }
    $rustSysroot = (& rustc --print sysroot).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to locate the bundled Rust sysroot' }
    $rustLinker = Join-Path $rustSysroot 'lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe'
    if (-not (Test-Path -LiteralPath $rustLinker -PathType Leaf)) { throw 'Bundled Windows LLVM linker missing' }
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $rustLinker
    # Cargo gives encoded flags precedence over RUSTFLAGS. Check every supplied
    # flavor, including a conflicting later flag, before selecting the linker.
    $encodedFlags = -not [string]::IsNullOrEmpty($env:CARGO_ENCODED_RUSTFLAGS)
    $effectiveFlags = if ($encodedFlags) { $env:CARGO_ENCODED_RUSTFLAGS.Replace([char]31, ' ') } else { $env:RUSTFLAGS }
    $flavors = @([regex]::Matches($effectiveFlags, '(?:^|\s)(?:-C\s*|--codegen(?:=|\s+))linker-flavor(?:=|\s+)(\S+)'))
    if ($effectiveFlags -match 'linker-flavor' -and
        ($flavors.Count -eq 0 -or @($flavors | Where-Object { $_.Groups[1].Value -ne 'lld-link' }).Count)) {
        throw 'Configured Rust linker flavor conflicts with the bundled Windows LLVM linker'
    }
    # The product pipeline supplies per-stage target flags through Cargo --config.
    # Do not inject RUSTFLAGS: that would override repository target flags.
}
$env:PROTOC = Join-Path $env:OCTO_ENV_ROOT 'protobuf\bin\protoc.exe'
$env:PROTOC_INCLUDE = Join-Path $env:OCTO_ENV_ROOT 'protobuf\include'
if (-not (Test-Path -LiteralPath $env:PROTOC -PathType Leaf) -or -not (Test-Path -LiteralPath $env:PROTOC_INCLUDE -PathType Container)) {
    throw 'Bundled Windows protoc and includes are required for a reproducible build'
}

# Keep project-created temporary files and caches inside the project workspace.
$taskScratch = Join-Path $PSScriptRoot 'tmp'
New-Item -ItemType Directory -Path $taskScratch -Force | Out-Null
$env:TEMP = $taskScratch
$env:TMP = $taskScratch
$env:npm_config_cache = Join-Path $PSScriptRoot 'cache\npm'
$env:pnpm_config_store_dir = 'D:\gpt-workspace\octocode\tools\pnpm-store'
$env:PIP_CACHE_DIR = Join-Path $PSScriptRoot 'cache\pip'
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot 'cache\uv'

# npm does not inherit a root package's config into dependency lifecycle scripts.
# Select the product ABI explicitly for desktop installs; other source tasks keep
# their own Node target unless this mode is requested.
if ($DesktopNative) {
    $desktopManifestPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop-shell\package.json'
    $desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw | ConvertFrom-Json
    if ($desktopManifest.config.node_gyp_target -ne $desktopManifest.devDependencies.electron) {
        throw 'Desktop native target must match the pinned Electron version'
    }
    foreach ($property in $desktopManifest.config.PSObject.Properties) {
        if ($property.Name -like 'node_gyp_*') {
            [Environment]::SetEnvironmentVariable(('npm_package_config_' + $property.Name), [string]$property.Value, 'Process')
        }
    }
    $desktopPython = Join-Path $env:OCTO_ENV_ROOT 'python\python.exe'
    if (-not (Test-Path -LiteralPath $desktopPython -PathType Leaf)) { throw 'Bundled source Python is required for desktop native dependencies' }
    $env:PYTHON = $desktopPython
    $env:NODE_GYP_FORCE_PYTHON = $desktopPython
    $env:npm_package_config_node_gyp_python = $desktopPython
    if (-not $env:vs2022_install -and (Test-Path -LiteralPath 'D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat')) {
        $env:vs2022_install = 'D:\BuildTools'
    }
}
