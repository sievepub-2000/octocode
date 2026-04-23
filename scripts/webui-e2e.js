// P9-C: Minimal Playwright WebUI smoke for CI.
//
// Launches a Chromium browser against the already-running `octocode-cli serve`
// on OCTOCODE_WEBUI_PORT (default 995) and asserts:
//   1. The index page returns HTTP 200.
//   2. The stream "AI 正在响应" indicator is NOT visible initially.
//   3. The Manage menu exposes a GitHub connection panel with the expected fields.
//
// Exits 0 on success, 1 on any failure. Writes a screenshot to
// `tmp-webui-github-panel.png` regardless of outcome.
//
// Requires the server's auth token. On Linux CI we read it from the temp
// file written by `octocode-cli serve` (`/tmp/octocode-auth-<port>.token`);
// on Windows it lives under `%TEMP%`.

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.OCTOCODE_WEBUI_PORT || 995);
const BASE = `http://127.0.0.1:${PORT}`;
const SCREENSHOT = 'tmp-webui-github-panel.png';

function readToken() {
  const tmp = os.tmpdir();
  const p = path.join(tmp, `octocode-auth-${PORT}.token`);
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (_e) {
    return null;
  }
}

async function main() {
  const token = readToken();
  if (!token) {
    console.error(`[webui-e2e] auth token file not found for port ${PORT}; aborting`);
    process.exit(1);
  }

  // Port 995 is blocked by Chromium by default; explicitly allow it.
  const browser = await chromium.launch({
    args: [`--explicitly-allowed-ports=${PORT}`],
  });
  const ctx = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: BASE,
          localStorage: [
            { name: 'octocode-auth-token', value: token },
          ],
        },
      ],
    },
  });
  const page = await ctx.newPage();

  const result = { port: PORT, steps: [] };
  let failed = false;

  try {
    const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = resp ? resp.status() : 0;
    result.steps.push({ goto: status });
    if (status !== 200) {
      console.error(`[webui-e2e] expected HTTP 200, got ${status}`);
      failed = true;
    }

    // Wait for app bootstrap.
    await page.waitForSelector('#manage-menu-button', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // (2) Stream indicator hidden initially.
    const indicatorHidden = await page.evaluate(() => {
      const el = document.getElementById('stream-indicator');
      if (!el) return true;
      return el.hidden === true || el.classList.contains('hidden');
    });
    result.indicator_hidden_initial = indicatorHidden;
    if (!indicatorHidden) {
      console.error('[webui-e2e] stream indicator should be hidden on empty page');
      failed = true;
    }

    // (3) Open Manage → GitHub panel.
    const menuBtn = await page.$('#manage-menu-button');
    if (menuBtn) {
      await menuBtn.click();
      await page.waitForTimeout(300);
      const ghBtn = await page.$('button[data-manage-panel="github"]');
      if (ghBtn) {
        await ghBtn.click();
        await page.waitForTimeout(500);
      }
    }
    const panel = await page.evaluate(() => {
      const section = document.getElementById('manage-panel-github');
      if (!section) return { present: false };
      const ids = [
        'github-auth-method',
        'github-username',
        'github-password',
        'github-token',
        'github-app-id',
        'github-installation-id',
        'github-private-key',
        'github-api-base',
        'github-scopes',
      ];
      const found = ids.filter((id) => document.getElementById(id)).length;
      return { present: true, foundFieldCount: found, expectedFieldCount: ids.length };
    });
    result.panel = panel;
    if (!panel.present || panel.foundFieldCount !== panel.expectedFieldCount) {
      console.error('[webui-e2e] GitHub panel fields incomplete:', panel);
      failed = true;
    }

    await page.screenshot({ path: SCREENSHOT, fullPage: true }).catch(() => {});
  } catch (err) {
    console.error('[webui-e2e] unexpected error:', err && err.message);
    failed = true;
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('[webui-e2e] fatal:', e);
  process.exit(1);
});
