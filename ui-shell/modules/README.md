# UI Shell Modules (P2 Scaffold)

This directory is the **incremental migration target** for `ui-shell/app.js` (currently ~3200 lines, IIFE-style).

## Status

- **P2**: Empty scaffold established; `modules/index.js` exposes `OctocodeModuleRegistry` for instrumentation.
- **P3** (planned): Extract pure helpers (`authHeaders`, formatters) into `modules/helpers.js`.
- **P4** (planned): Extract renderers (`renderMessages`, `renderSidebar`) into `modules/render.js`.
- **P5** (planned): Flip `index.html` to `<script type="module">` and retire `app.js` IIFE.

## Why Deferred

The full module conversion requires a running WebUI smoke test to catch regressions (click handlers, SSE reconnection, model-list race). This environment cannot verify WebUI behavior without a live browser session. Doing a cosmetic split would risk a broken stream indicator or auth flow that is invisible to static checks.

## Migration Contract

Every extracted module must:
1. Preserve the DOM id/class contract (see `docs/webui-contracts.md`, TBD).
2. Export a `register()` call so `OctocodeModuleRegistry.migrated` tracks coverage.
3. Ship with a dedicated Playwright or manual checklist entry.
