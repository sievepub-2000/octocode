# Octocode Modules — Reference (English)

This document is the consolidated reference for every module in the
Octocode workspace. Each section covers what the module owns, what it
deliberately does **not** own, and how to exercise it. Code paths are
relative to the repository root.

## Layering

Octocode follows a strict, one-direction dependency graph. Lower
layers do not import higher ones. This is enforced by `Cargo.toml`
membership and by the runtime layering rules in `CLAUDE.md`.

```
octocode-core   ── stable domain types, contracts, capability surface
   ▲
octocode-api    ── provider wire behavior (HTTP, auth, streams)
   ▲
octocode-runtime── sessions, permissions, routing orchestration
   ▲
octocode-cli    ── parsing, renderers, transport boot, shell entry
   ▲
ui-shell, desktop, VS Code, Cline, Cursor — consume runtime events
                                            and snapshots only
```

---

## Crate: `octocode-core`

Path: `crates/octocode-core`

Owns the **stable domain types and contracts** that every higher layer
consumes:

- Provider capability surface and provider factory contract.
- Permission policy contract (`read-only`, `workspace-write`,
  `danger-full-access`).
- Tool catalog contract.
- Session, workspace, and message types.
- The `UiSnapshot` struct exposed over `/api/state` (including the
  `stub_fallback_active` field added in v2026.4.29).

Does **not** own: HTTP, file IO, provider-specific payload shapes,
permission enforcement.

Build: `cargo check -p octocode-core`.

---

## Crate: `octocode-api`

Path: `crates/octocode-api`

Owns the **provider wire behavior**: base URL resolution, authentication
header composition, request payload assembly, streaming SSE parsing, and
circuit-aware adapter composition. The crate is a fan-out of one Rust
module per provider family (`anthropic`, `openai`, `gemini`, `xai`,
`openrouter`, `glm`, `kimi`, `qwen`, `minimax`, `nvidia`, `xiaomi`).

The Anthropic adapter (v2026.4.29+) reads keys in this order:

1. `ANTHROPIC_API_KEY`
2. `OCTOCODE_ANTHROPIC_API_KEY`
3. `ANTHROPIC_AUTH_TOKEN`

Both `x-api-key` and `Authorization: Bearer` headers are sent on the
same request to maximise compatibility with third-party gateways.

Does **not** own: session storage, permission enforcement, default model
selection.

Build / test: `cargo check -p octocode-api`.

---

## Crate: `octocode-runtime`

Path: `crates/octocode-runtime`

Owns the orchestration layer:

- Session persistence (`rusqlite`, default path
  `%APPDATA%\octocode\sessions.db` on Windows).
- Permission enforcement at the tool boundary.
- Provider routing: pick the configured provider, fall back to a local
  stub if every provider is unhealthy, and surface that state via
  `UiSnapshot.stub_fallback_active`.
- Tool registry usage (the registry itself lives in `octocode-core`).
- Config path materialization: locating, reading, and writing
  `config.json`.
- Platform shell execution: PowerShell 7 → Windows PowerShell 5.1 →
  `cmd` fallback on Windows; `bash`/`zsh` on macOS/Linux.

Does **not** own: HTTP transport, CLI parsing, UI rendering.

Build / test: `cargo check -p octocode-runtime`.

---

## Crate: `octocode-cli`

Path: `crates/octocode-cli`

Owns the CLI entrypoints and the WebUI HTTP server bootstrap:

- `octocode-cli serve <port> <session>` — launches the WebUI on the
  given port with the given default session id.
- `octocode-cli chat`, `octocode-cli ask`, `octocode-cli doctor`, and
  the `manage` family of subcommands.
- Static-asset serving for `ui-shell/` and `help/` content.
- Argument parsing via `clap`.
- Console renderers (Markdown, JSON, plain).

Does **not** own: provider behavior, session storage, tool execution.

Quick start:

```powershell
$env:CARGO_HOME='C:\Users\<you>\vscode-workspace\.cargo'
$env:PATH = "C:\Users\<you>\vscode-workspace\.cargo\bin;$env:PATH"
.\scripts\octocode-up.ps1 -Port 999 -SessionId main
# WebUI ready at http://127.0.0.1:999/ui-shell/?session=main
```

---

## Crate: `octocode-commands`

Path: `crates/octocode-commands`

Owns the slash-command catalog used by the WebUI composer and the CLI
chat surface. Each command is a small declarative entry: name, scope,
required permission, help text, expansion template.

Add a command by appending to `commands.toml` (or the equivalent
JSON catalog); no runtime change is needed unless the command requires
a new tool.

---

## Crate: `octocode-mcp`

Path: `crates/octocode-mcp`

Owns the Model Context Protocol bridge. Discovers MCP servers declared
in workspace and user config, negotiates the transport (stdio /
streamable-http), and surfaces them through the runtime tool registry
and the Manage → MCP panel in the WebUI.

---

## Crate: `octocode-skills`

Path: `crates/octocode-skills`

Owns the skill catalog: discovery of `SKILL.md` files in
`skills/`, validation of frontmatter, and exposure of skills to the
runtime so prompts can be augmented at session start. Skills are
**instruction overlays**, not executable plugins.

