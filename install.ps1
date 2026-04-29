# Octocode one-click installer for Windows (PowerShell 5.1+ / 7+).
#
#   iex (iwr -UseBasicParsing https://raw.githubusercontent.com/sievepub-2000/octocode/master/install.ps1).Content
#
# What this does:
#   1. Ensures `cargo` is on PATH (installs rustup-init if missing, with consent).
#   2. Runs `cargo install --git https://github.com/sievepub-2000/octocode
#      --tag <REF> --locked octocode-cli`.
#   3. Prints the installed binary path and a quick-start hint.
#
# Override the ref with -Ref master for the bleeding edge.

[CmdletBinding()]
param(
    [string]$Ref = 'v2026.4.30',
    [switch]$Master,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
if ($Master) { $Ref = 'master' }

function Write-Step($msg) { Write-Host "[octocode-install] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[octocode-install] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[octocode-install] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[octocode-install] $msg" -ForegroundColor Red }

Write-Step "target ref: $Ref"

# 1. Ensure cargo is on PATH.
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    Write-Warn 'cargo not found on PATH.'
    if (-not $NonInteractive) {
        $reply = Read-Host 'Install Rust toolchain via rustup? [Y/n]'
        if ($reply -and $reply.ToLower() -ne 'y' -and $reply -ne '') {
            Write-Err 'Aborted. Install Rust manually from https://rustup.rs and re-run.'
            exit 2
        }
    }
    $rustupInit = Join-Path $env:TEMP 'rustup-init.exe'
    Write-Step "downloading rustup-init to $rustupInit"
    Invoke-WebRequest -UseBasicParsing -Uri 'https://win.rustup.rs/x86_64' -OutFile $rustupInit
    Write-Step 'running rustup-init -y --default-toolchain stable'
    & $rustupInit -y --default-toolchain stable
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $cargo) {
        Write-Err 'rustup completed but cargo is still missing on PATH. Restart shell and re-run.'
        exit 3
    }
}

Write-Step "using cargo: $($cargo.Source)"

# 2. cargo install from git tag.
$installArgs = @('install', '--git', 'https://github.com/sievepub-2000/octocode',
                 '--tag', $Ref, '--locked', '--bin', 'octocode-cli', 'octocode-cli')
if ($Ref -eq 'master') {
    # Tag flag is incompatible with branch; switch to --branch master.
    $installArgs = @('install', '--git', 'https://github.com/sievepub-2000/octocode',
                     '--branch', 'master', '--locked', '--bin', 'octocode-cli', 'octocode-cli')
}

Write-Step "running: cargo $($installArgs -join ' ')"
& cargo @installArgs
if ($LASTEXITCODE -ne 0) {
    Write-Err "cargo install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

# 3. Locate installed binary and print quick-start hint.
$binPath = Join-Path $env:USERPROFILE '.cargo\bin\octocode-cli.exe'
if (Test-Path $binPath) {
    Write-Ok "installed: $binPath"
} else {
    Write-Warn "binary not found at expected path $binPath; run 'where.exe octocode-cli' to locate it."
}

Write-Host ''
Write-Ok 'Octocode CLI installed.'
Write-Host ''
Write-Host 'Quick start:' -ForegroundColor White
Write-Host '  octocode-cli doctor                 # environment check'
Write-Host '  octocode-cli serve 9921 main        # WebUI on http://127.0.0.1:9921'
Write-Host '  octocode-cli chat                   # interactive CLI chat'
Write-Host ''
Write-Host 'First-time configuration: octocode-cli config set provider_id <id>'
Write-Host 'See README.md and `docs/modules/octocode-modules.en.md` for details.'
