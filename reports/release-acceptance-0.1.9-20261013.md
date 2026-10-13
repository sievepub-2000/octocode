# OctoCode 0.1.9 / desktop 1.132.3 acceptance — 2026-10-13

## Verified on this Windows host

- Core project UI tests: 5 passed. OAuth discovery/provider tests: 68 passed. Targeted terminal, runtime, history, and webview handler tests passed; the full Rust host suite passed. Harness thinking fallback tests passed.
- The extension, desktop product, and single-file installer built from the reviewed source. Installer SHA-256: `FFA8E72D99A652EA3DFD99DB8102F24163D468FEB29D3B8D268AB1A9BCB91060`; VSIX SHA-256: `E726B28967AA995583AE7E8EAADA80992C606CA56F02C960E3AEA31211AD2EDC`.
- In-place upgrade returned `preservation: PASS`; the installed host binary matches the build. The restarted desktop shows projects and chats without the manual artifact-index controls.
- Two owned test projects had distinct physical project directories and `artifacts.json` files. Their sessions launched with different project-local, chat-local working directories. Both test chats and database project records were deleted through the UI and verified absent in SQLite.

## Open acceptance findings

- `final-acceptance.ps1` exits 1 on two repeatable cold-start log entries: third-party `windows-mcp` 0.8.8 uses deprecated `asyncio.WindowsSelectorEventLoopPolicy` with bundled Python 3.14; an extension host canceled its MCP tree refresh while a startup window was replaced. Both were traced to their source. The UI remained usable, but the strict log gate is **not passing**.
- The full JavaScript suite did not finish in the available run; targeted suites and build checks did pass. A clean install, stop/removal lifecycle, Linux, macOS, and real Docker Engine run were not executed. No system-wide audit completion is claimed.
- The two owned test project directories still hold archived index files after UI deletion, as the current project-delete behavior specifies. The automatic approval review rejected a guarded recursive removal of those directories; user data outside those fixtures was not touched.

Existing projects and chats created before this release retain their previous working directory until migrated. Per-chat directories limit accidental relative-path overlap; they do not enforce an OS filesystem sandbox for absolute paths.
