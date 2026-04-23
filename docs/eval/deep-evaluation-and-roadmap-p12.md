# Deep Evaluation & Roadmap — Full Project Re-Assessment (P12)

_Repository:_ `octocode` (workspace `c:/Users/周浩/vscode-workspace/octocode`)
_Branch:_ `fix/ui-stream-indicator-and-bench-flake`
_Head (local):_ `e6e8c0b` (P11) + this P12 commit
_Baselines referenced:_ P8 `54526bb`, P9 `a2679ea`, P10 `0404ca9`, P11 `e6e8c0b`
_Date:_ 2026-04-23

---

## 0. Executive summary

OctoCode has now shipped **12 incremental phases** on a workspace of **9 Rust
crates** plus a WebUI, MCP server, Dockerfile, `/metrics` endpoint, and a
**35-entry skills catalog**. This phase (P12) adds **4 new external-integration
skill descriptors** — `openharness`, `llm-wiki`, `bytebot`, `agent-browser` —
and uses the moment to produce a **full project re-evaluation** covering
architecture, execution flow, failure modes, validation gaps, and prioritized
next steps. No runtime code changed in this phase; the intent is deliberate:
integrations at this level of complexity must be **descriptor-registered first,
code-activated second**, with every activation behind an opt-in config flag.

## 1. What shipped in P12

New skills (descriptor-only, discovered by `SkillRegistry::discover`):

| Skill | Source | Capability tier |
| --- | --- | --- |
| `openharness` | openharness harness | evaluation / benchmarking |
| `llm-wiki` | systems + memory reference | knowledge uplift |
| `bytebot` | desktop-control agent | high-risk tool catalog |
| `agent-browser` | LLM-driven browser automation | high-risk browser |
| (existing) `lightpanda-headless-browser` | Zig/Rust headless browser | low-risk liveness |

Validation: `cargo clippy --workspace --all-targets -- -D warnings` exits 0;
`octocode-cli skills-list` now returns **35 skills** and all 5 target names are
enumerated.

Intentional non-goals this phase:

- **No** new Rust crates or tool wiring. Each integration has an explicit
  deferred plan under `## Integration plan` in its SKILL.md and will only be
  activated behind an opt-in config toggle in the corresponding phase.
- **No** network fetch, no binary vendoring. `skills-install` (P11) is the
  canonical path for pulling new skill descriptors from the allowlist.

## 2. Architecture snapshot

```
                      ┌──────────────────────────┐
                      │       WebUI shell        │
                      │ (ui-shell/, auth-token   │
                      │  injected at serve time) │
                      └──────────┬───────────────┘
                                 │ HTTP/WS (:990-:999)
                                 ▼
            ┌────────────────────────────────────────┐
            │            octocode-cli                │
            │  subcommand interceptors (17 verbs)    │
            │  serve / mcp-serve / desktop / tui     │
            │  skills-install (HTTPS allowlist)      │
            │  GET /metrics (Prometheus)             │
            └──────────────┬─────────────────────────┘
                           │ pub use
                           ▼
        ┌───────────────────────────────────────────────┐
        │              octocode-runtime                  │
        │  ConfigLoader  FileSessionStore  TaskStore     │
        │  CoordinatorEngine  RuntimeProviderRouter      │
        │  WorkspaceToolExecutor  RuntimeToolCatalog     │
        │  translate_text_tool_calls (P10)               │
        │  benchmark gate (REGRESSION_ABS_FLOOR_MS=0.5)  │
        └─────┬──────────────┬──────────────┬────────────┘
              │              │              │
              ▼              ▼              ▼
      ┌────────────┐ ┌────────────┐ ┌─────────────────┐
      │ octocode-  │ │ octocode-  │ │ octocode-core   │
      │  api       │ │ commands   │ │ (traits, errors)│
      │ Providers  │ │ CLI verbs  │ │ PermissionMode  │
      │ Registry   │ │            │ │ ToolCall        │
      └────────────┘ └────────────┘ └─────────────────┘
                           │
                           ▼
        ┌───────────────────────────────────────────────┐
        │                 octocode-skills                │
        │  SkillRegistry (workspace + user config_home)  │
        │  35 descriptors across 3 capability tiers       │
        └───────────────────────────────────────────────┘
                           │
                           ▼
        ┌───────────────────────────────────────────────┐
        │                octocode-mcp / plugins          │
        │  stdio MCP server (Dockerfile target)          │
        └───────────────────────────────────────────────┘
```

