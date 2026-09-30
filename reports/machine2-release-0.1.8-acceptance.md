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
| Daemon lifecycle and real Windows Electron tests | 22 passed after the detached-child repair |
| HTTP API tests | 22 passed |
| Native Host offline release tests | Latest run: 90 tests and 9 supervision scenarios passed |
| Bundled MCP smoke | Three installed services passed |
| Installed API/native supported lifecycle | Routine create/read/restart/delete/post-delete; goal create/read/exhaust/restart/resume/met/restart passed in isolated stores using real installed Host/harness and a controlled HTTP model |
| Native permission probes | Six write cases and 16 read cases passed against the declared permission contract |
| Installed MCP lifecycle | Wiki page update/restart, code graph incremental update/delete/restart, and Scrapling local HTTP/browser/update/404/restart exercised with isolated fixtures and cleanup |

The installed API lifecycle used port 8776 and isolated temporary roots, not production user records. The HTTP API has no routine-update or goal-update/delete contract; these operations were not invented or claimed tested. Wiki has no advertised delete/archive operation; fixture file removal is cleanup rather than a successful MCP delete test. MCP tests do not cover every tool or external cloud integration.

Review and Directory permission modes currently implement an explicitly labelled read-only fallback; Directory does not promise read isolation. Full permits unrestricted automatic tools. The native probes verify that current contract, not an unimplemented filesystem sandbox.

Evidence: `isolated-installed-api-lifecycle.json`, `bundled-mcp-lifecycle-findings.md`, `mcp-lifecycle-latest.json`, native permission reports, and the corresponding saved test logs.

## Build reproducibility and artifacts

Latest-only build inputs and extension dependency trees were restored from machine 3; obsolete entire workspaces were not copied. A dependency archive comparison verified 4,024 nested/shared input files. Stale derived TypeScript build caches were backed up and reset; fresh and warm HTML server typechecks passed. Product and system installer builds passed. The final VSIX was extracted and its native binaries matched the freshly rebuilt originals; final packaging cannot reuse a stale VSIX cached only by JavaScript output.

Final installer SHA-256: `D27B46DC138D30A7DCACF6FE8748F2B9B6AE56A20E0B0E98D2E35FF6ED1984D5` (740,500,291 bytes).

Latest VSIX SHA-256: `20a1650c66c5a888e3e5c4dd90f36921551e79d16a77ed0aa72fe8ac2c7338a7`. It contains Host SHA-256 `436df1e94637aaee9bddd599eca89f1071bbf1c11e5f0a532649839dc1b58c72`; the final installer above includes this package.

The small documentation GIF is an ordinary Git object, eliminating the missing LFS-object dependency for new checkouts. Production data, credentials, native build outputs and dependency caches are excluded from aggregate source publication.

## Alibaba review coverage and remaining acceptance

The official `alibaba/open-code-review` CLI 1.12.11 was installed and used for completed bounded reviews. Findings were adjudicated against actual source and executed regressions; three accepted native defects were repaired: atomic checkpoint initialization, requested worktree base revision, and preservation of a newer schema marker when rejecting an unsupported database.

Full CLI inventories and selected-file counts are not completed review counts. Large scans encountered provider timeout, empty output and budget exhaustion. The coverage ledger records actual completed paths and failed/interrupted attempts. No whole-repository AI all-clear is claimed.

Production restart/cold-start acceptance and clean installation/removal lifecycle are recorded below. Restored production acceptance passed: desktop 1.132.2 / extension 0.1.8 binary identities, effective production profile, five UI checks, exact existing-profile model reply `OCTOCODE_MACHINE2_RESTORED_FINAL_OK`, owned marker deletion/read-back, and preservation of the four original sessions. Current startup logs had zero counted errors/warnings; production remains visible and idle. Evidence: `restored-production-final-acceptance-20261001.json`. Final default-branch remote publication verification remains pending at this report revision. Windows is the documented desktop distribution. No Linux/macOS deployment or real Docker Engine execution was performed. Installed self-test reports optional toolchains/WSL as on-demand and not provisioned, and online shell updates currently use a placeholder endpoint; successful local installation does not certify automatic online updates.

