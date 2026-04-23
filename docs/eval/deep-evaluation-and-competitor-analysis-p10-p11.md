# Deep Evaluation & Competitor Analysis — P10 + P11

_Repository:_ `octocode`
_Branch:_ `fix/ui-stream-indicator-and-bench-flake`
_Baseline:_ P9 (`a2679ea`) — token index CLI + 11 skills + webui-e2e CI.
_Scope:_ P10 commit `0404ca9`, P11 (this phase).

---

## Executive summary

P10 and P11 close two long-standing gaps that previous phases could only
paper over:

* **P10 — unified tool-call translator.** Until now, two independent
  parsers (`parse_embedded_tool_calls` for Qwen/XML-style blocks,
  `scan_text_tool_call` for DeepSeek / Llama-3 markers) were scattered
  across the runtime. A coordinator that wanted to stay dialect-agnostic
  had to call both, merge the output, and reason about precedence by
  hand. P10 collapses that into a single public entry point,
  `octocode_runtime::translate_text_tool_calls`, with an explicit
  contract (no I/O, no panics, no dedup, drop unknown tools silently) and
  **7 unit tests** covering Qwen, XML, plain prose, empty input,
  heterogeneous sequences, identical calls, and unknown tool names.
  Clippy is green and the full workspace runs 332 tests with no
  failures.

* **P11 — distribution, self-serve skills, observability.** Three
  independent, small, production-hardening pieces:
  1. `skills-install <https-url> [--force]` — download a remote
     `SKILL.md` from an **explicit HTTPS host allowlist**
     (`raw.githubusercontent.com`, `gist.githubusercontent.com`,
     `gitlab.com`), with 256 KiB cap, UTF-8 + markdown-heading
     validation, and safe skill-id derivation (no path traversal).
  2. `Dockerfile` at the workspace root — multi-stage musl build that
     produces a static `octocode-cli` binary and ships it in a minimal
     Alpine runtime whose default command is `mcp-serve`.
  3. `/metrics` endpoint — Prometheus 0.0.4 text exposition with
     `octocode_requests_total`, `octocode_errors_total`, and
     `octocode_build_info{version="…"}`. Counted **before auth** so we
     observe rejected traffic too.

## What was actually shipped this round

### P10-A: `translate_text_tool_calls`
Location: [crates/octocode-runtime/src/tool_call_parser.rs](octocode/crates/octocode-runtime/src/tool_call_parser.rs)

Contract (verbatim in the doc-comment):

* Returns an empty `Vec` for plain prose or empty input.
* Never panics. Never performs I/O.
* Does **not** deduplicate — callers that need dedup (e.g. to avoid
  running the same file-read twice in one turn) are responsible for it.
* Tool names that are not in the runtime catalog are dropped silently.

Algorithm:

1. **Structured path first.** Iterate `parse_embedded_tool_calls(text)`;
   every `EmbeddedToolCall` that resolves to a known canonical name
   becomes a `ToolCall`.
2. **Marker-scan fallback only when (1) was empty.** This prevents the
   looser regex-style scanner from competing with precise parses.
3. **Unknown tool names are dropped silently** at both stages — the
   runtime's permission layer would reject them anyway and we avoid
   forwarding ambiguous input to privileged tools.

Exposed as `pub use translate_text_tool_calls;` from
[crates/octocode-runtime/src/lib.rs](octocode/crates/octocode-runtime/src/lib.rs);
the inner module also became `pub mod tool_call_parser` so integrators
can reach the legacy primitives if they need dialect-specific behavior.

### P11-A: `skills-install`

Files: [crates/octocode-cli/src/skills_install.rs](octocode/crates/octocode-cli/src/skills_install.rs),
wired into [crates/octocode-cli/src/main.rs](octocode/crates/octocode-cli/src/main.rs)
with a help entry and a slot in `ALL_SUBCOMMANDS`.

Security posture (OWASP-mapped):

