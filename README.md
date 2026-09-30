# OctoCode

OctoCode is a Windows desktop coding agent maintained as one product across four source trees.

## 0.1.8 / desktop 1.132.2

This release fixes terminal restoration after migration and routes terminal execution and diagnostic output to the fixed lower-right pane. Explicit model cancellation preserves its cancellation identity without being reported as a provider failure. Daemon startup validates the live service identity and authenticated attachment; desktop restarts preserve active daemon sessions.

Machine 2 uses `D:\Program Files\OctoCode` for executable installation and `D:\gpt-workspace\octocode\runtime` for persistent data, workspaces and environments. Credentials must be imported through OctoCode so Windows encrypts them for the destination account. Release validation and remaining limitations are recorded in `reports/`.

## Repository layout

- `desktop-shell/` contains the desktop shell and bundled desktop extensions.
- `octo-harness/` contains the native agent runtime and command-line services.
- `octocode-core/` contains the OctoCode extension, provider integrations, workbench services, and webview UI.
- The repository root contains the Windows build, installer, maintenance, and verification scripts that assemble those components.

The source trees are developed independently and are exported into this repository without build outputs, runtime data, caches, credentials, or nested Git metadata.

## Build and installation

See [`WINDOWS-INSTALL-UPDATE.md`](WINDOWS-INSTALL-UPDATE.md) for the supported Windows build and installation workflow.

## Licensing

Each component retains its own license and third-party notices. Review the license files inside `desktop-shell/`, `octo-harness/`, and `octocode-core/` before redistribution.
