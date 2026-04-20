#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-999}"
SESSION_ID="${2:-demo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 990 || PORT > 999 )); then
	echo "Port must be between 990 and 999. Received: ${PORT}" >&2
	exit 2
fi

cd "${REPO_ROOT}"
cargo run -p octocode-cli -- desktop "${PORT}" "${SESSION_ID}"
