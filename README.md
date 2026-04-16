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
- `ui-shell` - canvas-rendered interactive workbench over local backend APIs, wrapped by an embedded desktop shell

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
15. `octocode-cli serve <port> <session-id>` for the local backend workbench server
16. `octocode-cli desktop <port> <session-id>` for the embedded Wry desktop shell

## Local deployment

Current local deployment and bootstrap documentation lives in:

1. `docs/deployment.md`
2. `docs/current-implementation-status.md`
3. `scripts/start-local.ps1`
4. `scripts/start-local.sh`
5. `scripts/start-webui.ps1`
6. `scripts/start-webui.sh`

## Current scope note

This repository is still in the staged refactor phase. It now includes a real OpenAI-compatible provider client, provider health checks with automatic local/remote/stub fallback, file-backed runtime workflow, local config writeback, a canvas-rendered workbench shell, and a Wry-based embedded desktop surface. The full Claw Code / Claude Code feature surface, MCP parity, plugin parity, and provider breadth are not complete yet. The current goal is to keep the runtime core, provider path, canvas workbench, and desktop shell verifiable while the richer integrations are built incrementally.

## UI shell notes

The current `ui-shell` follows these interface constraints:

1. A traditional macOS-style top menu bar and window chrome
2. A VS Code-like left activity rail and explorer sidebar
3. A centered conversation/editor surface
4. A right-top workspace and settings pane
5. A right-bottom integrated terminal area
6. Direct local backend calls for chat, tool execution, settings writeback, and command palette actions

To preview the current shell:

1. `cargo run -p octocode-cli -- chat demo "hello octocode"`
2. `cargo run -p octocode-cli -- serve 999 demo`
3. or `./scripts/start-webui.ps1 -Port 999 -SessionId demo`
4. or `cargo run -p octocode-cli -- desktop 999 demo`
5. For browser-based verification only, open `http://127.0.0.1:999/ui-shell/`

## Provider note

The default local provider target is currently `http://192.168.110.2:8000/v1` with `gemma-4-31b-it-q8-prod`. Octocode now performs provider health checks and automatically falls back from `local-openai` to `remote-openai` and finally `stub` when the preferred endpoint times out or becomes unavailable. The workbench surfaces that fallback state through provider health badges, terminal logs, and session transcript entries.

