# Desktop dependency installation

Run from `source/desktop-shell` in PowerShell:

```powershell
. ..\work\octo-env.ps1 -DesktopNative
& "$env:OCTO_ENV_ROOT\node\node.exe" "$env:OCTO_ENV_ROOT\node\node_modules\npm\bin\npm-cli.js" ci --foreground-scripts --no-audit --no-fund
```

The explicit desktop mode reads the pinned Electron target from package.json and
exports `npm_package_config_node_gyp_*` for every root dependency install script.
The root native dependencies target Electron 43.8.3 (ABI 148), while the build
process runs source Node 26.12.0 (ABI 147). Downloading Electron headers in
preinstall alone does not select them for dependency lifecycle scripts.

Python is forced to the same source environment's python/python.exe, so node-gyp
cannot silently select a system Python installation. Postinstall exports each
subproject's own package.json config: build tools target source Node 26.12.0;
remote dependencies retain their separate Node runtime target. The authoritative
product pipeline selects desktop mode for its desktop stage.
The maintained Kerberos 7 source package builds directly with node-gyp, avoiding
its upstream deprecated prebuild-install downloader. It uses Node-API 9,
supported by both product runtimes, and retains the upstream Promise API.

Local maintained native packages are installed as packed copies (`install-links`
is enabled in the root and remote projects). Do not symlink root and remote
native builds to the same vendor directory: their separate runtime targets must
have separate build outputs. Windows preinstall applies the reviewed Python
finder and libuv SAL compatibility changes to the actual bundled npm/node-gyp
and the downloaded headers for all three target runtimes.

Windows requires Visual Studio 2022 C++ tools and the matching Spectre libraries.
For the installed MSVC 14.44 toolset the exact optional component is
`Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre`. Keep Spectre
mitigation enabled. Add this component through Microsoft's signed Visual Studio
Installer when missing; an administrator token is required. Do not disable
mitigation or substitute regular CRT libraries to make the build succeed.

After installation, verify build types, the maintained dependency tests and
actual native loading under Electron. A Node-only test does not establish that a
native module has the product ABI.

## Windows native CLI release input

The Rust tunnel CLI is built separately from Electron's JavaScript CLI. From the
source root, with the bundled Rust toolchain prepared under
`desktop-shell/.build/environments/rust`, run:

```powershell
$env:vs2022_install = 'D:\BuildTools'
$env:OPENSSL_SRC_PERL = 'D:\gpt-workspace\octocode\source\work\cli-build-tools\perl\perl\bin\perl.exe'
& .\maintenance\build-native-cli.ps1
```

`OPENSSL_SRC_PERL` may point to another portable Windows Perl installation.
The tracked helper imports MSVC, selects bundled Rust/LLVM, retains repository
Rust flags and runs `cargo build --locked --release --bin code` in `desktop-shell/cli`.
It builds vendored static OpenSSL and does not require a temporary work script.
CLI source changes must be committed first. It writes
`desktop-shell/cli/target/release/code.exe.build.json` containing the actual
embedded build commit, CLI Git tree, Cargo.lock SHA-256, package version and
executable SHA-256, then verifies the executable's `--version` output.

The desktop stage invokes this helper and reuses a verified current input.
The product copies exactly `bin/octocode-tunnel.exe` beside the installation
executable; both Windows CLI forwarding and remote tunnel service resolve this
location. Packaging rejects a missing CLI, dirty/stale CLI tree, changed lock,
wrong version, or mismatched executable hash. Unrelated documentation commits
do not invalidate the CLI tree or require a rebuild. The embedded commit records
the real build revision; it does not claim to identify a future flattened release.
