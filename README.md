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
13. `octocode-cli workflow <session-id> <goal>`
14. `octocode-cli agent <session-id> <action>`
15. `octocode-cli repl <session-id> "status|health|providers|tools|workspace|commands|doctor|circuit-log|sessions"`
16. `octocode-cli circuit-log`
17. `octocode-cli routes`
18. `octocode-cli snapshot <session-id>`
19. `octocode-cli events <session-id>`
20. `octocode-cli ui-export ui-shell/data/app-state.json <session-id>`
21. `octocode-cli --json <command>` for machine-readable output
22. `octocode-cli serve <port> <session-id>` for the local backend workbench server
23. `octocode-cli desktop <port> <session-id>` for the embedded Wry desktop shell

## Local deployment

Current local deployment and bootstrap documentation lives in:

1. `docs/deployment.md`
2. `docs/current-implementation-status.md`
3. `docs/composer-ime-evaluation.md`
4. `docs/desktop-distribution.md`
5. `scripts/start-local.ps1`
6. `scripts/start-local.sh`
7. `scripts/start-webui.ps1`
8. `scripts/start-webui.sh`
9. `scripts/package-desktop.ps1`
10. `scripts/package-desktop.sh`
11. `scripts/package-windows-installer.ps1`
12. `scripts/package-macos-installer.sh`

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
7. Canvas-rendered sidebar, message list, command preview, workspace summary, tool runner shell, settings summary list, terminal viewer, and composer shell
8. Native text inputs remain only as the input layer for composer/settings/tool controls until IME-safe textarea replacement is validated
9. Menu labels and placeholders can be translated through built-in locale files under `ui-shell/locales/` or a runtime locale plugin override
10. The View > Language menu ships with four built-in locales: English, Japanese, Korean, and Chinese
11. The terminal and provider surfaces now consume the unified runtime snapshot plus `/api/events` feed rather than reconstructing provider/runtime state inside the UI shell

To preview the current shell:

1. `cargo run -p octocode-cli -- chat demo "hello octocode"`
2. `cargo run -p octocode-cli -- serve 999 demo`
3. or `./scripts/start-webui.ps1 -Port 999 -SessionId demo`
4. or `cargo run -p octocode-cli -- desktop 999 demo`
5. For browser-based verification only, open `http://127.0.0.1:999/ui-shell/`
6. To emit a runnable desktop bundle directory, run `./scripts/package-desktop.ps1` on Windows or `./scripts/package-desktop.sh` on Unix-like systems
7. To emit a Windows installer EXE, run `./scripts/package-windows-installer.ps1`
8. To prepare the macOS installer path on a macOS host, run `./scripts/package-macos-installer.sh`

## Provider note

The default local provider target is currently `http://192.168.110.2:8000/v1` with `gemma-4-31b-it-q8-prod`. Octocode now performs provider health checks and automatically falls back from `local-openai` to `remote-openai` and finally `stub` when the preferred endpoint times out or becomes unavailable. The runtime snapshot also exports provider route state, provider circuit state, recent failure reason, open/half-open/recovered timestamps, and a unified runtime event feed so the CLI, HTTP surface, WebUI, and desktop shell all observe the same breaker state.

## Agent action note

`octocode-cli agent` and the `agent-action` tool now run through a real session-scoped runtime orchestration path. The runtime appends an agent request, builds a workflow scaffold, optionally gathers local read-only observations from inline directives such as `search ...`, `read ...`, and `list ...`, then dispatches a provider prompt. If the provider is unavailable, the runtime emits a local fallback action summary instead of dropping back to a stub string.

The agent path now also supports session-aware workspace plans, chained local directives like `chain list ui-shell => read README.md`, and provider-strategy summaries so local orchestration remains inspectable before provider dispatch.

