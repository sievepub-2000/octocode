---
name: spec-kit
description: Octocode spec execution skill for converting requests into runtime, CLI, and Canvas UI delivery slices.
---

# spec-kit

Use this skill to frame Octocode work before editing.

## When to use

- A task spans runtime, CLI, desktop shell, or Canvas UI.
- You need to preserve the runtime layering rules in CLAUDE.md.
- You are preparing a deep architectural review.

## Instructions

1. Define the user or operator outcome first.
2. Map it to the owning Octocode layer: core, api, runtime, cli, or ui-shell.
3. State the affected contract, runtime truth source, and validation path.
4. Prefer one layer boundary per implementation slice.
5. Flag any coupling that pushes business logic into ui-shell or cli when runtime should own it.
6. For analysis, summarize overall architecture, each crate, UI-shell, scripts, and docs.