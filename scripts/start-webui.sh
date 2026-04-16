#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-999}"
SESSION_ID="${2:-demo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
cargo run -p octocode-cli -- desktop "${PORT}" "${SESSION_ID}"
