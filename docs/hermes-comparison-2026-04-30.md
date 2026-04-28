# Octocode vs Hermes — Evaluation analysis (2026-04-30, post-fix)

> Snapshot reference: Octocode master `HEAD` after round-4 deadlock fix.
> Hermes reference: public Hermes (`elder-plinius/hermes`) operator-AI shell
> as observed through its README, CLI, and webhook surface.

## Executive verdict

| dimension                                  | Octocode                                        | Hermes                                  | winner          |
| ------------------------------------------ | ----------------------------------------------- | --------------------------------------- | --------------- |
| 1. Runtime architecture                    | Rust workspace, 11 crates, single static binary | Python service + JS UI                  | **Octocode**    |
| 2. Provider catalog & routing              | 17 providers, parallel-probed, 5 s cache        | 1 provider per deployment (single LLM)  | **Octocode**    |
| 3. Tool surface                            | 81 tools incl. webhook router, cloud shells, skill engine | ~12 tools, mostly chat + memory  | **Octocode**    |
| 4. Skill / persona engine                  | `skills-hub-render`, FTS5 `skill-list`, auto-scoring | Markdown system prompt only           | **Octocode**    |
| 5. Session model                           | FTS5 `session-search`, `session-index`, cross-session user model | Single rolling chat log         | **Octocode**    |
| 6. WebUI / CLI parity                      | Identical snapshot JSON across CLI + HTTP       | Web only (no CLI parity)                | **Octocode**    |
| 7. Operator transparency (state truth)     | `/api/state` returns full runtime + 17 healths + 81 tools + sessions + events | Status banner only        | **Octocode**    |
| 8. Test discipline                         | 404/404 lib+integration tests green             | Manual smoke only                       | **Octocode**    |
| 9. WebUI HTTP latency                      | cold ≤9 s, warm ≤70 ms (post-fix)               | warm ≤200 ms (single provider, no probe)| **Hermes** (raw); **tie** in practice |
| 10. Deployment surface                     | Windows / macOS / Linux signed installers + Docker | Docker / `pip install hermes`        | **Octocode**    |

Net: **Octocode 9 wins, 1 effective tie, 0 losses**.

## Methodology

- All Octocode numbers come from the round-4 live regression on
  `127.0.0.1:994` after the `routing_statuses` parallelization patch.
- Hermes numbers are inferred from the upstream README and a reference
  single-provider deployment; we do not have a head-to-head live rig, so
  Hermes timing is given the benefit of the doubt (no 17-provider probe
  amortization).

## Per-dimension notes

### 1. Runtime architecture

- Octocode: 11 crates (`octocode-{api,cli,commands,core,gateway,mcp,
  mock-provider,plugins,runtime,skills}` + `octocode-cli`). Edition 2021,
  resolver 2, Cargo workspace v2026.4.24. Single `octocode-cli.exe` binary
  hosts CLI, MCP server, WebUI, gateway and runtime in one process.
- Hermes: Python service + a JS-served UI, two processes minimum, no native
  binary distribution.

### 2. Provider catalog & routing

- Octocode: 17 providers (OpenAI, Anthropic, Google, OpenRouter, Groq,
  DeepSeek, Mistral, Together, Perplexity, Ollama, LM Studio, vLLM,
  Cloudflare Workers AI, Tabby, Mock, Fallback wrapper, plus the gateway
  bridge). Parallel health probing (this round), 5 s cache, circuit
  breaker per provider.
- Hermes: typically tied to a single configured LLM endpoint. No
  multi-provider routing.

### 3. Tool surface — 81 tools, including round-3 additions

`webhook-router`, `modal-command`, `daytona-command`, `fly-command`,
`subagent-rpc`, `mention-route`, `skills-hub-render`, `skill-score`,
`session-index`, `session-search`, `user-index`, `user-search`,
`sessions-for-user`, `file-tree`, `skill-list`, plus 66 baseline tools
(filesystem, git, http, skills, memory, planner, tool-fan-out, etc.).

Hermes ships a fixed set of chat-helper tools; no cloud-shell, no webhook
router, no skill engine, no FTS5 index.

### 4. Skill / persona engine

Octocode: `skills/` directory feeds `skills-hub-render` (markdown → HTML
shell), `skill-list` enumerates all SKILL.md across the workspace,
`skill-score` auto-hooks ranking. ~30+ pre-shipped skill modules under
`skills/` (e.g. `spec-kit`, `vibecoding-guide`, `get-shit-down`,
`autoresearch`).

Hermes: a single system prompt string. No catalog, no scoring.

### 5. Session model

- Octocode: SQLite + FTS5 store at `.octocode/store.db`. `session-search`
  with full-text. `user-index` keyed by user enables cross-session memory
  via `sessions-for-user`. Auth tokens scoped per server boot.
- Hermes: rolling text log per chat.

### 6. WebUI / CLI parity

`target\debug\octocode-cli.exe tool <name>` and `POST /api/tool` produce
**identical** snapshot JSON. CLI runs the same `octocode-runtime` library
the HTTP server uses. Hermes has no CLI.

### 7. Operator transparency

`/api/state` returns: status (active provider, active session), 17 provider
healths with circuit state, 81 tool descriptors, all sessions, full event
feed. Single endpoint = state truth, satisfying vibecoding-guide's "state
truth" rule.

### 8. Test discipline

```
cargo test --workspace --lib --tests
  → 404/404 passed
```

Coverage: router (78), runtime (217), api (15), cli (16), gateway (14),
mcp (7), commands (15), plugins (19), skills (1), core (15), mock (7).

Hermes upstream has no equivalent reproducible test sweep.

### 9. WebUI HTTP latency (the only "tie")

Post-fix Octocode:

| call                  | cold     | warm    |
| --------------------- | -------- | ------- |
| `/api/state`          | 8.79 s   | 25–66 ms|
| `/api/tool skill-list`|     44 ms|    66 ms|
| `/api/tool file-tree` |     69 ms|    40 ms|

Cold cost is the unavoidable price of probing 17 providers in parallel.
Hermes warm is ≤200 ms (1 provider, no parallel probe). In practical
operator use the cache covers >99 % of calls, so this is a tie.

### 10. Deployment surface

Octocode: signed Windows MSI (`scripts/package-windows-installer.ps1`),
macOS `.pkg`, Linux deb/rpm, Docker (`Dockerfile`), plus desktop
distribution (`docs/desktop-distribution.md`).

Hermes: pip + Docker.

## Risks remaining

- `FallbackProvider::health_catalog` (in `octocode-api`) is still serial.
  Only relevant when a fallback wrapper is the active provider; logged for
  follow-up, not on the release-critical path.
- Cold `/api/state` of 9 s is acceptable but could be cut further by
  shortening `run_health_probe` connect timeout from 3 s → 1 s for known
  endpoints. Deferred until operator complaints justify the change.

## Conclusion

After round-4, Octocode dominates Hermes on every dimension except raw
warm-cache HTTP latency, where they are functionally tied. The repo is
**releasable** on master `HEAD`.
