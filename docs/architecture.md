# Octocode Architecture

**Version:** 2026.4.24
**Scope:** Rust workspace at `octocode/crates/*` + WebUI shell served by `octocode-cli`.
**Audience:** Contributors and operators who need a compact mental model of the system before reading source.

This document is kept deliberately short. For deep dives see [`analysis-and-roadmap.md`](analysis-and-roadmap.md) and the module-specific docs under [`modules/`](modules/).

---

## 1. Crate layout

Nine Cargo workspace members, top-down dependency order:

| Crate | Purpose | Internal deps |
|---|---|---|
| [`octocode-core`](../crates/octocode-core) | Pure types: errors, configs, `ProviderKind`, `ProviderDescriptor`, `SessionSnapshot`, `ToolDescriptor`, skill/MCP models. Zero I/O. | — |
| [`octocode-skills`](../crates/octocode-skills) | Skill manifest discovery across workspace / user home / config scopes. | core |
| [`octocode-plugins`](../crates/octocode-plugins) | Plugin registry, marketplace metadata, hook dispatch. | core |
| [`octocode-mcp`](../crates/octocode-mcp) | MCP (Model Context Protocol) server lifecycle and stdio transport. | core |
| [`octocode-mock-provider`](../crates/octocode-mock-provider) | Test fixture implementing `ModelProvider` for deterministic CI. | core |
| [`octocode-api`](../crates/octocode-api) | Model provider registry, OpenAI/Anthropic clients, circuit breaker, health tracking. | core |
| [`octocode-runtime`](../crates/octocode-runtime) | Execution engine: sessions, turns, agent tool loops, tool catalog, router, isolation. | core, mcp, plugins, skills |
| [`octocode-commands`](../crates/octocode-commands) | CLI command enum + routing into the runtime (used by both CLI and WebUI). | core, runtime |
| [`octocode-cli`](../crates/octocode-cli) | Binary: tiny_http server, WebSocket layer, static WebUI shell, CLI subcommand dispatch. | api, commands, core, mcp, runtime, skills |

Dependency graph is strictly acyclic; `core` has zero internal deps and is the single source of truth for shared types.

---

## 2. Runtime request flow

### 2.1 User chat (`POST /api/chat`)

```
Browser
  │ POST /api/chat?sessionId=…&text=…  (Authorization: Bearer <token>)
  ▼
octocode-cli / server.rs:1934
  ├─ auth check    (server.rs:130 check_auth)
  ├─ rate limiter  (server.rs:99  RateLimiter, 30 req/s per IP)
  ├─ METRICS_CHAT_REQUESTS_TOTAL ++
  │
  ▼
octocode-runtime / lib.rs:592   prompt_in_session
  ├─ start_turn, buffer history
  ├─ agent_action_in_session (if agentic)  lib.rs:705
  ▼
octocode-runtime / lib.rs:446   prompt → prompt_via_stream
  ▼
octocode-api    (provider client)
  ├─ OpenAiCompatibleProvider / AnthropicProvider / StubProvider
  ├─ circuit breaker (threshold=2, cooldown 60s)
  ├─ HTTP call to vendor
  ▼
octocode-runtime / lib.rs:800+  run_agent_tool_loop
  ├─ parse [tool_call(...)] markers
  ├─ dispatch through WorkspaceToolExecutor
  ├─ re-prompt LLM until no more tool calls
  ▼
server.rs → snapshot_json → HTTP 200 JSON
```

### 2.2 Tool invocation (`POST /api/tool`)

Skips the LLM. Goes directly to `runtime.invoke_tool(name, input)` →
`octocode-runtime / tools.rs` dispatcher. 59 tool descriptors registered
(see `tools::descriptors()`), including the cross-platform
`empty-recycle-bin` added in 2026.4.24.

### 2.3 Streaming (`GET /api/stream`, `GET /ws`)

Server-sent events and WebSocket both wrap the same provider-level
`prompt_stream` callback, so a token is delivered to all live subscribers
of a session within a few hundred microseconds.

---

## 3. Provider layer

Registry in [`octocode-api/src/lib.rs`](../crates/octocode-api/src/lib.rs)
currently exposes **17 providers**. Descriptors define UI presentation,
capabilities (tool use, streaming) and routing kind; client construction
in `create_by_id_with_config` reads vendor-specific environment
variables and never embeds secrets.

