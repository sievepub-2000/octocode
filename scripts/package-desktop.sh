#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-release}"
SESSION_ID="${2:-demo}"
PORT="${3:-999}"

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 990 || PORT > 999 )); then
  echo "Port must be between 990 and 999. Received: ${PORT}" >&2
  exit 2
fi

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_ROOT/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(grep -E '^version\s*=\s*"' Cargo.toml | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')"

if [[ "$PROFILE" == "release" ]]; then
  cargo build -p octocode-cli --release
else
  cargo build -p octocode-cli
fi

PROFILE_DIR="$PROFILE"
TARGET_SUFFIX="$(uname -s | tr '[:upper:]' '[:lower:]')"
BUNDLE_NAME="octocode-v$VERSION-$TARGET_SUFFIX"
BUNDLE_ROOT="$REPO_ROOT/out/desktop/$BUNDLE_NAME"
APP_ROOT="$BUNDLE_ROOT/app"

rm -rf "$BUNDLE_ROOT"
mkdir -p "$APP_ROOT"

cp "$REPO_ROOT/target/$PROFILE_DIR/octocode-cli" "$APP_ROOT/octocode-cli"
cp -R "$REPO_ROOT/ui-shell" "$APP_ROOT/ui-shell"
cp "$REPO_ROOT/README.md" "$APP_ROOT/README.md"

cat > "$BUNDLE_ROOT/START-HERE.txt" <<EOF
Octocode Desktop Bundle
Version: $VERSION
Profile: $PROFILE

Start:
  1. Run ./start-octocode-desktop.sh
  2. Or open ./app/octocode-cli and run: ./octocode-cli desktop $PORT $SESSION_ID
EOF

cat > "$BUNDLE_ROOT/start-octocode-desktop.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "\$(dirname "\$0")/app"
./octocode-cli desktop $PORT $SESSION_ID
EOF
chmod +x "$BUNDLE_ROOT/start-octocode-desktop.sh"

cat > "$BUNDLE_ROOT/bundle-manifest.json" <<EOF
{"version":"$VERSION","bundle":"$BUNDLE_NAME","profile":"$PROFILE","sessionId":"$SESSION_ID","port":$PORT}
EOF

echo "Desktop bundle ready: $BUNDLE_ROOT"
