# Phase 7 — Release Hardening Assessment (Windows-first)

**Date:** 2026-04-25
**Scope:** T1, T6, T7, T8, T10, T13, T14 implemented; T2/T4/T5 partially smoke-validated; T3/T9/T11/T12 deferred with rationale.
**HEAD before phase:** `bc7785e3a728b01e8ce8cff1406ab03632cd3c09`
**Validation host:** Windows 10 / PowerShell 5.1 / Rust 1.92.0 stable (`C:\Users\周浩\vscode-workspace\.cargo`).

## 1. Summary

Octocode now meets a release-quality baseline for Windows operators. Every HTTP response carries strict security headers, the bearer token can be supplied via env or a file (so it is no longer regenerated on every restart), `/metrics` exposes two new operability counters, the config file is forward-compatible via `config_version=1`, the self-review CLI can run as a long-lived sampler, README + CHANGELOG document the security model, GitHub Actions runs `check / clippy / test / release-build` on `windows-latest`, and historical reports were relocated to `docs/history/` so the active docs surface stays current.

## 2. Tasks delivered

| ID | Title | Status | Validation |
|----|-------|--------|------------|
| T1 | `OCTOCODE_BEARER_TOKEN` env / `OCTOCODE_BEARER_TOKEN_FILE` env / random fallback, with source printed at startup | ✅ done | manual smoke confirmed `Auth token: ... (source: OCTOCODE_BEARER_TOKEN env)` |
| T6 | `octocode_agent_iterations_total` + `octocode_circuit_open_total` Prometheus counters | ✅ done | `/metrics` curl shows new HELP+TYPE+series |
| T7 | README security section + `CHANGELOG.md` + `docs/history/` relocation (15 archived reports) | ✅ done | `git mv` shown in `git status` |
| T8 | `.github/workflows/ci-windows.yml` (check, clippy `-D warnings`, test, release artifact) | ✅ done | YAML validated; runs on push/PR/manual |
| T10 | `RuntimeConfig.config_version: u32` + `CONFIG_SCHEMA_VERSION = 1` + parser/save/default round-trip | ✅ done | `cargo test --workspace` 339 passed |
| T13 | `self-review --cron <secs>` writes JSONL history to `<data_home>/self-review-history.jsonl` | ✅ done | smoke produced 514-byte file in `%LocalAppData%\Octocode\Data\` |
| T14 | CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, ACAO `http://127.0.0.1` (was `*`) | ✅ done | header echo confirmed all five values |

## 3. Tasks partially / not delivered

| ID | Title | Status | Reason |
|----|-------|--------|--------|
| T2 | Long-task stub-replay smoke (iteration cap, keepalive, since-resume, mid-stream cancel) | ⏸ partial | smoke covered SSE keepalive presence indirectly via existing tests; full stub-driven replay deferred to a stub-provider milestone |
| T4 | Windows installer script try-and-document | ⏸ partial | release binary built clean (`target/release/octocode-cli.exe` 32s); installer packaging script not run end-to-end this phase |
| T5 | Permission boundary / shell-injection / 413 / 429 smoke | ⏸ partial | header smoke confirmed CSP + 401 unauth + ACAO; full payload smoke deferred (covered by existing security unit tests + `file_guard`) |
| T3 | Linux/macOS smoke | ⛔ deferred | per user "Linux和mac先不做" |
| T9 | EWMA tuning (α calibration) | ⛔ deferred | requires production telemetry sample |
| T11 | Full `server.rs` split (3933 LOC → routes/state/handlers) | ⛔ deferred | minimal `server_cache.rs` extraction already done; remainder post-release to avoid release-window churn |
| T12 | Skill-watcher (file-system watch on `skills/`) | ⛔ deferred | rescan-on-build acceptable for v1 |

## 4. Validation results (Windows host)

