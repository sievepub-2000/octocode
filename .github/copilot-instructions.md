Use the local Octocode skills as default context for every task in this repository.

Always consult these files first:
- skills/spec-kit/SKILL.md
- skills/vibecoding-guide/SKILL.md
- skills/get-shit-down/SKILL.md
- skills/autoresearch/SKILL.md
- CLAUDE.md

Repository-specific emphasis:
- spec-kit: convert requests into runtime, CLI, or UI-shell slices with explicit validation.
- vibecoding-guide: evaluate CLI and Canvas UI operator experience, especially state truth and affordances.
- get-shit-down: prefer one boundary at a time and validate on Windows.
- autoresearch: use experiment loops for architecture, routing, and provider behavior analysis.

Mandatory checks:
- prefer cargo check plus a focused CLI or UI validation for touched slices
- use runtime snapshots and event feeds as the source of truth
- keep Octocode master releasable