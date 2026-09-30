# The single authoritative OctoCode toolchain.
#
# `desktop-shell\.build\environments` is the stack that gets packaged into the
# product, so building against it is what makes a build reproduce what ships.
# The installed product's `environments` folder is the same tree after packaging
# and is only used when a build-input tree is not present.
$candidates = @(
    'D:\gpt-workspace\octocode\source\desktop-shell\.build\environments',
    # The installed product is the only fallback within this project.
    'D:\gpt-workspace\octocode\runtime\environments'
)
$env:OCTO_ENV_ROOT = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'node\node.exe') } | Select-Object -First 1
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
    'D:\Program Files\Develop\protobuf-36.1\bin',
    'D:\Program Files\Develop\nasm-3.02',
    $env:LIBCLANG_PATH,
    'D:\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
) | Where-Object { Test-Path -LiteralPath $_ }
$env:Path = ($prepend -join ';') + ';' + $env:Path
$env:PROTOC = 'D:\Program Files\Develop\protobuf-36.1\bin\protoc.exe'

# Keep project-created temporary files and caches inside the project workspace.
$taskScratch = Join-Path $PSScriptRoot 'tmp'
New-Item -ItemType Directory -Path $taskScratch -Force | Out-Null
$env:TEMP = $taskScratch
$env:TMP = $taskScratch
$env:npm_config_cache = Join-Path $PSScriptRoot 'cache\npm'
$env:pnpm_config_store_dir = Join-Path $PSScriptRoot 'cache\pnpm-store'
$env:PIP_CACHE_DIR = Join-Path $PSScriptRoot 'cache\pip'
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot 'cache\uv'
