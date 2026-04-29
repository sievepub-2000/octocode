# Octocode Architecture

> **Audience**: contributors and integrators who need to understand the
> runtime layering before extending Octocode.

## High-level diagram

```
+-----------------------------------------------------------------+
|                       Shells (consumers)                        |
|  CLI         WebUI (HTML/JS)        Desktop (tao+wry/WebView2)  |
|  └─ stdout   └─ /api/state, SSE     └─ embeds the WebUI         |
+-----------------------------------------------------------------+
                |              ^
                v              |
+-----------------------------------------------------------------+
|                       octocode-cli                              |
|   * argv parsing, output renderers, port-restricted server      |
|   * embeds: HTTP API + SSE event feed + Desktop launcher        |
+-----------------------------------------------------------------+
                |              ^
                v              |
+-----------------------------------------------------------------+
|                    octocode-runtime  (16k LOC)                  |
|   * SessionStore (SQLite, append-only turns)                    |
|   * PermissionPolicy (read-only / workspace-write + tool deny)  |
|   * RuntimeProviderRouter (parallel /health probes, dedup)      |
|   * Tool registry (81 built-ins) + skills + commands (29)       |
|   * Platform shell (PS7 → PS5.1 → cmd on Windows; bash on POSIX)|
+-----------------------------------------------------------------+
                |              ^
                v              |
+-----------------------------------------------------------------+
|     octocode-api                       octocode-mcp             |
|     * 17 provider descriptors          * MCP client + SSE       |
|       (anthropic, openai, glm,         * fork/transport bridge  |
|        gemini, ollama, ...)                                     |
|     * BuiltinProvider enum:                                     |
|       Stub | OpenAiCompatible |                                 |
|       Anthropic | Fallback                                      |
+-----------------------------------------------------------------+
                |
                v
+-----------------------------------------------------------------+
|                     octocode-core                               |
|   stable contracts only:                                        |
|   trait ModelProvider { health(); send(); ... }                 |
|   ProviderHealth, ProviderCircuitState, ProviderDescriptor      |
|   ToolCatalog, PermissionPolicy, SessionId, WorkspaceId         |
+-----------------------------------------------------------------+
```

Auxiliary crates:

| Crate                    | Role                                    |
|---|---|
| `octocode-commands`      | 29 built-in slash commands               |
| `octocode-skills`        | local skills index                       |
| `octocode-plugins`       | dynamic plugin loader + sandbox          |
| `octocode-gateway`       | LB / passthrough HTTP gateway            |
| `octocode-mock-provider` | deterministic stub for tests             |

## Key invariants

1. **Layering**: `core` ← `api` ← `runtime` ← `cli`. Shells (CLI / WebUI /
   Desktop / external IDE bridges) only consume runtime snapshots and the
   SSE event feed. They never reimplement business rules.
2. **Single source of truth**: the runtime emits a `UiSnapshot`
   (sessions, providers, providerHealths, eventFeed, ...) — every shell
   renders from that snapshot, never from local mutable state.
3. **Provider routing**:
   - `BuiltinProvider::Fallback` projects the **parent** descriptor id in
     `health()`. Inner candidate identity surfaces via `health_catalog()`
     (used internally) and via the `via <inner>:` prefix in the detail
     string.
   - The router probes every top-level provider in parallel via
     `thread::scope`, with a 15-second cache to avoid hammering remote
     endpoints.
4. **Permission model**: two modes (`read-only`, `workspace-write`) with
   per-tool deny lists. Shell-command and write-class tools always go
   through `PermissionPolicy::evaluate` before execution.
5. **Windows-first validation**: PowerShell 7 is preferred, falling back
   to Windows PowerShell 5.1, and finally `cmd`. Path normalization
   handles `\\?\` long paths, `OneDrive\Documents` redirection, and
   non-ASCII profile names.
6. **Local-first transport**: the WebUI HTTP server binds to
   `127.0.0.1` only, port range `990–999`, with a per-process bearer
   token injected into `index.html` via `window.__OCTOCODE_AUTH_TOKEN__`.

## Provider list (17)

`anthropic`, `local-openai`, `remote-openai`, `ollama`, `linkmind`,
`gemini`, `azure-openai`, `nvidia-free`, `xai`, `openrouter`, `qwen`,
`glm`, `kimi`, `xiaomi`, `minimax`, `openai-completion`, `stub`.

## Tool taxonomy (81)

Filesystem · shell-command · http(s) · workspace search · session ·
provider control · permission · skills · MCP bridge · agent control.

## Persisted state

| Path (`%APPDATA%\octocode\` on Windows; `~/.config/octocode/` on POSIX) | Purpose |
|---|---|
| `octocode.conf`     | per-machine config (provider id, default model, permission mode) |
| `sessions.sqlite`   | append-only session/turn store                |
| `skills/`           | user-authored skills                          |
| `logs/`             | rotating CLI logs                             |

The runtime also persists nothing inside the workspace tree unless the
operator explicitly writes via tools.

## Adding a new provider (cheat sheet)

1. Add a descriptor entry in `crates/octocode-api/src/lib.rs::descriptors`.
2. Implement a `ModelProvider` (or compose with `Fallback` if you need
   redundancy).
3. Wire it into `create_by_id_with_config`.
4. Add a runtime smoke test (`cargo test -p octocode-runtime`).
5. Update `docs/modules/octocode-modules.{en,ja}.md`.

That's it — the WebUI Settings → Providers panel auto-renders any new
descriptor.