| Provider id | Kind | Env chain (first hit wins) |
|---|---|---|
| `anthropic` | `Anthropic` | `ANTHROPIC_API_KEY` |
| `remote-openai` | `OpenAiCompatible` | `OCTOCODE_REMOTE_*` |
| `local-openai` | `LlamaCpp` | `OCTOCODE_LOCAL_*` |
| `ollama` | `Ollama` | `OCTOCODE_OLLAMA_*` |
| `gemini` | `OpenAiCompatible` | `GEMINI_*` |
| `azure-openai` | `OpenAiCompatible` | `AZURE_OPENAI_*` |
| `nvidia-free` | `OpenAiCompatible` | `NVIDIA_*` |
| `linkmind` | `LinkMind` | `LINKMIND_*` |
| `xai` | `XAi` | `XAI_*` |
| `openrouter` | `OpenRouter` | `OPENROUTER_*` |
| `qwen` | `Qwen` | `QWEN_*`, `DASHSCOPE_*` |
| `glm` | `Glm` | `GLM_*`, `ZHIPU_*` |
| `kimi` | `Kimi` | `KIMI_*`, `MOONSHOT_*` |
| `xiaomi` | `Xiaomi` | `XIAOMI_*` (stream-only) |
| `minimax` | `MiniMax` | `MINIMAX_*` |
| `openai-completion` | `OpenAiCompletion` | `OPENAI_COMPLETION_*` (self-hosted legacy) |
| `stub` | `Stub` | — (offline deterministic fallback) |

Adding a new OpenAI-compatible vendor is a three-point edit:
1. New variant in `ProviderKind` (`core/src/lib.rs`).
2. New `DEFAULT_*_BASE_URL` / `_MODEL` constants + descriptor in `ProviderRegistry::new()` (`api/src/lib.rs`).
3. New match arm in `create_by_id_with_config` wiring the env chain.

---

## 4. Security surface

| Control | Location |
|---|---|
| Per-process random auth token (32 B hex, regenerated on each `serve` start) | `cli/src/server.rs:123` `get_server_token` |
| `Authorization: Bearer` / `X-Auth-Token` header validation on all `/api/*` except `/api/health` and `/api/auth-token` | `server.rs:130` `check_auth` |
| Sliding-window rate limit (30 req/s per client IP) | `server.rs:99` `RateLimiter` |
| Workspace isolation token (SHA-256 of workspace_id + timestamp + counter) | `runtime/src/isolation.rs:390` |
| Allowed WebUI port range 990–999 | `commands/src/lib.rs` `is_allowed_web_port` |
| Provider secrets: env-var only, never embedded in source, never echoed in `/api/manage/catalog` | `api/src/lib.rs` `create_by_id_with_config` |

CORS is same-origin by design: the binary serves both the API and the
static WebUI shell, so no cross-origin credential flow exists.

---

## 5. Observability

`GET /metrics` returns Prometheus text format (0.0.4 spec). Labels are
kept to O(1) cardinality per series so the endpoint stays cheap to scrape.

| Metric | Type | Meaning |
|---|---|---|
| `octocode_requests_total` | counter | All non-preflight HTTP requests. |
| `octocode_errors_total` | counter | 5xx responses. |
| `octocode_chat_requests_total` | counter | `/api/chat` attempts (success + failure). |
| `octocode_tool_invocations_total` | counter | `/api/tool` direct invocations. |
| `octocode_sessions_created_total` | counter | Sessions created via `/api/sessions/create`. |
| `octocode_build_info{version="..."}` | gauge | Build version label, always 1. |

Provider health, circuit-breaker state and latency samples are exposed
separately via `GET /api/manage/catalog` for the WebUI health tab.

---

## 6. Testing strategy

| Layer | Tool | Where |
|---|---|---|
| Unit | `cargo test -p <crate>` | each crate's `#[cfg(test)]` module |
| Workspace integration | `cargo test --workspace` | 336+ tests, < 2 min wall |
| Lint gate | `cargo clippy --workspace --all-targets -- -D warnings` | CI-equivalent locally |
| Live regression | `node scripts/live-regression.mjs 999 liveqa` | 62 assertions against a real `serve` process; reports to `docs/eval/live-regression-p13.md` |
| UI smoke | Playwright 1.49.1 + Chromium 131 | `scripts/verify-webui*.mjs` |

Port 999 is the default (range 990–999 enforced) and Chromium must be
launched with `--explicitly-allowed-ports=999`.

---

## 7. Cross-platform posture

Supported: Windows 10+, modern Linux (glibc ≥ 2.31). macOS paths exist in
a few places (e.g. `empty-recycle-bin`) but are not part of the
supported test matrix for the 2026.4.24 release.

Platform-specific code paths are gated with `#[cfg(target_os = "...")]`
and always fall through to a shell-out implementation so the binary
never panics on an unsupported OS.

---

## 8. What this document intentionally does not cover

- Agent long-task supervision (triggers, heartbeats, self-iteration) —
  designed but not yet scaffolded, tracked in the roadmap.
- Permanent memory store / seamless context resume — same.
- WebUI visual redesign — Batch C, deferred.

See [`analysis-and-roadmap.md`](analysis-and-roadmap.md) for the current
priority queue.
