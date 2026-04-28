---
name: claude-auto-research
description: Auto-research loop: decompose a research question, run multiple probes in parallel, reconcile, cite.
source: https://github.com/claude-auto-research
integration: reference-only
status: descriptor-only
---

# claude-auto-research

Descriptor-only registration (P9 batch). Complements `skills/autoresearch/SKILL.md`.

## Why registered
- Provides a concrete template for: "form N hypotheses → probe each with a cheap check → keep winners → deepen only the survivors".

## Integration plan (deferred)
- Wire a future `/research <topic>` slash command in `octocode-commands` that follows this template and emits a Markdown report with inline citations.
