# Machine 2 release acceptance: OctoCode 0.1.8 / desktop 1.132.2

Verified on Windows machine `ZILLAFAN80`, `192.168.10.2`, account `FPP`, 2026-10-01. This report distinguishes executed acceptance from untested scope. Local evidence is stored under `D:\gpt-workspace\machine2-migration`; private credentials and user records are excluded from GitHub.

## Installed repair and production identity

The installed executable is `D:\Program Files\OctoCode\OctoCode.exe`. Its `data`, `workspace`, and `environments` junctions resolve to the respective physical directories in `D:\gpt-workspace\octocode\runtime`. Actual desktop, native Host/harness, and daemon executable identities were inspected; all observed product processes run as FPP. Isolated write/read-back fixtures in the production data, workspace and extension storage were removed in `finally` and post-delete absence was verified.

The effective renderer profile is `D:\Program Files\OctoCode\data\user-data`, with its own settings resource and current log session verified through the running renderer. The active installed extension is 0.1.8. Production daemon discovery verified one authenticated installed listener on loopback port 8765 and the authoritative physical store. A read-only x64 PEB inspection independently verified the daemon working directory and the absence of selected STATE/STORE/HARNESS environment overrides. This does not read Python module globals: resolving STATE from the inspected installed source and observed STORE remains an inference.

The production system installer completed with exit code 0; binary hashes, native junction targets and installation registration matched the release. An earlier attempted install rolled back because audit helpers were using bundled Python. Those helpers were stopped and the successful retry used native SSH; both logs are retained.

## Terminal and model acceptance

Installed isolated-profile and actual production-profile UI checks each exercised five cases: restore workbench layout, open execution terminal, show OctoCode output, show Window log, and return to terminal. All cases passed. Terminal/output/log editors remained in the fixed lower-right group; no separate bottom output panel or captured UI errors appeared.

The old automatically resumed task was explicitly cancelled under the user's authorization. A new task submitted through the production UI, using the existing persisted `Qwen38-flash-next` profile, returned the exact requested `OCTOCODE_MACHINE2_ACCEPTANCE_OK` reply. The running control disappeared and the ordinary send control returned. Credentials were not exported or changed. Absence of tool execution was requested in the prompt; this individual UI proof does not independently audit every native tool event.

Evidence: `native-upgrade-0.1.8.json`, `live-production-identity.json`, `production-daemon-process-identity.json`, `production-ui-final-018/report.json`, `installed-ui-final-018-r3/report.json`, and `production-model-ui-proof.json`.

## Executed checks

| Scope | Actual result |
| --- | --- |
| Core full test suite | 6,051 passed, 23 skipped; 386 files passed, 6 skipped |
| Core workspace type and lint checks | 11 packages passed each |
| Desktop terminal/layout browser regressions | 13 passed |
| Daemon lifecycle tests | 18 passed |
| HTTP API tests | 22 passed |
| Native Host offline release tests | 82 tests and 8 supervision scenarios passed |
| Bundled MCP smoke | Three installed services passed |
| Installed API/native supported lifecycle | Routine create/read/restart/delete/post-delete; goal create/read/exhaust/restart/resume/met/restart passed in isolated stores using real installed Host/harness and a controlled HTTP model |
| Native permission probes | Six write cases and 16 read cases passed against the declared permission contract |
| Installed MCP lifecycle | Wiki page update/restart, code graph incremental update/delete/restart, and Scrapling local HTTP/browser/update/404/restart exercised with isolated fixtures and cleanup |

The installed API lifecycle used port 8776 and isolated temporary roots, not production user records. The HTTP API has no routine-update or goal-update/delete contract; these operations were not invented or claimed tested. Wiki has no advertised delete/archive operation; fixture file removal is cleanup rather than a successful MCP delete test. MCP tests do not cover every tool or external cloud integration.

Review and Directory permission modes currently implement an explicitly labelled read-only fallback; Directory does not promise read isolation. Full permits unrestricted automatic tools. The native probes verify that current contract, not an unimplemented filesystem sandbox.

Evidence: `isolated-installed-api-lifecycle.json`, `bundled-mcp-lifecycle-findings.md`, `mcp-lifecycle-latest.json`, native permission reports, and the corresponding saved test logs.

## Build reproducibility and artifacts

Latest-only build inputs and extension dependency trees were restored from machine 3; obsolete entire workspaces were not copied. A dependency archive comparison verified 4,024 nested/shared input files. Stale derived TypeScript build caches were backed up and reset; fresh and warm HTML server typechecks passed. Product and system installer builds passed. The final VSIX was extracted and its native binaries matched the freshly rebuilt originals; final packaging cannot reuse a stale VSIX cached only by JavaScript output.

Installer SHA-256: `D5165AEC6C9CAFFFAE8086DAB81D2FF79385DF30E3455D409805C032FFF06481`.

VSIX SHA-256: `9dd16f284cee161461c67089203827c0dccb46ae1aaf16ff2c785e12e3c5c562`.

The small documentation GIF is an ordinary Git object, eliminating the missing LFS-object dependency for new checkouts. Production data, credentials, native build outputs and dependency caches are excluded from aggregate source publication.

## Alibaba review coverage and remaining acceptance

The official `alibaba/open-code-review` CLI 1.12.11 was installed and used for completed bounded reviews. Findings were adjudicated against actual source and executed regressions; three accepted native defects were repaired: atomic checkpoint initialization, requested worktree base revision, and preservation of a newer schema marker when rejecting an unsupported database.

Full CLI inventories and selected-file counts are not completed review counts. Large scans encountered provider timeout, empty output and budget exhaustion. The coverage ledger records actual completed paths and failed/interrupted attempts. No whole-repository AI all-clear is claimed.

Production restart/cold-start acceptance, clean installation/removal lifecycle, and final remote publication verification are being recorded separately and must be appended before being declared passed. Windows is the documented desktop distribution. No Linux/macOS deployment or real Docker Engine execution was performed. Installed self-test reports optional toolchains/WSL as on-demand and not provisioned, and online shell updates currently use a placeholder endpoint; successful local installation does not certify automatic online updates.
