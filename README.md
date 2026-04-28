# Octocode

> AI-powered coding assistant runtime — local-first, multi-provider, extensible.

Octocode is a ground-up Rust workspace providing a local AI coding assistant with multi-provider support, session management, tool execution, MCP integration, and both CLI/Desktop/WebUI surfaces.

## Quick Start

```bash
# 1. Build the workspace
cargo build --release -p octocode-cli

# 2. Run your first chat
cargo run -p octocode-cli -- chat demo "explain what this project does"

# 3. Launch the WebUI server
cargo run -p octocode-cli -- serve 999 demo
# → open http://127.0.0.1:999/ui-shell/

# 4. Or launch the desktop app
cargo run -p octocode-cli -- desktop 999 demo
```

> **Windows**: Use `scripts/start-webui.ps1 -Port 999 -SessionId demo`
> **Unix**: Use `scripts/start-webui.sh 999 demo`

WebUI/desktop port is restricted to `990-999`.

## Security model (release-hardening)

Octocode binds the WebUI to `127.0.0.1` only and gates every HTTP/WS request with a bearer token. The token is resolved with the following precedence (T1):

1. `OCTOCODE_BEARER_TOKEN` environment variable — preferred for production / CI.
2. `OCTOCODE_BEARER_TOKEN_FILE` environment variable — points to a file whose first non-empty trimmed line is the token (preferred for desktop installs).
3. Auto-generated 64-char hex secret (printed at startup). Suitable for local development only.

The startup log prints `Auth token: <token> (source: ...)` so operators can confirm which path was used. All API responses now include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a `Content-Security-Policy` that pins script/style/connect to `'self'` + `127.0.0.1` only (T14). CORS is restricted to `http://127.0.0.1` rather than `*`.

Permission modes (`permission_mode` in `octocode.conf`): `read-only`, `workspace-write` (default), `escalated`. Tool execution honours `denied_tools` and the workspace-root `file_guard`.

Config file forward-compatibility: `octocode.conf` now records `config_version=1` (T10). Older configs without the field are read as v0 and upgraded on next save.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     octocode-cli                        │
│            (CLI · Server · Desktop shell)                │
├──────────┬──────────────┬──────────────┬────────────────┤
│ commands │   runtime    │     api      │    plugins     │
│ (parse)  │ (session,    │ (providers,  │ (plugin trait, │
│          │  tools,      │  circuit     │  registry)     │
│          │  workflow,   │  breaker,    │                │
│          │  permissions)│  streaming)  │                │
├──────────┴──────┬───────┴──────────────┴────────────────┤
│      core       │        mcp       │      skills       │
│  (domain types, │  (MCP discovery, │  (skill trait,    │
│   contracts)    │   transport)     │   framework)      │
└─────────────────┴──────────────────┴───────────────────┘
```

**8 crates** — `core` → `api` / `mcp` / `skills` → `runtime` → `commands` → `cli`

## Provider Configuration

Octocode auto-creates `config/octocode.conf` on first run:

```ini
# Octocode config
provider_id=local-openai
provider_base_url=http://localhost:8080/v1
default_model=gpt-4
permission_mode=WorkspaceWrite
history_limit=24
denied_tools=
```

### Supported Providers

| Provider ID     | Kind              | Example Base URL                       |
|----------------|-------------------|----------------------------------------|
| `local-openai` | LlamaCpp / OpenAI-compatible | `http://localhost:8080/v1`           |
| `remote-openai`| OpenAI-compatible | `https://api.openai.com/v1`                       |
| `ollama`       | Ollama            | `http://localhost:11434`                          |
| `linkmind`     | LinkMind          | `http://localhost:8765`                           |
| `gemini`       | OpenAI-compatible | `https://generativelanguage.googleapis.com/v1`    |
| `azure-openai` | OpenAI-compatible | `https://<resource>.openai.azure.com`             |
| `nvidia-free`  | OpenAI-compatible | `https://integrate.api.nvidia.com/v1`             |
| `anthropic`    | Anthropic         | `https://api.anthropic.com`                       |
| `xai`          | xAI               | `https://api.x.ai/v1`                             |
| `openrouter`   | OpenRouter        | `https://openrouter.ai/api/v1`                    |
| `qwen`         | Qwen / DashScope  | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `glm`          | Zhipu GLM         | `https://open.bigmodel.cn/api/paas/v4`            |
| `kimi`         | Moonshot Kimi     | `https://api.moonshot.cn/v1`                      |
| `xiaomi`       | Xiaomi (stream)   | per-deployment                                    |
| `minimax`      | MiniMax           | `https://api.minimax.chat/v1`                     |
| `openai-completion` | Legacy `/v1/completions` | self-hosted gateway                       |
| `stub`         | Stub (fallback)   | —                                                 |

