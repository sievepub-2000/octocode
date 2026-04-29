# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once
`v0.1.0` is tagged.

## [Unreleased]

### Security

- Bumped `rustls-webpki` to 0.103.13 (CVE: DoS via malformed CRL BIT
  STRING).
- Bumped `wry` 0.53 → 0.55 and `tao` 0.34 → 0.35, eliminating the
  unsound `rand 0.7.3` (RUSTSEC-2026-0097) build-time dependency
  pulled by `selectors 0.24` / `phf_codegen 0.8`.
- Linux desktop-shell still transitively pulls `glib 0.18.5`
  (RUSTSEC-2024-0429) via `webkit2gtk 2.0`; tracked in `deny.toml`
  pending an upstream `wry` migration to gtk-rs 0.20.

### Added

- `/api/metrics` JSON endpoint mirroring `/metrics` Prometheus
  counters for in-WebUI dashboards (L10).
- `cliff.toml` for git-cliff CHANGELOG generation (M5).
- `deny.toml` + `.github/workflows/audit.yml` running `cargo audit`
  and `cargo deny check` on push, PR and a weekly schedule (L8).
- `.github/workflows/release-binaries.yml` building per-OS artifacts
  on `v*` tags and uploading them to the matching GitHub release
  (N4).
- Integration regression test
  `crates/octocode-api/tests/provider_health_dedup.rs` locking the
  parent-id projection invariant (M2).

### Changed

- Bilingual EN+JA reading for the four fallback provider display
  names in `ProviderRegistry` (Tongyi Qwen, Zhipu GLM, Moonshot Kimi,
  Xiaomi MiMo) so non-CJK operators can identify them.
- `clippy --fix` cleanup: collapsed double `replace`, simplified
  `slack_challenge` lifetime, removed redundant `as_deref_mut` in
  streaming tool callback.
- Added 5 status badges (CI / License / Release / Rust / Platform)
  to `README.md` (N5).
- `CONTRIBUTING.md` now documents Conventional Commits expectations
  used by `git cliff`.

## [2026.4.30] - 2026-04-29

### Fixed

- Provider health snapshot no longer reports duplicate `local-openai`
  rows for fallback providers (`ollama`, `linkmind`, `remote-openai`,
  `nvidia-free`). `FallbackProvider::health()` now projects the parent
  descriptor id while preserving the active candidate's circuit state
  and latency, prefixing the detail string with `via <inner>:` for
  transparency.

### Changed

- Renamed user-facing **Contact Us** to **Contact Author** across the
  WebUI menu, runtime locales (en-US / ja-JP / ko-KR / zh-CN) and the
  bundled `ui-shell/help/contact.{en,ja}.md` panels.
- Pruned internal Chinese-only design / evaluation documents from
  `docs/`. The published documentation set is now English plus
  Japanese (`docs/modules/octocode-modules.{en,ja}.md`,
  `docs/PRIVACY.md`, `docs/THIRD_PARTY_NOTICES.md`,
  `docs/release-notes-2026-04-29.md`, `docs/modules/index.md`).
- Replaced all Chinese fallback strings in `ui-shell/index.html` and
  `ui-shell/app.js` with English defaults; runtime locale JSONs
  continue to provide CN/JA/KO translations at runtime.
- Workspace `Cargo.toml` author updated to a romanized identifier and
  version bumped to `2026.4.30`.

### Added

- One-line installers for Windows / macOS / Linux: `install.ps1` and
  `install.sh` at the repository root, documented in `README.md`.
- `.gitattributes` to enforce LF for shell scripts and CRLF for
  PowerShell scripts.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) running
  `cargo fmt --check`, `cargo clippy`, and `cargo check --workspace`
  on Windows + Ubuntu.
- Bilingual architecture overview (`docs/architecture.en.md`,
  `docs/architecture.ja.md`).

## [2026.4.29] - 2026-04-29

First public release under the Apache License, Version 2.0.

### Added

- `LICENSE` and `NOTICE` at the repository root containing the full
  Apache 2.0 license text and product notice.
- `docs/release-notes-2026-04-29.md`, `docs/PRIVACY.md`,
  `docs/THIRD_PARTY_NOTICES.md`, and English + Japanese module guides
  under `docs/modules/`.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and
  `.github/` issue / pull-request templates.
