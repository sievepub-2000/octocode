#!/usr/bin/env bash
# package-linux-installer.sh — Build a Linux tarball and self-contained install.sh
# Usage: bash scripts/package-linux-installer.sh [release|debug] [session_id] [port]
# Targets: x86_64-unknown-linux-gnu (default) or cross-compiled via ARCH env var
set -euo pipefail

PROFILE="${1:-release}"
SESSION_ID="${2:-demo}"
PORT="${3:-10001}"
ARCH="${ARCH:-$(uname -m)}"

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_ROOT/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(grep -E '^version\s*=\s*"' Cargo.toml | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')"
BUNDLE_NAME="octocode-${VERSION}-linux-${ARCH}"
OUT_DIR="$REPO_ROOT/out/installers/linux"

echo "==> Profile:  $PROFILE"
echo "==> Version:  $VERSION"
echo "==> Arch:     $ARCH"
echo "==> Output:   $OUT_DIR"

# 1. Build
"$SCRIPT_ROOT/package-desktop.sh" "$PROFILE" "$SESSION_ID" "$PORT"

DESKTOP_BUNDLE="$REPO_ROOT/out/desktop/octocode-v${VERSION}-linux"

# 2. Create staging tarball directory
STAGE="$OUT_DIR/$BUNDLE_NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/ui-shell"
cp "$DESKTOP_BUNDLE/app/octocode-cli" "$STAGE/app/octocode-cli"
chmod +x "$STAGE/app/octocode-cli"
cp -r "$DESKTOP_BUNDLE/ui-shell/"* "$STAGE/ui-shell/"
cp "$REPO_ROOT/README.md" "$STAGE/README.md" 2>/dev/null || true

# 3. Embed install.sh inside staging dir
cat > "$STAGE/install.sh" << 'INSTALL_SCRIPT'
#!/usr/bin/env bash
# Octocode Linux Installer
# Usage: bash install.sh [prefix]      default prefix: $HOME/.local
# Usage: sudo bash install.sh /usr     system-wide install
set -euo pipefail

PREFIX="${1:-$HOME/.local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="$SCRIPT_DIR/app/octocode-cli"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "ERROR: octocode-cli binary not found at $VERSION_FILE" >&2
  exit 1
fi

INSTALL_BASE="$PREFIX/share/octocode"
BIN_DIR="$PREFIX/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

mkdir -p "$INSTALL_BASE/app" "$INSTALL_BASE/ui-shell" "$BIN_DIR"

echo "Installing octocode-cli to $INSTALL_BASE/app/..."
cp "$SCRIPT_DIR/app/octocode-cli" "$INSTALL_BASE/app/octocode-cli"
chmod +x "$INSTALL_BASE/app/octocode-cli"

echo "Installing ui-shell to $INSTALL_BASE/ui-shell/..."
cp -r "$SCRIPT_DIR/ui-shell/"* "$INSTALL_BASE/ui-shell/"

# Wrapper launcher: sets CWD so ui-shell/ is reachable
cat > "$BIN_DIR/octocode" << EOF
#!/usr/bin/env bash
cd "$INSTALL_BASE"
exec "$INSTALL_BASE/app/octocode-cli" "\$@"
EOF
chmod +x "$BIN_DIR/octocode"

# Optional .desktop entry
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/octocode.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Octocode
Comment=Canvas AI Coding Assistant
Exec=$BIN_DIR/octocode serve 10001 demo
Terminal=true
Categories=Development;IDE;
EOF

echo ""
echo "Octocode installed:"
echo "  CLI:     $BIN_DIR/octocode"
echo "  WebUI:   $BIN_DIR/octocode serve 10001 demo"
echo "           then open http://127.0.0.1:10001/ui-shell/?session=demo"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "NOTE: Add $BIN_DIR to your PATH:"
  echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
fi
INSTALL_SCRIPT
chmod +x "$STAGE/install.sh"

# 4. Create tarball
TAR_PATH="$OUT_DIR/${BUNDLE_NAME}.tar.gz"
tar -czf "$TAR_PATH" -C "$OUT_DIR" "$BUNDLE_NAME"
echo ""
echo "==> Linux installer ready: $TAR_PATH"
echo "    Install:"
echo "      tar -xzf ${BUNDLE_NAME}.tar.gz"
echo "      bash ${BUNDLE_NAME}/install.sh"
echo "      octocode serve 10001 demo"
