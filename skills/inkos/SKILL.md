---
name: inkos
description: Ink-style terminal UI toolkit reference. Registered as a UX study for CLI components; OctoCode's terminal surface already uses crossterm + portable-pty but borrows composition ideas from inkos.
source: https://github.com/inkos
integration: reference-only
status: descriptor-only
---

# inkos

Descriptor-only registration (P9 batch).

## Why registered
- Component composition model (box/stack/flex) is a good mental model for the future split of `crates/octocode-cli/src/tui.rs` into reusable widgets.

## Integration plan (deferred)
- No runtime dependency added. The skill is **pure reference** — expected outcome is a refactor of `tui.rs` into a small widget trait (`fn render(&self, area: Rect, buf: &mut Buffer)`).
