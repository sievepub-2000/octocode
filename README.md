# Octocode

Octocode is a ground-up refactor target inspired by the current Claw Code runtime shape.

This repository is being structured around four principles:

1. Keep feature parity work explicit and testable.
2. Separate stable runtime contracts from UI shells and integrations.
3. Treat Windows and macOS as first-class platforms.
4. Prefer mature implementations and constrained refactoring over speculative rewrites.

The initial workspace layout is intentionally small:

- `crates/octocode-core` - shared contracts and domain types
- `crates/octocode-api` - provider-facing model integration layer
- `crates/octocode-commands` - CLI command parsing and command intent surface
- `crates/octocode-runtime` - session, tools, permissions, workflows
- `crates/octocode-cli` - the local CLI shell over the runtime
- `ui-shell` - minimal VS Code-inspired static WebUI shell over exported runtime state

Detailed planning lives under `docs/`.

## Current executable surface

The current repository already provides a locally runnable baseline:

1. `octocode-cli status`
2. `octocode-cli doctor`
3. `octocode-cli providers`
4. `octocode-cli commands`
5. `octocode-cli sessions`
6. `octocode-cli session-show <id>`
7. `octocode-cli session-add <id> <title>`
8. `octocode-cli chat <session-id> <text>`
9. `octocode-cli session-export <path>`
10. `octocode-cli tools`
11. `octocode-cli tool read-file <path>`
12. `octocode-cli tool write-file "path|content"`
13. `octocode-cli ui-export ui-shell/data/app-state.json <session-id>`
14. `octocode-cli --json <command>` for machine-readable output

## Local deployment

Current local deployment and bootstrap documentation lives in:

1. `docs/deployment.md`
2. `docs/current-implementation-status.md`
3. `scripts/start-local.ps1`
4. `scripts/start-local.sh`
5. `scripts/start-webui.ps1`
6. `scripts/start-webui.sh`

## Current scope note

This repository is still in the staged refactor phase. It now includes a minimal WebUI shell with a VS Code-like layout, but the full Claw Code / Claude Code feature surface, Canvas shell, MCP parity, plugin parity, and provider breadth are not complete yet. The current goal is to keep the runtime core and exported UI state verifiable while the richer desktop shell and integrations are built incrementally.