## Follow-up acceptance and investigation

- Normal application quit through the native host service stopped desktop and daemon processes. A genuine cold start created a new daemon, retained the disabled test routine, and allowed its safe deletion with post-delete read-back. The production UI then returned `OCTOCODE_MACHINE2_COLDSTART_OK` using the existing profile; five pane checks passed again. Evidence: `production-normal-quit-proof.json`, `production-api-cold-start-recovery.json`, and the cold-start UI/model reports. An earlier orchestration wait expired while the app was down; its retained fixture was recovered and cleaned, not ignored.
- Real native application relaunch exposed a separate defect: non-detached Windows children died with Electron. Production PID/token preservation failed before the fix. The source repair now detaches the Windows child and unrefs it during restart. Actual Electron 42.7.1 regressions independently reproduced non-detached death and detached survival. Final-installer production relaunch preserved daemon PID/token and the test routine; the new desktop logged successful reattachment. An inherited audit-only CDP socket prevented immediate renderer attachment, independently reproduced in an isolated Electron fixture. After normal shutdown and cold recovery on a different debug port, the exact session/message baseline, model reply `OCTOCODE_MACHINE2_FINAL_0604_OK`, and all five pane checks passed. Three owned marker sessions were deleted with absence read-back; four pre-existing user sessions remained unchanged. Evidence: `repaired-native-relaunch-observed-20261001-055104.json`, `native-session-exact-readonly-before-next-relaunch.json`, `production-ui-final-recovered-0604/report.json`, and `owned-marker-session-cleanup-0604.json`. Session read-back followed cold recovery, not immediate relaunch.
- A publication-time HTTP test once exceeded its 15-second shutdown deadline. Subsequent bounded diagnosis could not reproduce it; full 22-test suites passed for the export, installed API bytes and an actual network clone. The original intermittent failure remains documented; no speculative API retry or timeout change was made. Evidence: `http-persistence-shutdown-diagnosis.md`, `final-api-shutdown-validation.json`.
- Additional native review found four concrete defects, repaired with red/green tests: malformed advisor settings lacked a terminal error, real HEAD-named remote branches were hidden, relative worktree removal used the wrong directory, and failed project insertion left an index. Omitted supervision defaults were also aligned with the declared 3/30 defaults. The new release build passed with 90 tests and 9 supervision scenarios.
- Clash was rechecked without editing subscriptions: effective TUN enabled, active Meta adapter/default route, service running, all nine subscription/companion hashes matched their source manifest, Google HTTPS 204, GitHub HTTPS 200, expected unauthenticated OpenAI HTTPS 401, and explicit mixed-port GitHub proxy 200. Evidence: `C:\Users\FPP\Downloads\clash-verification.json`.
- The older installer and latest alias were discovered to share a hard link. The old 1.132.1 artifact was recovered read-only from machine 3 and verified at 736,842,327 bytes, SHA-256 `7EB061762F6A08CA018829F23DC62732641918BF93FDA08EBDF660AA0FDB5FD9`. It is now an independent file. Local promotion stages and verifies a new file before replacing its name, so future publication cannot truncate older hard-linked releases.
- Real installer lifecycle used the documented default path after preserving original application/runtime roots. Fresh 1.132.1 installation, authenticated installed daemon/UI health, normal stop, restart persistence, actual upgrade to final 1.132.2, upgraded health/persistence, uninstall, retained workspace sentinel and read-only session/message database integrity passed. Original roots, ACL/junction/critical-file fingerprint and installer registration were restored; production remained stopped for final controlled startup. Two audit-helper defects were corrected: post-uninstall read-back must address retained physical runtime rather than the removed app junction, and successful reg.exe stderr must be classified by exit status. These are retained in the evidence rather than concealed as an uninterrupted first-pass run. Evidence: `D:\gpt-workspace\octocode\migration\lifecycle-private-20261001-061250\state.json` and the associated installer/health/persistence/read-back logs.