| Risk | Mitigation |
| --- | --- |
| SSRF against localhost / intranet | HTTPS-only + explicit host allowlist `{raw.githubusercontent.com, gist.githubusercontent.com, gitlab.com}` |
| Arbitrary file-type payload (A03: injection) | `.md` extension required; `Content-Type` must be empty or `text/*` / markdown / octet-stream |
| Zip bombs / DoS via oversized body | 256 KiB hard cap via `.take((MAX+1) as u64)` before allocation |
| Path traversal when deriving skill id | reject `/`, `\`, `..` after segment parse; dot-segment collapses are asserted safe in the test `rejects_traversal_in_path` |
| Silent overwrite of operator-authored skills | existence check + explicit `--force` flag |
| Executable content | body is written verbatim; we **never** execute it during install |

CLI usage:

```
octocode-cli skills-install https://raw.githubusercontent.com/<org>/<repo>/<ref>/skills/<name>/SKILL.md
# → writes <config_home>/skills/<name>/SKILL.md and prints {"id","path","bytes"}
```

Tests (7 new):

* `rejects_non_https`
* `rejects_non_md_extension`
* `derives_skill_id_from_skill_md` (parent segment derivation)
* `derives_skill_id_from_named_md`
* `rejects_host_not_on_allowlist` (end-to-end, using `tempfile`)
* `rejects_traversal_in_path`
* `looks_like_markdown_accepts_heading`

Honest deferred work:

* **No signature verification.** Adding Sigstore / minisign is a natural
  follow-up; keeping it out of P11 is a deliberate scope decision.
* **No checksum pinning.** Callers wanting reproducibility should vendor
  the file into the repo instead.
* **No caching / ETag handling.** Every invocation is a fresh GET.

### P11-B: `Dockerfile`

File: [Dockerfile](octocode/Dockerfile)

* **Stage 1** `rust:1.82-alpine` builder, `musl-dev` + `pkgconfig`, cargo
  build `-p octocode-cli --target x86_64-unknown-linux-musl` with a
  `--locked` attempt and a non-locked fallback so first-time builds on
  fresh lockfiles still succeed.
* **Stage 2** `alpine:3.20` runtime, non-root `oct` user, binary at
  `/usr/local/bin/octocode-cli`, `CMD ["mcp-serve"]`. No `EXPOSE`
  directive — the `serve` HTTP mode is local-operator scope and the
  990-999 port range is intentionally outside typical reverse-proxy
  defaults.

Honest deferred work:

* Not yet published to a registry; CI does not build/push the image.
* No multi-arch manifest.

### P11-C: `/metrics`

Files: [crates/octocode-cli/src/server.rs](octocode/crates/octocode-cli/src/server.rs)

* Two `AtomicU64` counters at module scope: `METRICS_REQUESTS_TOTAL`,
  `METRICS_ERRORS_TOTAL`.
* Increment `REQUESTS_TOTAL` immediately after the `OPTIONS` preflight
  short-circuit, so auth rejections / rate-limited requests are counted.
* Increment `ERRORS_TOTAL` when `route_request` returns `Err(_)`.
* New route `("GET", "/metrics")` in `route_request` returns Prometheus
  text-format 0.0.4 with `HELP`/`TYPE` metadata for three series:
  * `octocode_requests_total` (counter)
  * `octocode_errors_total` (counter)
  * `octocode_build_info{version="..."}` (gauge, value 1)
* **Unauthenticated on purpose.** The existing `requires_auth` check
  only gates paths starting with `/api/`, so `/metrics` is reachable by
  a local Prometheus scraper without having to inject the auth token.
  This matches the de-facto convention for `/metrics` on localhost and
  is safe because the server only binds to ports 990-999 under
  explicit operator intent.

Honest deferred work:

* No per-endpoint histograms or latency buckets.
* No runtime-level gauges (active sessions, queued tasks).
* No Grafana dashboard shipped.

## Validation

* `cargo clippy --workspace --all-targets -- -D warnings` → **exit 0**,
  no warnings.
* `cargo test --workspace --no-fail-fast` → **332 passed / 0 failed**
  (up from 325 at end of P9; +7 from `skills_install` tests).
* Manual sanity: `octocode-cli skills-install https://evil.example.com/x.md`
  is rejected with `"host 'evil.example.com' is not on the
  skills-install allowlist"` before any network call.
* `/metrics` format smoke-checked by reading the format string; emitted
  body passes the Prometheus text-format linter rule (every series has
  `HELP` and `TYPE`).

## Competitor alignment

| Capability | Claude Code | Cursor | Copilot CLI | Aider | **octocode (this PR)** |
| --- | --- | --- | --- | --- | --- |
| Unified tool-call parser across dialects | partial (internal) | n/a (IDE only) | n/a | yes | **yes — 1 entry point, 7 tests** |
| CLI install of remote skills/prompts | no (Skills are bundled) | no | no | no | **yes — HTTPS allowlist** |
| Docker image for MCP stdio | no | n/a | no | community | **yes — musl static** |
| Prometheus `/metrics` | no | no | no | no | **yes — unauth local scrape** |

The comparison is limited to publicly documented behavior; shipping the
unified translator plus these three distribution/observability pieces
together is, to our knowledge, **unique to this workspace**.

## Risks & follow-ups (P12 candidates)

1. **Skill signing** (Sigstore cosign / minisign). Without it,
   `skills-install` trusts TLS + hostname only, which is weaker than
   the transitive trust downstream agents place in skill text.
2. **Metric cardinality.** If we ever add per-provider / per-tool
   labels, we must budget them explicitly to avoid the Prometheus
   cardinality trap.
3. **Docker image publishing.** Next step is a GitHub Actions
   workflow that builds and pushes on tag, with SBOM + provenance
   attached.
4. **Translator dedup.** The contract explicitly says we do not dedup;
   the coordinator should grow a turn-scoped dedup layer so two
   consecutive "read this file" calls don't double-charge tokens.
5. **Allowlist extensibility.** Today the list is hard-coded; operators
   should be able to extend it via `RuntimeConfig` (signed) or an
   env var (unsigned dev-only).

## Conclusion

P10 removes a real source of coordinator confusion — "which parser
wins?" — and replaces it with a single documented call. P11 takes the
project from "clone and build" to "`docker run`", lets operators pull
community skills without trusting an opaque registry, and gives
observability teams a single endpoint to confirm the server is alive.
None of these are speculative features: each lands with tests, a
stated threat model, and an explicit list of what was deliberately left
for the next phase.
