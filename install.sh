#!/usr/bin/env bash
# Octocode one-click installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/sievepub-2000/octocode/master/install.sh | bash
#
# Environment overrides:
#   OCTOCODE_REF     git ref to install (default: v2026.4.29). Use 'master' for HEAD.
#   OCTOCODE_FORCE   if set to 1, do not prompt before installing rustup.
#
# What this does:
#   1. Ensures `cargo` is on PATH (offers to install rustup if missing).
#   2. Runs `cargo install --git https://github.com/sievepub-2000/octocode
#      --tag $OCTOCODE_REF --locked octocode-cli`.
#   3. Prints the installed binary path and quick-start hint.

set -euo pipefail

REF="${OCTOCODE_REF:-v2026.4.29}"
FORCE="${OCTOCODE_FORCE:-0}"

step() { printf '\033[36m[octocode-install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[octocode-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[octocode-install]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[octocode-install]\033[0m %s\n' "$*" >&2; }

step "target ref: ${REF}"

# 1. Detect platform.
case "$(uname -s)" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)      err "unsupported platform: $(uname -s). Use install.ps1 on Windows."; exit 2 ;;
esac
step "platform: ${PLATFORM} ($(uname -m))"

# 2. Ensure cargo is on PATH.
if ! command -v cargo >/dev/null 2>&1; then
    warn "cargo not found on PATH."
    if [ "${FORCE}" != "1" ] && [ -t 0 ]; then
        printf '\033[33m[octocode-install]\033[0m Install Rust toolchain via rustup? [Y/n] '
        read -r reply || reply=""
        case "${reply}" in
            ""|y|Y|yes|YES) ;;
            *) err "aborted. Install Rust manually from https://rustup.rs and re-run."; exit 2 ;;
        esac
    fi
    step "running: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    # shellcheck disable=SC1091
    if [ -f "${HOME}/.cargo/env" ]; then . "${HOME}/.cargo/env"; fi
    if ! command -v cargo >/dev/null 2>&1; then
        err "rustup finished but cargo is still missing. Restart your shell and re-run."
        exit 3
    fi
fi
step "using cargo: $(command -v cargo)"

# 3. Toolchain prerequisites for building from source.
if [ "${PLATFORM}" = "linux" ]; then
    if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
        warn "no C compiler detected; some crates need 'build-essential' / 'gcc' / 'pkg-config'."
        warn "Debian/Ubuntu:  sudo apt-get install -y build-essential pkg-config libssl-dev"
        warn "Fedora/RHEL:    sudo dnf install -y gcc pkgconf-pkg-config openssl-devel"
        warn "Alpine:         sudo apk add build-base pkgconf openssl-dev"
    fi
fi

# 4. cargo install from git ref.
INSTALL_ARGS=(install --git https://github.com/sievepub-2000/octocode --locked --bin octocode-cli)
case "${REF}" in
    master|main) INSTALL_ARGS+=(--branch "${REF}") ;;
    *)           INSTALL_ARGS+=(--tag "${REF}") ;;
esac
INSTALL_ARGS+=(octocode-cli)

step "running: cargo ${INSTALL_ARGS[*]}"
cargo "${INSTALL_ARGS[@]}"

BIN="${HOME}/.cargo/bin/octocode-cli"
if [ -x "${BIN}" ]; then
    ok "installed: ${BIN}"
else
    warn "binary not found at ${BIN}; run 'command -v octocode-cli' to locate it."
fi

cat <<EOF

$(ok 'Octocode CLI installed.')

Quick start:
  octocode-cli doctor                 # environment check
  octocode-cli serve 9921 main        # WebUI on http://127.0.0.1:9921
  octocode-cli chat                   # interactive CLI chat

First-time configuration: octocode-cli config set provider_id <id>
See README.md and docs/modules/octocode-modules.en.md for details.
EOF