| Gate | Command | Result |
|------|---------|--------|
| `cargo check` | `cargo check --workspace --all-targets` | exit 0 |
| `cargo clippy` | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0, 0 warnings |
| `cargo test` | `cargo test --workspace --no-fail-fast` | **339 passed / 0 failed / 0 ignored** |
| `cargo build --release` | `cargo build --release -p octocode-cli` | exit 0 in 32.31s |
| WebUI startup smoke | `octocode-cli.exe serve 999 smoke` with `OCTOCODE_BEARER_TOKEN` | Auth token source line printed correctly |
| 401/200 split | `GET /api/snapshot` w/o + w/ bearer | 401 unauth ✓, 200 with bearer ✓ |
| `/metrics` smoke | `GET /metrics` | new counters `octocode_agent_iterations_total`, `octocode_circuit_open_total` rendered |
| Security headers | `GET /metrics`, `/api/state`, `/api/health` | CSP, XCTO=nosniff, XFO=DENY, Referrer-Policy=no-referrer, ACAO=http://127.0.0.1 |
| Self-review CLI | `octocode-cli self-review --since 0` | JSON report printed (window/topFailures/slowestProbes/circuitActivity/proposals) |
| Self-review cron | `octocode-cli self-review --cron 1` | JSONL appended to `%LocalAppData%\Octocode\Data\self-review-history.jsonl` |

## 5. Latency / metrics profile

`/metrics` after a fresh start:

```
octocode_requests_total 4
octocode_errors_total 0
octocode_chat_requests_total 0
octocode_tool_invocations_total 0
octocode_sessions_created_total 0
octocode_memory_notes_total 0
octocode_agent_tasks_active 0
octocode_agent_iterations_total 0   # T6 new
octocode_circuit_open_total 0        # T6 new (definition-only this phase)
octocode_build_info{version="2026.4.24"} 1
```

Notes:

- `agent_iterations_total` increments once per `/api/chat` turn. Sub-iteration accuracy requires a runtime callback hook (deferred).
- `circuit_open_total` counter is wired through `/metrics` rendering but increments on circuit transitions inside `octocode-runtime`. Wire-up of the actual transition path is deferred to a runtime-side instrumentation pass (left at 0 until then).

## 6. Security checklist (Windows host)

- [x] Bearer token: env > file > random, source visible at startup.
- [x] WebUI bound to `127.0.0.1` only.
- [x] Strict CSP with `frame-ancestors 'none'`.
- [x] `Access-Control-Allow-Origin` restricted from `*` to `http://127.0.0.1`.
- [x] `X-Content-Type-Options: nosniff` on every response.
- [x] `X-Frame-Options: DENY` on every response.
- [x] `Referrer-Policy: no-referrer` on every response.
- [x] Request timeout configurable (`request_timeout_secs`, default 90).
- [x] Permission modes: `read-only` / `workspace-write` / `escalated`.
- [x] Tool denylist via `denied_tools`.
- [x] `file_guard` enforces workspace-root path safety.
- [ ] Body-size 413 + rate-limit 429 — present in code, full payload smoke deferred to T5.

## 7. Remaining risks before public release

1. **Iteration counter approximation** — `agent_iterations_total` currently counts turns, not loop iterations. Consumers of the metric should be told 1 unit ≈ 1 chat turn until runtime-side instrumentation lands.
2. **Circuit-open counter wiring** — counter exists but increments are not yet emitted from the runtime. Until that lands, alerts on `circuit_open_total` will not trigger; operators should keep watching `/api/health` directly.
3. **Linux/macOS untested this phase** — code compiles and tests pass on Windows only. CI matrix is Windows-only by user choice.
4. **Installer end-to-end** — `scripts/package-windows-installer.ps1` should be exercised before tagging `v0.1.0`.
5. **CSP `unsafe-inline`** — kept for the bundled UI shell's inline scripts/styles. A nonce-based migration is recommended next phase.

## 8. Suggested next phase (post-release)

1. Wire real runtime callbacks for agent loop iteration count and circuit-state transitions.
2. Add provider latency histogram (p50/p95) using `prometheus`-compatible bucket counters.
3. Migrate UI shell to nonce-based CSP (drop `'unsafe-inline'`).
4. Resume `server.rs` split (T11) to reduce single-file LOC under 1000.
5. Reintroduce Linux/macOS to the CI matrix once Windows is stable in production.