- WebUI Help menu now opens License, Release Notes, Privacy
  Statement, About, and Contact panels rendered from
  `ui-shell/help/*.{en,ja}.md` directly in the right management
  panel.
- WebUI Help → Check for Updates queries the public GitHub Releases
  API for `sievepub-2000/octocode` and reports whether the running
  build matches the latest tag.
- WebUI Markdown rendering now supports KaTeX for `$...$`, `$$...$$`,
  `\(...\)`, and `\[...\]` math delimiters via `marked` +
  `katex-auto-render` (existing code-fence / highlight.js path is
  unchanged).
- Anthropic transport reads `ANTHROPIC_AUTH_TOKEN` as a third
  fallback (after `ANTHROPIC_API_KEY` and
  `OCTOCODE_ANTHROPIC_API_KEY`) and now sends both `x-api-key` and
  `Authorization: Bearer` headers to support gateway-style proxies
  such as `ai.jiexi6.cn`.
- Per-turn `session.model` resolution: each turn pins the exact model
  recorded on the session even when the global default is changed
  elsewhere.
- New `stub_fallback_active` flag on the runtime snapshot so the CLI,
  WebUI, and Canvas shell can clearly surface the case where every
  configured provider has failed and the local stub is echoing.
- `scripts/octocode-up.ps1` and `scripts/octocode-down.ps1` for
  one-key WebUI start/stop with zombie-process cleanup before bind.

### Changed

- Workspace `license` is now `Apache-2.0` (was `MIT`) and version
  bumped to `2026.4.29`.
- WebUI default UI locale is now `en-US` (was `zh-CN`); the four
  bundled locales `en-US`, `ja-JP`, `ko-KR`, `zh-CN` are still all
  fully selectable from View → Language.

## [Unreleased]

### Added — Phase 7 release-hardening (Windows-first)

- **T1 Auth token hardening** — bearer token now resolves via
  `OCTOCODE_BEARER_TOKEN` env, `OCTOCODE_BEARER_TOKEN_FILE` env, or
  auto-generated random secret, in that order. Startup log prints the
  source so operators can confirm which path was used.
- **T6 Operability metrics** — `/metrics` now exposes
  `octocode_agent_iterations_total` and `octocode_circuit_open_total`
  Prometheus counters in addition to the existing request / chat /
  tool / session / memory series.
- **T10 Config schema version** — `octocode.conf` now serialises a
  `config_version=1` line (constant `octocode_core::CONFIG_SCHEMA_VERSION`).
  Older configs without the field are read as version 0 and rewritten to
  the current schema on next save.
- **T13 self-review --cron** — `octocode self-review --cron <secs>`
  now runs the triage report on a periodic loop and appends each report
  as a JSONL record to `<data_home>/self-review-history.jsonl` for
  long-running agent installations.
- **T14 Security headers** — every HTTP response now carries
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and a strict
  `Content-Security-Policy` (script/style/connect pinned to `'self'` +
  loopback). `Access-Control-Allow-Origin` is restricted from `*` to
  `http://127.0.0.1`.

### Added — Phase 5/6 baseline

- Parallel `/api/health` provider probe with 15s TTL response cache.
- Configurable agent-loop iteration cap (`agent_max_iterations`,
  default 12, hard cap 64).
- SSE `: keepalive` heartbeat (15s default interval) and
  `/api/events?since=<ms>` resume on top of `Last-Event-ID`.
- `/api/sessions/cancel` alias.
- Self-review CLI subcommand and skill (`skills/self-review/`).
- EWMA-aware provider router ordering (α=0.3).
- `octocode-cli` server module split: `server_cache.rs` extracted for
  health/config/heartbeat caches.

### Notes

- Linux and macOS builds remain compile-clean but are not actively
  smoke-tested in this phase. Windows is the validated platform.
- WebUI port range remains `990-999`.
- Test baseline: `cargo test --workspace --no-fail-fast` runs to a
  clean pass; `cargo clippy --workspace --all-targets -- -D warnings`
  has zero warnings on Windows.

## [0.0.0] - history

Pre-release iterations are documented under `docs/` (analysis,
roadmap, iteration reports). They are not enumerated here.
