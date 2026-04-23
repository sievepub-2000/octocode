---
name: naive-ui
description: Vue-ecosystem component library. Registered as a UI reference for `ui-shell/` — OctoCode's WebUI is vanilla HTML + IIFE JS today, but Naive UI patterns inform component boundaries for the P9 modularization.
source: https://github.com/tusen-ai/naive-ui
integration: reference-only
status: descriptor-only
---

# naive-ui

Descriptor-only registration (P9 batch).

## Why registered
- Clean component API (`n-button`, `n-modal`, `n-drawer`) is a good target shape for the future `ui-shell/modules/*` split.

## Integration plan (deferred)
- OctoCode's WebUI will **not** depend on Vue. Instead, adopt the same "stateless render + controlled props" discipline in the upcoming ES-module refactor.