All **17 providers** are described in detail under [`docs/architecture.md`](docs/architecture.md#3-provider-layer).

### Environment Variables

| Variable              | Description                          | Default                    |
|-----------------------|--------------------------------------|----------------------------|
| `OPENAI_API_KEY`      | API key for OpenAI-compatible        | *(none)*                   |
| `OCTOCODE_PROVIDER`   | Override default provider ID         | `local-openai`             |
| `OCTOCODE_BASE_URL`   | Override provider base URL           | *(from config)*            |
| `OCTOCODE_MODEL`      | Override default model name          | *(from config)*            |

### Provider Fallback Chain

Octocode performs health checks and automatically falls back:

```
local-openai → remote-openai → stub
```

Each provider has a circuit breaker that tracks failures, with automatic recovery.

## CLI Commands

| Command | Description |
|---------|-------------|
| `status` | Runtime status overview |
| `doctor` | System diagnostics |
| `providers` | List available providers |
| `routes` | Provider routing configuration |
| `circuit-log` | Provider circuit breaker state |
| `health` | Provider health checks |
| `chat <sid> <text>` | Send a message in a session |
| `prompt <text>` | One-shot prompt |
| `sessions` | List all sessions |
| `session-show <id>` | Show session transcript |
| `session-add <id> <title>` | Create a new session |
| `session-export <path>` | Export sessions to file |
| `tools` | List available tools (67) |
| `tool <name> <input>` | Execute a specific tool |
| `agent <sid> <action>` | Run agent orchestration |
| `workflow <sid> <goal>` | Execute workflow step |
| `repl <sid>` | Interactive REPL mode |
| `serve <port> <sid>` | Start HTTP server |
| `desktop <port> <sid>` | Launch desktop app |
| `--json <cmd>` | JSON output mode |

## Tools (67 built-in)

File operations, code search, shell execution, agent actions, multi-agent coordination (`team-create / team-list / team-delete / team-status / agent-message / subagent-spawn / subagent-list / subagent-status`), persistent todos (`todo-add / todo-list / todo-done`), task lifecycle (`task-submit / task-list / task-get`), memory v2 (`memory-save / memory-read / memory-list / memory-search / memory-delete`), worktree controls (`worktree-enter / worktree-exit`), web (`web-search / web-browse / fetch-readable / html-to-markdown / http-get / http-post / json-query`), notebook (`notebook-edit`), LSP hover (`lsp-hover`), git (`git-status / git-diff / git-log / git-commit / git-branch`), and more. All file tools enforce workspace-root path security via `runtime/file_guard.rs`.

```bash
# Read a file
cargo run -p octocode-cli -- tool read-file src/main.rs

# Search codebase
cargo run -p octocode-cli -- tool search "TODO"

# List files
cargo run -p octocode-cli -- tool list-files src/
```

## Development

```bash
# Run all tests (336+ unit, 0 failed at last release gate)
cargo test --workspace --no-fail-fast

# Run clippy (0 warnings policy)
cargo clippy --workspace -- -D warnings

# Run E2E tests (requires running server)
cargo test --workspace -- --ignored
```

## Project Structure

```
octocode/
├── crates/
│   ├── octocode-core/       # Domain types, contracts, error types
│   ├── octocode-api/        # Provider registry, HTTP client, streaming
│   ├── octocode-mcp/        # MCP discovery and transport
│   ├── octocode-skills/     # Skill trait and framework
│   ├── octocode-plugins/    # Plugin system
│   ├── octocode-runtime/    # Session, tools, permissions, workflows
│   ├── octocode-commands/   # CLI command parsing (27 commands)
│   └── octocode-cli/        # Entry point: CLI, server, desktop
├── ui-shell/                # Canvas-rendered WebUI workbench
├── config/                  # Auto-created runtime config
├── scripts/                 # Build, deploy, test scripts
└── docs/                    # Planning and documentation
```

## Principles

1. Keep feature parity work explicit and testable.
2. Separate stable runtime contracts from UI shells and integrations.
3. Treat Windows and macOS as first-class platforms.
4. Prefer mature implementations and constrained refactoring over speculative rewrites.

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
13. `scripts/package-linux-installer.sh`
14. `scripts/test-regression.ps1`

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
11. The terminal, provider, settings summary, tool shell, and composer summary surfaces now consume the unified runtime snapshot plus `/api/events` feed rather than reconstructing provider/runtime state inside the UI shell
12. The composer now routes slash-commands such as `/snapshot`, `/events`, `/read`, `/list`, `/tool`, `/plan`, `/search`, and `/reload` into the same runtime snapshot/event surface used by the CLI and HTTP APIs
13. The composer also supports simple multi-step slash pipelines like `/read README.md | list .`, which are normalized into a structured `pipe` command response with per-step timing
14. The terminal pane now exposes `events`, `state`, and `workflow` views, all derived from the same unified snapshot plus event feed surface

To preview the current shell:

1. `cargo run -p octocode-cli -- chat demo "hello octocode"`
2. `cargo run -p octocode-cli -- serve 999 demo`
3. or `./scripts/start-webui.ps1 -Port 999 -SessionId demo`
4. or `cargo run -p octocode-cli -- desktop 999 demo`
5. For browser-based verification only, open `http://127.0.0.1:999/ui-shell/`
6. To emit a runnable desktop bundle directory, run `./scripts/package-desktop.ps1` on Windows or `./scripts/package-desktop.sh` on Unix-like systems
7. To emit a Windows installer EXE, run `./scripts/package-windows-installer.ps1`
8. To prepare the macOS installer path on a macOS host, run `./scripts/package-macos-installer.sh`
9. To prepare the Linux installer tarball path on a Linux host, run `./scripts/package-linux-installer.sh`
10. The generated Windows installer supports silent installation with `Octocode-<version>-windows-x64-setup.exe /Q:A`
11. The default Windows install target is `%LOCALAPPDATA%\Programs\Octocode\<version>`
12. To run the full HTTP/WebUI regression suite against a live server, run `powershell -ExecutionPolicy Bypass -File .\scripts\test-regression.ps1 -Port 991 -Session demo`
13. The regression suite now also checks `/api/timeline`, structured `pipe` responses, and workflow timeline rendering hooks in `ui-shell/app.js`

## Provider note

The default local provider target is currently `http://192.168.110.2:8000/v1` with `gemma-4-31b-it-q8-prod`. Octocode now performs provider health checks and automatically falls back from `local-openai` to `remote-openai` and finally `stub` when the preferred endpoint times out or becomes unavailable. The runtime snapshot also exports provider route state, provider circuit state, recent failure reason, open/half-open/recovered timestamps, active session state, tool descriptors, and a unified runtime event feed so the CLI `snapshot --json`, HTTP surface, WebUI, and desktop shell all observe the same runtime state.

## Agent action note

`octocode-cli agent` and the `agent-action` tool now run through a real session-scoped runtime orchestration path. The runtime appends an agent request, builds a workflow scaffold, optionally gathers local read-only observations from inline directives such as `search ...`, `read ...`, and `list ...`, then dispatches a provider prompt. If the provider is unavailable, the runtime emits a local fallback action summary instead of dropping back to a stub string.

The agent path now also supports session-aware workspace plans, chained local directives like `chain list ui-shell => read README.md`, and provider-strategy summaries so local orchestration remains inspectable before provider dispatch.
