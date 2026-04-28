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
| T2 | Long-task stub-replay smoke (iteration cap, keepalive, since-resume, mid-stream cancel) | ✅ done | `scripts/smoke-windows.ps1` covers SSE frame presence, `?since=` resume, `/api/sessions/cancel` alias |
| T4 | Windows installer try-and-document | ✅ done | `scripts/package-windows-installer.ps1` produces 3.8MB setup.exe; PS5.1 stderr handling fixed |
| T5 | Permission boundary / shell-injection / 413 / 429 smoke | ✅ done | smoke validates 401, 413 (oversize POST close), 429 (>30 req/s burst), CSP/XCTO/XFO/Referrer-Policy/ACAO |
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

- `agent_iterations_total` now increments **per agent loop iteration** inside `octocode-runtime` (both blocking `prompt` and streaming `prompt_stream` paths), not per chat turn.
- `circuit_open_total` now increments inside `octocode-api::record_failure` whenever a previously-Closed/HalfOpen circuit transitions to Open, gated to avoid double-counting failures while already Open.
- Counters live in `octocode-core` to avoid a runtime↔api dependency cycle.

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
- [x] Body-size 413 + rate-limit 429 — verified by `scripts/smoke-windows.ps1` (oversize POST connection-close + 50+ 429s in an 80-request parallel burst).

## 7. Remaining risks before public release

1. **Linux/macOS untested this phase** — code compiles and tests pass on Windows only. CI matrix is Windows-only by user choice.
2. **CSP `unsafe-inline`** — kept for the bundled UI shell's inline scripts/styles. A nonce-based migration is recommended next phase.
3. **Provider latency histogram** — only counters are exposed today; p50/p95 buckets require a histogram crate or hand-rolled bucket counters.

## 8. Suggested next phase (post-release)

1. Add provider latency histogram (p50/p95) using `prometheus`-compatible bucket counters.
2. Migrate UI shell to nonce-based CSP (drop `'unsafe-inline'`).
3. Resume `server.rs` split (T11) to reduce single-file LOC under 1000.
4. Reintroduce Linux/macOS to the CI matrix once Windows is stable in production.

## 9. Phase 8 addendum (2026-04-28) — counter wiring + full smoke + installer

### What changed

- Moved process-wide operability counters (`AGENT_ITERATIONS_TOTAL`, `CIRCUIT_OPEN_TOTAL`) into `octocode-core` so `octocode-api` and `octocode-runtime` can both mutate them without depending on each other.
- `octocode-runtime` increments `AGENT_ITERATIONS_TOTAL` on each iteration of both the blocking and streaming agent loops.
- `octocode-api::record_failure` increments `CIRCUIT_OPEN_TOTAL` only on Closed/HalfOpen→Open transitions.
- `octocode-cli/src/server.rs` consumes the core counters; the per-turn approximation in `/api/chat` was removed.
- New `scripts/smoke-windows.ps1` runner: 16 checks covering 401, CSP/XCTO/XFO/Referrer-Policy/ACAO, `/metrics` series presence, `/api/state`, `/api/health`, SSE frame, `?since=` resume, `/api/sessions/cancel`, 11MB body reject, 30/sec rate limit, and `octocode_requests_total` movement.
- Fixed `scripts/package-desktop.ps1` cargo-stderr handling under PowerShell 5.1 `ErrorActionPreference=Stop`.

### Validation results

| Gate | Result |
|------|--------|
| `cargo check --workspace --all-targets` | ok |
| `cargo clippy --workspace --all-targets -- -D warnings` | ok |
| `cargo test --workspace --no-fail-fast` | 339 passed / 0 failed |
| `scripts/smoke-windows.ps1` | **16 / 16 PASS** (rate-limit run produced 29× 200, 51× 429) |
| `scripts/package-desktop.ps1 -Profile release` | ok — `out/desktop/octocode-v2026.4.24-windows-x64` |
| `scripts/package-windows-installer.ps1` | ok — `out/installers/windows/Octocode-2026.4.24-windows-x64-setup.exe` (3.8 MB) |
