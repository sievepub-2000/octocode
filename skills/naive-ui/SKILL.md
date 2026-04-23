---
name: naive-ui
description: Vue-ecosystem component library. Registered as a UI reference for `ui-shell/` — OctoCode's WebUI is vanilla HTML + IIFE JS today, but Naive UI patterns inform component boundaries for the ongoing modularization.
source: https://github.com/tusen-ai/naive-ui
integration: reference-only
status: vendored-reference
vendored-at: third_party/naive-ui
pinned-ref: v2.38.2
---

# naive-ui

Promoted from descriptor-only to **vendored-reference** in P13. The upstream
tree is cloned on demand into [third_party/naive-ui/src/](../../third_party/naive-ui/README.md)
by `pwsh scripts/fetch-integrations.ps1`. Nothing from that tree is linked
into any Cargo build.

## Why registered
- Clean component API (`n-button`, `n-modal`, `n-drawer`) is a good target shape for the future `ui-shell/modules/*` split.
- Having a local clone lets WebUI designers diff component behavior against a pinned reference without outbound network access.

## Integration plan (deferred)
- OctoCode's WebUI will **not** depend on Vue. Instead, adopt the same "stateless render + controlled props" discipline in the upcoming ES-module refactor.
- Any future panel that wants a real naive-ui component must ship behind `integrations.naive_ui.enabled = true` and go through a separate Vue build pipeline — it will not be merged into the vanilla `ui-shell/`.
