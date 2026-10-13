# OctoCode 0.1.10 / desktop 1.132.4 acceptance, 2026-10-13

## Release identity

- GitHub default branch: `master`.
- Windows installer: `D:\gpt-workspace\octocode\releases\OctoCodeSetup-1.132.4.exe`, 1,045,435,971 bytes, SHA-256 `53607C4B929B3F65D38331C2D1625372DB6B4D45894BA8D80BB205723E3511F6`.
- Extension VSIX: `octocode-0.1.10.vsix`, SHA-256 `19E99F99949E9B7C1B4BA02B8C9B7293D81B8A3BACC7BEBA12695E7AA4575B4A`.
- GLM5.3 independently checked the installed version, running Host path, latest cold-start log, acceptance script, and installer hash using the installed headless harness. All of those checks passed.

## Windows installation and runtime

The previous installation was stopped and removed with its native uninstaller. `D:\Program Files\OctoCode` did not exist afterward. The final installer was run with that exact target directory, and its log recorded `Installation process succeeded`. The installed executable reports 1.132.4; the installed extension reports 0.1.10. The `data`, `workspace`, and `environments` junctions point to the single physical `D:\gpt-workspace\octocode\runtime` tree.

The installed `test\self-test.ps1` exited 0. Its Node, npm, pnpm, Python, Rust, MCP, local skills, endpoint, and update-source checks passed. The bundled Rust compiler reports 1.98.0. The production Host ran from the installed 0.1.10 extension directory under the current user. The cold-start log `20261013T234417` had no error, warning, DeprecationWarning, or Canceled entries. `final-acceptance.ps1` exited 0 with `Pass=true`, no failures, project workspace CRUD true, and 14 live OctoCode/Host processes. The app was left running.

The pre-uninstall preservation snapshot contained 4,475 records. All recorded paths still exist after reinstall. Exact hashes of active daemon tokens, logs, databases, and storage changed during startup, so the snapshot's strict byte-for-byte verification did not pass after the running app resumed. No recorded path was missing. The physical runtime was retained because it contains user projects, settings, sessions, and credentials.

## Isolation and API regression

The installed Host's stdin/stdout JSON RPC was exercised in a separate process with an isolated test database and project. Project creation generated its own directory; two chats generated distinct directories; a cross-chat `agent.run` working directory was rejected. Project/session/message/setting/log create, read, update, delete, read-back and post-delete visibility passed. Restart persistence passed and the original test file was preserved. Test fixtures were cleaned. The live desktop Host does not expose an HTTP control port; the installed harness supports headless `--single`, `--model`, and JSON output and successfully reached GLM5.3 without desktop control.

## Source and build verification

- Core type check passed. Full Vitest excluding the Windows symlink suite: 6,168 passed, 23 existing skips, 0 failures. The rules suite had 14 passes and 2 Windows privilege-dependent symlink skips. Combined: 6,182 passes, 25 skips, 0 failures.
- The two symlink cases could not execute under this Windows account because symlink creation returns EPERM without the necessary privilege or Developer Mode.
- The VSIX embedded Host and harness binaries; the desktop build and final Inno installer compiled successfully. The final installer excludes build caches, an incomplete stable Rust toolchain, and three account-backed built-in extensions. The clean installation's self-test confirms their absence.
- Four installed MCP smoke checks passed: code-review-graph (30 tools), llm-wiki (14), scrapling (4), windows-mcp (19). An installed third-party windows-mcp 0.8.8 launcher was patched locally to remove a Python 3.14 deprecation warning; this patch is outside the OctoCode repository and may be overwritten by a third-party update.

## Acceptance limits

No desktop UI control test was run, as requested. Linux and macOS syntax or install runs, and a real Docker Engine run were unavailable on the accessible hosts. WSL is not installed. Do not interpret the Windows headless checks as UI or cross-platform acceptance. The online update endpoint remains a deliberate placeholder (`updates.octocode.invalid`), so online update delivery was not tested. The GLM5.3 harness's prior permission-classifier side query once timed out; the final clean-install regression emitted no stderr warning. The third-party MCP patch and two skipped symlink tests remain known limits.
