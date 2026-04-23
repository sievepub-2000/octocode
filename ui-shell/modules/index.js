// Octocode Workbench — modular entry point (P2 scaffold).
//
// Migration status: app.js (v8, ~3200 lines, IIFE-style) remains authoritative.
// This module is loaded alongside app.js via `<script type="module">` in
// future revisions; for now it exposes a minimal namespace so individual
// feature modules can be migrated incrementally without breaking id/class
// contracts documented in docs/webui-contracts.md (to be created).
//
// Migration plan:
//   1. Extract pure helpers (authHeaders, formatters) → modules/helpers.js
//   2. Extract renderers (renderMessages, renderSidebar) → modules/render.js
//   3. Extract transport (fetchJSON, ws) → modules/transport.js
//   4. Extract state store → modules/state.js
//   5. Flip index.html to use type="module" and remove from app.js
//
// Guardrail: every migrated module must expose the same globals currently
// referenced by inline event handlers (none at time of writing, but grep
// confirms no `onclick="fn()"` attributes inside ui-shell/index.html).

export const OctocodeModuleRegistry = {
  version: '0.1.0-p2-scaffold',
  migrated: [],
  register(name) {
    if (!this.migrated.includes(name)) this.migrated.push(name);
  },
};

// Attach to window for dev-tool introspection only.
if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-underscore-dangle
  window.__OCTOCODE_MODULES__ = OctocodeModuleRegistry;
}
