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
BUNDLE_ROOT="$REPO_ROOT/out/installers/macos"
APP_ROOT="$BUNDLE_ROOT/Octocode.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS to produce pkg and dmg artifacts." >&2
  exit 2
fi

"$SCRIPT_ROOT/package-desktop.sh" "$PROFILE" "$SESSION_ID" "$PORT"

PROFILE_DIR="$PROFILE"
rm -rf "$BUNDLE_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS" "$APP_ROOT/Contents/Resources"

# Copy binary and ui-shell under Resources so the server CWD resolves ui-shell/
cp "$REPO_ROOT/target/$PROFILE_DIR/octocode-cli" "$APP_ROOT/Contents/Resources/octocode-cli"
chmod +x "$APP_ROOT/Contents/Resources/octocode-cli"
cp -R "$REPO_ROOT/ui-shell" "$APP_ROOT/Contents/Resources/ui-shell"

# Launcher: sets CWD to Resources where ui-shell/ lives, then opens browser
cat > "$APP_ROOT/Contents/MacOS/Octocode" << LAUNCHER
#!/usr/bin/env bash
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
RESOURCES="\$(dirname "\$SCRIPT_DIR")/Resources"
cd "\$RESOURCES"
"\$RESOURCES/octocode-cli" serve $PORT $SESSION_ID &
SERVER_PID=\$!
sleep 0.8
open "http://127.0.0.1:$PORT/ui-shell/?session=$SESSION_ID"
wait "\$SERVER_PID"
LAUNCHER
chmod +x "$APP_ROOT/Contents/MacOS/Octocode"

cat > "$APP_ROOT/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Octocode</string>
  <key>CFBundleExecutable</key><string>Octocode</string>
  <key>CFBundleIdentifier</key><string>com.zhouhao.octocode</string>
  <key>CFBundleName</key><string>Octocode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

pkgbuild --root "$APP_ROOT" --identifier com.zhouhao.octocode --version "$VERSION" \
  "$BUNDLE_ROOT/Octocode-$VERSION.pkg" 2>/dev/null || true

# Create DMG with Applications symlink
DMG_STAGE="$BUNDLE_ROOT/.dmg-stage"
rm -rf "$DMG_STAGE"
mkdir -p "$DMG_STAGE"
cp -r "$APP_ROOT" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "Octocode $VERSION" -srcfolder "$DMG_STAGE" -ov -format UDZO \
  "$BUNDLE_ROOT/Octocode-$VERSION-macos.dmg"
rm -rf "$DMG_STAGE"

echo ""
echo "macOS installer artifacts ready in $BUNDLE_ROOT"
echo "  Install: open $BUNDLE_ROOT/Octocode-$VERSION-macos.dmg"
echo "           drag Octocode.app to Applications"
echo "  CLI:     Octocode.app/Contents/Resources/octocode-cli serve 991 demo"