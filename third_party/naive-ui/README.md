---
upstream: https://github.com/tusen-ai/naive-ui
pinned-ref: v2.38.2
license: MIT
---

# naive-ui (vendored drop-point)

[Naive UI](https://github.com/tusen-ai/naive-ui) is a Vue 3 component
library. OctoCode's current `ui-shell/` is vanilla JS — we keep naive-ui
here as a **design reference** and as the source of truth for the
component catalog that the `naive-ui` skill descriptor
([../../skills/naive-ui/SKILL.md](../../skills/naive-ui/SKILL.md))
points at.

## How OctoCode uses this drop-point

1. Operator runs `pwsh scripts/fetch-integrations.ps1` to clone
   `naive-ui@v2.38.2` into `third_party/naive-ui/src/`.
2. WebUI designers reference `src/demo/` when deciding a component
   vocabulary for new OctoCode WebUI panels.
3. Nothing under `src/` is bundled into OctoCode. Any future panel that
   wants a naive-ui component must be rewritten in vanilla JS or
   introduced via a separate, opt-in Vue build pipeline behind the
   `integrations.naive_ui.enabled` config flag.

## Why pinned

Keeps the design-reference stable so descriptions in SKILL.md don't
drift against upstream breaking changes.
