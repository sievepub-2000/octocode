#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4173}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
python -m http.server "${PORT}" --directory .