Crate graph stays acyclic: `cli → runtime → {api, commands, core, skills, mcp}`.
Nothing new moved across crate boundaries in this phase.

## 3. Execution flow (happy path, WebUI prompt)

1. Operator POSTs `command` to `/api/command` with auth token injected into
   `ui-shell/index.html` at serve-time.
2. `server.rs` increments `METRICS_REQUESTS_TOTAL`, runs `check_auth`, then the
   rate limiter, then dispatches to `route_request`.
3. Runtime turn is appended to the active session via
   `FileSessionStore::append`; turn lifecycle state transitions
   `idle → running`.
4. Provider stream completion goes through `translate_text_tool_calls` (P10)
   — single call, no dialect branching in the coordinator.
5. Every yielded `ToolCall` is re-validated by `WorkspaceToolExecutor` against
   `PermissionMode`; high-risk tools trigger the approval-token flow.
6. Stream finishes, indicator toggles off in the browser, `turn` transitions
   `running → completed`; event feed emits a timeline entry consumable by
   `/api/events` and `/api/timeline`.
7. `/metrics` scrape exposes `octocode_requests_total`,
   `octocode_errors_total`, `octocode_build_info{version=...}`.

## 4. Failure modes & mitigations (current posture)

| Failure | Current defense | Residual risk |
| --- | --- | --- |
| LLM emits malformed tool-call marker | `translate_text_tool_calls` drops unknown / unparsable calls silently | Operator has no UI breadcrumb — see §6.1 |
| Operator types `shell-command rm -rf /` | `PermissionMode` + approval-token flow | Approval UX is token-based, no diff preview |
| Provider disk 500s | Circuit breaker with exponential backoff in runtime | Breaker state not surfaced in `/metrics` |
| Malicious skill URL | `skills-install` HTTPS allowlist + `.md` + 256 KiB + UTF-8 + heading check | No cryptographic signature |
| WebUI XSS via injected token | Token is string-escaped and placed in `<script>` body; no `innerHTML` path | Relies on WebView sandboxing |
| Port reuse / conflicting dev servers | `is_allowed_web_port` restricts 990-999; `/api/health` exposes conflicts | Chromium requires `--explicitly-allowed-ports=995` for `995` |
| Benchmark flake (P99 CPU jitter) | `REGRESSION_ABS_FLOOR_MS=0.5` absolute floor | Not tied to per-host calibration |
| Test suite drift across crates | 332 tests, `-D warnings`, `webui-e2e` CI matrix | No coverage floor enforced |
| WebSocket disconnect mid-stream | `scheduleRecoveryRefresh()` 3 s poll on `phase=running` indicator | Still a 3 s window for stuck UI |
| Docker image supply chain | Multi-stage musl, non-root user, no extra packages | No SBOM, not signed, not published |

## 5. Validation gaps

1. **No coverage threshold in CI.** We have 332 tests, but no gate on
   coverage percentage for core paths like `WorkspaceToolExecutor`.
2. **`/metrics` has no test.** The route is covered by compile-time typing
   only; a minimal integration test should scrape `/metrics` and assert the
   three series exist.
3. **`skills-install` network path has no mocked end-to-end test.** The unit
   tests cover URL validation and allowlist rejection but never exercise the
   `fetch_text` path. A test behind a local HTTPS mock would close this.
4. **`translate_text_tool_calls` has no fuzz target.** A cargo-fuzz target
   over random bytes would harden against pathological inputs.
5. **Docker image is not smoke-tested in CI.** `Dockerfile` exists but no
   workflow builds it; a `docker build` step is cheap and high-value.
6. **Benchmark gate absolute floor is hard-coded.** It should optionally
   read from `.octocode/config.toml` so operators on slow hardware can
   widen the floor without recompiling.

