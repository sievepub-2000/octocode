# Desktop Distribution

Current desktop packaging outputs are versioned and split into two layers.

Bundle layer:

1. `scripts/package-desktop.ps1` emits a versioned Windows bundle directory under `out/desktop/`.
2. `scripts/package-desktop.sh` emits a versioned Unix-like bundle directory under `out/desktop/`.
3. Each bundle includes the CLI binary, the canvas WebUI shell, a manifest, and `START-HERE.txt`.

Installer layer:

1. `scripts/package-windows-installer.ps1` produces a distributable `.exe` installer via IExpress.
2. `scripts/package-macos-installer.sh` is the macOS-native path for `.app`, `.pkg`, and `.dmg` generation.
3. `scripts/package-linux-installer.sh` produces a versioned `.tar.gz` plus embedded `install.sh` for Linux installs.
4. The Windows installer stages intermediate inputs under `C:\octocode-dist` to avoid non-ASCII path issues during IExpress packaging.

Naming convention:

1. Bundles: `octocode-v<version>-<platform>`
2. Windows installer: `Octocode-<version>-windows-x64-setup.exe`
3. macOS artifacts: `Octocode-<version>.pkg` and `Octocode-<version>-macos.dmg`
4. Linux artifacts: `octocode-<version>-linux-<arch>.tar.gz`

Minimum startup instructions:

1. Windows bundle: run `start-octocode-desktop.cmd`
2. Unix-like bundle: run `start-octocode-desktop.sh`
3. Installed Windows app: open `%LOCALAPPDATA%\Programs\Octocode\<version>` and run the launcher from the installed bundle

Verified Windows installation flow:

1. Generate the bundle with `scripts/package-desktop.ps1`.
2. Generate the installer with `scripts/package-windows-installer.ps1`.
3. Silent install with `Octocode-<version>-windows-x64-setup.exe /Q:A`.
4. Installed files land under `%LOCALAPPDATA%\Programs\Octocode\<version>`.
5. The installed `app\octocode-cli.exe` can run `status`, `snapshot`, and `serve` successfully.

Current cross-platform status:

1. Windows bundle, installer, silent install, installed CLI, and installed WebUI are verified end-to-end on a real Windows host.
2. macOS packaging now emits an `.app` wrapper plus `.pkg` and `.dmg` generation steps, but final install validation still needs a native macOS host.
3. Linux packaging now emits a distributable `.tar.gz` with an embedded `install.sh`, but final install validation still needs a native Linux host.
4. `scripts/test-regression.ps1` is the current HTTP/WebUI regression baseline and passed 54/54 checks against the live Windows release service.
