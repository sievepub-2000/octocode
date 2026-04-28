---
name: playwright-webui-qa
description: Drive the OctoCode WebUI (and other web targets) via Microsoft Playwright to perform real end-to-end verification, screenshots, and DOM assertions.
source: https://github.com/microsoft/playwright
integration: external-binary
---

# playwright-webui-qa

Use this skill whenever a task requires **real** browser-level verification of the WebUI or any web target. This is the default "UI truth" skill — it replaces any claim of "the page should work" with an observable run.

## When to use

- Verifying the OctoCode WebUI renders, loads SSE, and the indicator logic behaves correctly.
- Regressing chat flow, command palette, management panels (including GitHub connection).
- Capturing screenshots to evidence a delivered UI change.
- Automating click / type / assert sequences against any web app under test.

## Requirements

- `npx playwright install chromium` available on the host, or a pre-installed Playwright cache.
- Network access to the target URL (default `http://127.0.0.1:10038` for OctoCode).

## Minimal invocation

```powershell
npx --yes playwright@latest codegen http://127.0.0.1:10038
```

For scripted smoke:

```powershell
node - <<'JS'
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:10038');
  await p.waitForSelector('#manage-menu-button');
  await p.click('#manage-menu-button');
  await p.click('[data-manage-panel="github"]');
  await p.screenshot({ path: 'tmp-webui-github-panel.png', fullPage: true });
  await b.close();
})();
JS
```

## Integration notes

- This skill is a **descriptor**: the actual Playwright binaries are resolved at runtime via `npx` or a workspace-installed `node_modules/.bin/playwright`.
- The skill does **not** ship a browser. It assumes the caller will run `playwright install` once per machine.
- For OctoCode's own CI, wire this into `.github/workflows/cli-smoke.yml` under a `webui-e2e` job gated on label `run-webui-e2e` to avoid pulling 250MB on every push.
