---
name: claude-mem
description: Long-running memory layer for Claude-style agents. Reference for OctoCode's own `/memories/` scope design (user / session / repo).
source: https://github.com/claude-mem
integration: reference-only
status: descriptor-only
---

# claude-mem

Descriptor-only registration (P9 batch).

## Why registered
- This workspace already ships a structured memory contract (see `copilot-instructions.md` — `/memories/`, `/memories/session/`, `/memories/repo/`). `claude-mem` is cross-reference for eviction policies, recall ranking, and leakage prevention.

## Integration plan (deferred)
- No code change. Use as rubric when reviewing memory writes:
  - User-scope entries ≤ a few lines, topic-indexed.
  - Session entries transient, auto-expire at conversation close.
  - Repo-scope entries fact-only, no secrets.
