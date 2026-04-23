# P13 — Deep evaluation and roadmap

Scope: this phase closed P13-A through P13-E plus three live-site bug fixes
and the naive-ui / pentagi vendoring drop-points. Each subtask is scoped
to the smallest reversible change that removes the observed failure mode.

## Phase ledger

| ID | Title | Status | Risk |
| --- | --- | --- | --- |
| P13-A | `tool_blocked` entries on event feed | shipped | low |
| P13-B | `/metrics` smoke test | shipped | low |
| P13-C | Approval UI argument preview | shipped | low |
| P13-D | `nvidia-free` system-fallback provider | shipped | medium |
| P13-E | Commit + push + eval report | shipped | low |
| BugFix-1 | Per-tab session isolation | shipped | medium |
| BugFix-2 | "Thinking" indicator wiring | shipped | low |
| BugFix-3 | Real tool-call execution across dialects | shipped | medium |
| naive-ui | Vendored reference drop-point | shipped | low |
| pentagi | Vendored reference drop-point (offensive-gated) | shipped | medium |

## Subtask notes

### P13-A — `tool_blocked` on the event feed

Added `translate_text_tool_calls_with_report` in
[crates/octocode-runtime/src/tool_call_parser.rs](crates/octocode-runtime/src/tool_call_parser.rs)
returning `ToolCallTranslation { calls, blocked }`. Unknown tool names
from both the structured (`<|tool_call>...<tool_call|>`) and loose
(`<|python_tag|>`, DeepSeek `<|tool_calls_begin|>`) parsing paths are
collected and pushed to the browser stream as `[tool_blocked: NAME]`
markers, plus persisted as a `System` transcript entry so snapshots
retain the audit trail. Three new unit tests cover the report shape.

### P13-B — `/metrics` smoke test

`render_metrics_body()` extracted as a pub fn in
[crates/octocode-cli/src/server.rs](crates/octocode-cli/src/server.rs) so
integration tests can assert the Prometheus text exposes all three
series (`octocode_requests_total`, `octocode_errors_total`,
`octocode_build_info{version="..."}`) without binding a socket.

### P13-C — Approval UI argument preview

[ui-shell/app.js](ui-shell/app.js) `runTool` now toasts a truncated
`toolName(arguments)` preview whenever `autoApprove` replays a blocked
tool call with the approval token. Locale keys `approval.preview` added
to `en-US` and `zh-CN` bundles.

### P13-D — `nvidia-free` system fallback

Registered a new provider id `nvidia-free` in
[crates/octocode-api/src/lib.rs](crates/octocode-api/src/lib.rs) whose
`BuiltinProvider::Fallback` chain is `[OpenAiCompatibleProvider →
StubProvider]`. Endpoint defaults to NVIDIA's keyless free
`integrate.api.nvidia.com/v1`; operators override via
`OCTOCODE_NVIDIA_FREE_BASE_URL` / `OCTOCODE_NVIDIA_FREE_API_KEY`. The
provider is **opt-in**, not auto-appended to every chain — that
constraint was deliberate: silently routing operator traffic to a third
party would break the existing provider-selection contract and the
stability guarantees documented in [docs/eval/](docs/eval/).
Descriptor at [skills/free-claude-code/SKILL.md](skills/free-claude-code/SKILL.md)
documents scope, safety invariants (no secrets, no PII), and P14
follow-ups (explicit `fallback_chain` config key; `octocode_provider_up`
health probe).

### BugFix-1 — Session isolation

Root cause: `applyState(state, sessionId)` in
[ui-shell/app.js](ui-shell/app.js) fell through to
`state.activeSession.summary.id` whenever the caller omitted the
sessionId. If another tab flipped the server's active session between
this tab's request and snapshot apply, the local `currentSessionId`
silently re-pointed, and subsequent submits landed on the wrong
transcript. Fix: pin `currentSessionId` to the caller-supplied id and
extract the transcript from the session object matching THAT id,
falling back to `state.sessions[]` lookup rather than
`state.activeSession`. The server-global `SHARED_COORDINATOR` /
`SHARED_TASK_STORE` statics remain as-is — they hold multi-agent team
state that is already keyed by session id internally and is intended to
be shared across the process.

### BugFix-2 — Thinking indicator

Root cause: the UI label branch depended on `phase === 'running'` AND
`turn?.activeSseClients > 0`, but both conditions become true only after
the server's next snapshot poll — which typically arrives after the
first tokens already stream in. Net effect: the label sat on "AI is
responding..." during the actual think window. Fix: the label and
visibility decision now prioritize client-observed state
(`isAwaitingFirstToken`, `isStreamingOutput`) over the server phase, so
the transition is "thinking → outputting → idle" and the recovery
fallback still covers SSE-disconnect windows.

### BugFix-3 — Real tool calls across dialects

Root cause: `prompt_stream_in_session` in
[crates/octocode-runtime/src/lib.rs](crates/octocode-runtime/src/lib.rs)
only called `parse_embedded_tool_calls`, which covers the Qwen-style
`<|tool_call>` block but not the DeepSeek `<|tool_calls_begin|>` or
Llama-3 `<|python_tag|>` dialects that recent providers emit. Models
returning those dialects produced tool-call-shaped output that the
runtime treated as plain prose. Fix: the loop now uses the unified
`translate_text_tool_calls_with_report`, which is the same entry point
P10 registered as the canonical translator, plus surfaces
`tool_blocked` entries (see P13-A) when a model asks for a tool the
runtime does not expose.

### naive-ui / pentagi drop-points

`third_party/naive-ui/README.md` and `third_party/pentagi/README.md`
pin upstream refs and document that both trees are reference-only. The
PowerShell fetch script `scripts/fetch-integrations.ps1` is
idempotent and refuses to fetch pentagi without `-AllowOffensive`; it
never executes fetched code. Skills
[skills/naive-ui/SKILL.md](skills/naive-ui/SKILL.md) and
[skills/pentagi/SKILL.md](skills/pentagi/SKILL.md) updated with the new
vendoring status.

## Validation

* `cargo test --workspace --quiet` → 336 passed, 0 failed.
* `cargo clippy --workspace --all-targets -- -D warnings` → clean.
* No new dependencies pulled; `nvidia-free` reuses the existing
  `OpenAiCompatibleProvider`.

## P14 candidates

1. Explicit operator-level `fallback_chain = [...]` config key so
   `nvidia-free` can be appended to an existing primary chain without
   editing code.
2. `octocode_provider_up{id="..."}` gauge emitted by `/metrics` once a
   lightweight health probe is in place.
3. Snapshot the `tool_blocked` counter on `/metrics` so operators can
   alert on sustained abuse (model repeatedly trying to call
   non-existent or disabled tools).
4. Extend BugFix-1 with a BroadcastChannel-based "session owner"
   handshake so tabs that duplicate via browser restore cannot both
   claim the same session id.
5. Surface the thinking / outputting state transitions to the event
   feed (not just the status indicator) so transcripts preserve the
   timeline for debugging.
