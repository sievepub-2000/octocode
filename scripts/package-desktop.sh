#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-release}"
SESSION_ID="${2:-demo}"
PORT="${3:-999}"

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
*** Add File: c:\Users\周浩\vscode-workspace\octocode\scripts\package-windows-installer.ps1
param(
  [string]$Profile = "release",
  [string]$SessionId = "demo",
  [int]$Port = 999
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
Set-Location $repoRoot

$cargoToml = Get-Content (Join-Path $repoRoot "Cargo.toml") -Raw
if ($cargoToml -notmatch 'version\s*=\s*"([^"]+)"') {
  throw "failed to resolve workspace version from Cargo.toml"
}
$version = $matches[1]
$bundleName = "octocode-v$version-windows-x64"
$bundleRoot = Join-Path $repoRoot "out/desktop/$bundleName"

& (Join-Path $scriptRoot "package-desktop.ps1") -Profile $Profile -SessionId $SessionId -Port $Port
if ($LASTEXITCODE -ne 0) {
  throw "desktop bundle generation failed with exit code $LASTEXITCODE"
}

$installRoot = Join-Path $repoRoot "out/installers/windows"
$sourceRoot = Join-Path $installRoot "source"
$zipPath = Join-Path $installRoot "Octocode-$version-windows-x64.zip"
$installerPath = Join-Path $installRoot "Octocode-$version-windows-x64-setup.exe"

if (Test-Path $installRoot) {
  Remove-Item $installRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null

Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $zipPath -Force

$installScript = @"
param(
  [string]4Zip,
  [string]4Version,
  [string]4Quiet = "0"
)

4target = Join-Path 4env:LOCALAPPDATA "Programs/Octocode/4Version"
New-Item -ItemType Directory -Force -Path 4target | Out-Null
Expand-Archive -Path 4Zip -DestinationPath 4target -Force
4readme = Join-Path 4target "START-HERE.txt"
if (4Quiet -ne "1") {
  Write-Host "Installed Octocode to 4target"
  if (Test-Path 4readme) {
    Write-Host "See 4readme for startup instructions"
  }
}
"@
Set-Content -Path (Join-Path $sourceRoot "install.ps1") -Value $installScript -Encoding ASCII
Copy-Item $zipPath (Join-Path $sourceRoot (Split-Path $zipPath -Leaf)) -Force

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=Octocode $version has been installed under %LOCALAPPDATA%\Programs\Octocode\$version
TargetName=$installerPath
FriendlyName=Octocode $version Setup
AppLaunched=powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Zip "Octocode-$version-windows-x64.zip" -Version "$version"
PostInstallCmd=<None>
AdminQuietInstCmd=powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Zip "Octocode-$version-windows-x64.zip" -Version "$version" -Quiet 1
UserQuietInstCmd=powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Zip "Octocode-$version-windows-x64.zip" -Version "$version" -Quiet 1
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$sourceRoot\\
[SourceFiles0]
%FILE0%=
%FILE1%=
[Strings]
FILE0=install.ps1
FILE1=Octocode-$version-windows-x64.zip
"@
Set-Content -Path (Join-Path $installRoot "octocode-installer.sed") -Value $sed -Encoding ASCII

& iexpress.exe /N (Join-Path $installRoot "octocode-installer.sed")
if ($LASTEXITCODE -ne 0) {
  throw "IExpress failed with exit code $LASTEXITCODE"
}

Write-Host "Windows installer ready: $installerPath"
*** Add File: c:\Users\周浩\vscode-workspace\octocode\scripts\package-macos-installer.sh
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
*** Add File: c:\Users\周浩\vscode-workspace\octocode\docs\composer-ime-evaluation.md
# Composer IME Evaluation

The composer shell is now canvas-rendered, but the actual text entry layer remains a native textarea.

Why it remains native:

1. Chinese IME composition requires reliable `compositionstart`, `compositionupdate`, and `compositionend` handling.
2. Candidate selection must preserve undo/redo history and not lose the composition range.
3. Paste, multi-line editing, and line-break insertion need browser-native text semantics.

Runtime evaluation harness:

1. The composer canvas now displays IME active/idle state.
2. It counts composition commits, composition updates, paste actions, undo actions, redo actions, and multi-line inserts.
3. It records recent `beforeinput` and composition events to make manual QA visible in the running shell.

Decision for this phase:

1. Do not replace the native textarea yet.
2. Use the canvas shell only as the visual chrome.
3. Revisit full textarea replacement only after on-device IME QA passes for Chinese input, candidate selection, undo, paste, and multi-line editing.
*** Add File: c:\Users\周浩\vscode-workspace\octocode\docs\desktop-distribution.md
# Desktop Distribution

Current desktop packaging outputs are versioned and split into two layers.

Bundle layer:

1. `scripts/package-desktop.ps1` emits a versioned Windows bundle directory under `out/desktop/`.
2. `scripts/package-desktop.sh` emits a versioned Unix-like bundle directory under `out/desktop/`.
3. Each bundle includes the CLI binary, the canvas WebUI shell, a manifest, and `START-HERE.txt`.

Installer layer:

1. `scripts/package-windows-installer.ps1` produces a distributable `.exe` installer via IExpress.
2. `scripts/package-macos-installer.sh` is the macOS-native path for `.pkg` and `.dmg` generation.

Naming convention:

1. Bundles: `octocode-v<version>-<platform>`
2. Windows installer: `Octocode-<version>-windows-x64-setup.exe`
3. macOS artifacts: `Octocode-<version>.pkg` and `Octocode-<version>.dmg`

Minimum startup instructions:

1. Windows bundle: run `start-octocode-desktop.cmd`
2. Unix-like bundle: run `start-octocode-desktop.sh`
3. Installed Windows app: open `%LOCALAPPDATA%\Programs\Octocode\<version>` and run the launcher from the installed bundle