## 6. UX friction (from the operator perspective)

1. **Silent tool-call drop.** When `translate_text_tool_calls` discards an
   unknown tool, the WebUI simply shows the assistant's prose; operators
   lose the "model tried to call X but it isn't in the catalog" signal.
   A one-line `event_feed_json` entry with kind `tool_blocked` is a 30-minute
   fix and a large legibility win.
2. **Approval-token flow is opaque.** High-risk tool executions surface a
   token but no preview of the argument (e.g. the exact shell command).
   Adding a collapsed argument preview to the approval UI would reduce
   accidental approvals.
3. **Skills browsing.** We have 35 skills but no WebUI list. A read-only
   panel rendering the output of `skills-list` with the SKILL.md body
   below would make the catalog discoverable.
4. **Config drift.** `config-show` dumps JSON to stdout; a minimal WebUI
   panel that shows current config + validation warnings would cut support
   load.

## 7. Prioritized roadmap (P13 and beyond)

Ordered by `leverage / effort`:

1. **P13-A: event_feed `tool_blocked` entries.** Tiny runtime change in
   `translate_text_tool_calls` call sites; huge legibility win.
2. **P13-B: `/metrics` integration test + `docker build` smoke in CI.**
   Closes the observability and distribution validation gaps (§5.2, §5.5).
3. **P13-C: Approval-token UI — argument preview.** Surface the argument
   payload in the WebUI approval gate. Requires `ui-shell/` change only.
4. **P13-D: Semantic memory layer draft.** Author the `MemoryLayer` trait
   from the `llm-wiki` descriptor's plan; stub `file` + `sqlite` + `vector`
   backends without wiring embeddings yet.
5. **P13-E: Fuzz target for `translate_text_tool_calls`.** Add
   `fuzz/translate.rs` under `cargo-fuzz`; run in a nightly CI job.
6. **P14: Activate `skills-install` signing.** Integrate minisign or
   cosign verification behind `skills-install --require-signature`. This
   is the correct next step before broadening the allowlist.
7. **P14: Publish Docker image.** Tag-triggered GHCR push with SBOM
   (`syft`) and provenance attestation (`cosign attest`).
8. **P15: Desktop-control capability tier (from `bytebot` descriptor).**
   Only after signing + approval-UX improvements land. Strictly
   feature-flagged; absent from default MCP catalog.
9. **P15: Agent-browser capability tier.** Same gating as P15 desktop;
   builds on `lightpanda-headless-browser` for liveness + `agent-browser`
   for semantics.
10. **P16: Capability benchmarks via `openharness` adapter.** After the
    infrastructure settles; keeps us honest about model regressions, not
    just runtime regressions.

## 8. Tracked honest non-goals

- **We will not** auto-enable desktop / browser-automation tools. Every
  high-risk tier requires explicit operator opt-in + approval flow.
- **We will not** ship embeddings by default. Semantic memory is an
  opt-in layer; it must not leak session bodies to third-party providers
  without explicit config.
- **We will not** expand the `skills-install` allowlist without shipping
  signature verification first.
- **We will not** raise test count for its own sake. New tests must close
  a specific failure mode from §5.

## 9. Validation checkpoint (this phase)

- Skills catalog: **35 entries** (up from 30 at P9).
- `cargo clippy --workspace --all-targets -- -D warnings`: **exit 0**.
- Test count unchanged from P11 (332 passed / 0 failed) — P12 adds only
  `.md` files which do not ship compiled code.
- No runtime dependencies added.
- Docker image unchanged; `/metrics` contract unchanged.
- P11 push remains pending restoration of `github.com:443` reachability;
  local HEAD `e6e8c0b` + this P12 commit both queued.

## 10. Closing

The deliberate choice this phase was to **register** integrations rather
than half-build them. Each of `openharness`, `llm-wiki`, `bytebot`, and
`agent-browser` gets a SKILL.md that doubles as a threat-modeled integration
plan, which is the right artifact to gate future PRs against. The roadmap
in §7 now sequences the next three phases with concrete, falsifiable work
items; none of it is speculative.
