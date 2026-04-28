---
name: self-review
description: |
  Periodic self-review skill for Octocode. Surfaces failure patterns,
  blocked tool calls, slow providers, and circuit-breaker activity from
  the last operating window so the agent can propose targeted improvements
  (config tuning, new skills, parser alias additions) and keep the
  self-iteration flywheel turning.
scope: workspace
---

# Self-Review Skill

This skill turns Octocode's own runtime telemetry into a short, actionable
review the agent can run at any time. It is the seed task for the
**self-iteration / self-evolution** track described in
[`docs/improvement-plan.md`](../../docs/improvement-plan.md) (P3 axis E6).

## When to invoke

Run this skill:

1. After a long task chain finishes, before starting the next one.
2. On a schedule (e.g. end of day) to summarize the day's signal.
3. Whenever `/api/health` shows a provider in `Open` circuit state for
   more than one cooldown window.

## Inputs the skill should read

The agent already has direct access to these surfaces — no new tools
needed:

| Source                          | What it provides                              |
| ------------------------------- | --------------------------------------------- |
| `GET /api/health`               | per-provider healthy / latency / detail       |
| `GET /api/manage/catalog`       | full provider/circuit/route/session catalog   |
| `GET /api/events?session=...`   | per-session event feed (tool_blocked etc.)    |
| `GET /metrics`                  | counters: chat_requests, errors, sessions     |
| Workspace `memory.jsonl`        | recent permanent-memory notes                 |
| Recent `tool_blocked` events    | parser misses worth aliasing                  |

Use `?since=<ms>` on `/api/events` to fetch only the new tail since the
last review.

## Output contract

Produce one Markdown report with these sections:

1. **Window** — start/end timestamps, total turns, total tool calls.
2. **Top 3 failures** — provider failures, tool errors, parser blocks.
   Cite event timestamps so they can be re-read.
3. **Slowest probes** — providers whose p95 latency moved up.
4. **Circuit activity** — any provider that opened/recovered.
5. **Proposed improvements** — concrete actions, each tagged as one of:
   - `config` — change `~/.config/octocode/octocode.conf`
     (e.g. `agent_max_iterations=20` for a long planning session).
   - `skill`  — write a new SKILL.md in `skills/<name>/SKILL.md`.
   - `parser` — propose a new alias for
     `crates/octocode-runtime/src/tool_call_parser.rs ::
     canonicalize_embedded_tool_name`.
   - `routing` — recommend reordering or disabling a provider.
6. **Diff suggestions** — for each `config` action, the exact key=value
   change. For `skill` actions, the proposed file path and a 5-line
   summary.

## Hard rules

1. **Never** propose changes that bypass the permission policy. Skills
   with workspace-write impact must surface the affected paths.
2. **Never** auto-apply a `parser` change. Output it as a suggestion in
   the report; a human must commit it.
3. Cap report length at ~400 lines — this is a triage doc, not an
   archive. Use the existing memory store for archival.
4. If `/api/health` returns the cached payload (look for `cachedAt`
   field), note this in the Window section so reviewers know the data
   is up to 15 s stale.

## Closing the loop

When the agent identifies a recurring `tool_blocked` name (≥ 3 hits in
the window), the next-action recommendation must be:

> "Add alias for `<blocked_name>` to `canonicalize_embedded_tool_name`
> in `crates/octocode-runtime/src/tool_call_parser.rs`."

When the agent identifies a provider that has been `Open` for the
entire window:

> "Demote `<provider_id>` in routing order, or disable it in
> `octocode.conf` until its outage is resolved."

These two patterns alone account for the majority of regressions seen
in Phase 3 of the runtime evaluation.
