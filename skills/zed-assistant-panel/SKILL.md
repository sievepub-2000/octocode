---
name: zed-assistant-panel
description: Zed editor's Assistant Panel v2 (right-side dockable AI panel with thread history, inline tool-call disclosure, and slash-command palette). Registered as a UX reference for OctoCode's Canvas WebUI shell.
source: https://github.com/zed-industries/zed
integration: ui-reference
status: descriptor-only
---

# zed-assistant-panel

Descriptor-only registration. Reference design for OctoCode's WebUI/Canvas
shell, focused on the Assistant Panel v2 (`crates/assistant2` in zed).

## Why registered

OctoCode's WebUI already renders chat, tool calls, and a status bar;
Zed's Assistant Panel v2 sets the bar for:

1. **Right-side dockable panel** with a persistent thread list.
2. **Inline tool-call disclosure** — each call collapses to a compact
   row with one-click expand to args/result, exactly the surface our
   `tools.rs` registry can feed.
3. **Slash-command palette** for project-level prompts.
4. **Context pills** showing which files / selections were attached
   to the prompt.

## Integration plan (deferred to a UI-only iteration)

1. WebUI: dock thread list to the right rail, mirror current sessions.
2. WebUI: collapse tool-call cards to a single status row by default
   with disclosure to args/result; reuse the existing `ui-shell/app.js`
   stream handler — no runtime changes required.
3. WebUI: ensure `prefers-reduced-motion`, the `:focus-visible` ring,
   and the wabi-sabi token system already shipped continue to apply.

## Safety notes

- Pure UX reference; **no runtime contract changes**.
- Do not import code from upstream zed; keep the OctoCode WebUI MIT
  surface clean. Only design ideas are imported.
