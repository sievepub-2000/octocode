# Desktop Distribution

Current desktop packaging outputs are versioned and split into two layers.

Bundle layer:

1. `scripts/package-desktop.ps1` emits a versioned Windows bundle directory under `out/desktop/`.
2. `scripts/package-desktop.sh` emits a versioned Unix-like bundle directory under `out/desktop/`.
3. Each bundle includes the CLI binary, the canvas WebUI shell, a manifest, and `START-HERE.txt`.

Installer layer:

1. `scripts/package-windows-installer.ps1` produces a distributable `.exe` installer via IExpress.
2. `scripts/package-macos-installer.sh` is the macOS-native path for `.pkg` and `.dmg` generation.
3. The Windows installer stages intermediate inputs under `C:\octocode-dist` to avoid non-ASCII path issues during IExpress packaging.

Naming convention:

1. Bundles: `octocode-v<version>-<platform>`
2. Windows installer: `Octocode-<version>-windows-x64-setup.exe`
3. macOS artifacts: `Octocode-<version>.pkg` and `Octocode-<version>.dmg`

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
