---
name: lightpanda-headless-browser
description: Ultra-light headless browser for fast, low-memory WebUI smoke runs as an alternative to Chromium when a full Playwright stack is too heavy.
source: https://github.com/lightpanda-io/browser
integration: external-binary
---

# lightpanda-headless-browser

Use Lightpanda (a Rust/Zig-based headless browser) when you need a **fast, low-footprint** render of a page — e.g. CI smoke for OctoCode's WebUI on small runners, or probing that `/` returns a live DOM instead of a 500.

## When to use

- Quick liveness check of the WebUI before running a heavier Playwright suite.
- Headless rendering on resource-constrained environments (ARM, small VMs).
- Lightweight scraping of the page's rendered DOM when full Chromium is overkill.

## Requirements

- `lightpanda` binary on PATH, or resolved via the OctoCode `tools-hub` registry.

## Minimal invocation

```powershell
lightpanda http://127.0.0.1:10038 --timeout 5000 --dump-dom > tmp-lightpanda-dom.html
```

## Integration notes

- Pairs well with `playwright-webui-qa`: use Lightpanda for the "is it alive?" gate, then Playwright for semantic assertions.
- Intentionally does **not** replace Playwright for interaction-heavy flows (no full CDP coverage yet).