---

## Crate: `octocode-plugins`

Path: `crates/octocode-plugins`

Owns the optional plugin loader that lets external tools register
themselves with the runtime tool registry without modifying core code.
The plugin contract is the same `tool catalog contract` exposed by
`octocode-core`.

---

## Crate: `octocode-gateway`

Path: `crates/octocode-gateway`

Owns the optional reverse-proxy / fan-out gateway for hosting
Octocode behind a single endpoint (e.g. on a developer workstation
shared by a small team). It is **not** required for single-machine
use and is disabled by default.

---

## Crate: `octocode-mock-provider`

Path: `crates/octocode-mock-provider`

Owns the offline, deterministic provider used by the runtime stub
fallback and by the integration tests. When every real provider is
unhealthy, the runtime routes a session through this crate so that the
UI continues to function and the user receives a clearly-labelled stub
echo (see `UiSnapshot.stub_fallback_active`).

---

## Surface: WebUI shell (`ui-shell/`)

Pure browser code. Single-page vanilla JavaScript that consumes the
runtime over HTTP:

- `GET /api/state?session=<id>` — full snapshot, including
  `stub_fallback_active` and `providerHealths`.
- `POST /api/chat` — non-streaming send.
- `GET /api/stream?session=<id>&text=<urlencoded>` (Bearer auth on
  multi-machine deployments) — Server-Sent Events stream of tokens.
- `POST /api/settings` — provider, base URL, default model,
  permission, history limit.
- `GET /api/manage/catalog` — providers, models, MCP servers, skills,
  hooks, tools, commands.

Markdown rendering uses `marked` 12 with `highlight.js` 11 for code
blocks and `KaTeX` 0.16 for `$...$` / `$$...$$` math. The default
locale is **English**; `View → Language` switches to `ja-JP`,
`ko-KR`, or `zh-CN` at runtime.

The Help menu maps to dedicated right-panel sections:

- License — full text of Apache License 2.0.
- Release Notes — `docs/release-notes-2026-04-29.md`.
- Privacy Statement — `docs/PRIVACY.md`.
- Check for Updates — queries the GitHub Releases API for
  `sievepub-2000/octocode`.
- Contact Author — `sievepub@outlook.com`.
- About — module list, third-party acknowledgements, link to
  `docs/modules/index.md`.

---

## Surface: Desktop packaging

Scripts: `scripts/package-desktop.ps1`, `scripts/package-desktop.sh`,
`scripts/package-windows-installer.ps1`,
`scripts/package-linux-installer.sh`,
`scripts/package-macos-installer.sh`.

Each script wraps `cargo build --release -p octocode-cli`, copies
`ui-shell/` and `help/` next to the binary, and produces a platform
artifact. The Windows path has been actively validated in this release.

---

## Operations: Quick start

```powershell
git clone https://github.com/sievepub-2000/octocode.git
cd octocode
$env:CARGO_HOME='C:\Users\<you>\vscode-workspace\.cargo'
$env:PATH="C:\Users\<you>\vscode-workspace\.cargo\bin;$env:PATH"
cargo build --release -p octocode-cli
.\scripts\octocode-up.ps1 -Port 999 -SessionId main -NoBuild
# open http://127.0.0.1:999/ui-shell/?session=main
```

To stop:

```powershell
.\scripts\octocode-down.ps1 -All
```

## Operations: Provider configuration

Provider id, base URL, default model, permission mode, and history
limit are configured under Manage → Settings or via `POST
/api/settings`. The most common provider id values are:

| Provider id | Default base URL | Notes |
| --- | --- | --- |
| `anthropic` | `https://api.anthropic.com/` | Override via `ANTHROPIC_BASE_URL` |
| `openai` | `https://api.openai.com/v1/` | Override via `OPENAI_BASE_URL` |
| `gemini` | `https://generativelanguage.googleapis.com/` | |
| `openrouter` | `https://openrouter.ai/api/v1/` | |
| `local-openai` | user-supplied | OpenAI-compatible local servers |
| `stub` | (n/a) | offline echo |

## Operations: Permissions & sandboxing

`read-only` blocks any tool that mutates the workspace. `workspace-write`
allows mutating files inside the configured workspace root only.
`danger-full-access` permits arbitrary shell commands and is intended
for local trust contexts.

The selected mode is enforced inside `octocode-runtime` at the tool
boundary; CLI arguments and `/api/settings` are the only sources of
truth.

## Operations: Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| WebUI shows the stub-fallback warning | Every provider is unhealthy | Check API keys, base URL, and the `/api/events` feed |
| `cargo build` fails with `os error 5` on Windows | a previous WebUI is holding `octocode-cli.exe` | `.\scripts\octocode-down.ps1 -All` then rebuild |
| Anthropic returns 401 with a third-party gateway | gateway requires `Authorization: Bearer` | v2026.4.29 sends both headers; upgrade if older |
| LaTeX shows raw `$...$` | older WebUI without KaTeX | hard-refresh the browser; v2026.4.29 ships KaTeX |
