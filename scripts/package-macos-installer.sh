#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-release}"
SESSION_ID="${2:-demo}"
PORT="${3:-999}"

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

cp "$REPO_ROOT/target/$PROFILE_DIR/octocode-cli" "$APP_ROOT/Contents/MacOS/octocode-cli"
cp -R "$REPO_ROOT/ui-shell" "$APP_ROOT/Contents/Resources/ui-shell"
cp "$REPO_ROOT/ui-shell/assets/octocode-icon.svg" "$APP_ROOT/Contents/Resources/octocode-icon.svg"

cat > "$APP_ROOT/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Octocode</string>
  <key>CFBundleExecutable</key><string>octocode-cli</string>
  <key>CFBundleIdentifier</key><string>com.zhouhao.octocode</string>
  <key>CFBundleName</key><string>Octocode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
</dict>
</plist>
EOF

pkgbuild --root "$APP_ROOT" --identifier com.zhouhao.octocode --version "$VERSION" "$BUNDLE_ROOT/Octocode-$VERSION.pkg"
hdiutil create -volname "Octocode $VERSION" -srcfolder "$APP_ROOT" -ov -format UDZO "$BUNDLE_ROOT/Octocode-$VERSION.dmg"

echo "macOS installer artifacts ready in $BUNDLE_ROOT"