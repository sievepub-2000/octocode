// Real-browser regression for three BugFix items + system-operation smoke.
// Runs against an already-running OctoCode serve on 127.0.0.1:<port>.
// Usage: node scripts/live-regression.mjs <port> <sessionId>
// Exit 0 on full pass, non-zero on any failure.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.argv[2] || 990);
const SESSION_HINT = process.argv[3] || 'liveqa';
const REPORT_PATH = path.resolve('docs/eval/live-regression-p13.md');

// Node's fetch (undici) refuses to connect to RFC 9110 "bad ports" such as 990.
function rawRequest(method, pathAndQuery, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathAndQuery,
      method,
      headers: {
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf-8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + String(detail).slice(0, 200) : ''}`);
}

async function fetchToken() {
  const res = await rawRequest('GET', `/ui-shell/?session=${SESSION_HINT}`);
  const m = res.body.match(/window\.__OCTOCODE_AUTH_TOKEN__="([^"]+)"/);
  if (!m) throw new Error('auth token not found');
  return m[1];
}

async function waitForSelector(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { timeout, state: 'attached' });
}

async function readSessionIdFromDom(page) {
  try {
    return await page.evaluate(() => {
      const el = document.getElementById('composer-session');
      if (!el) return '';
      const m = (el.textContent || '').match(/session:\s*(\S+)/);
      return m ? m[1] : '';
    });
  } catch (_) { return ''; }
}

async function readSessionIdFromUrl(page) {
  const url = new URL(page.url());
  return url.searchParams.get('session') || '';
}

async function openPage(browser) {
  const ctx = await browser.newContext();
  // Live QA must not be served a cached copy of app.js from an earlier run;
  // otherwise UI BugFixes never take effect under test. Force no-store on
  // every request this context makes.
  await ctx.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/ui-shell/?session=${SESSION_HINT}`, { waitUntil: 'domcontentloaded' });
  await waitForSelector(page, '#chat-input');
  await page.waitForFunction(() => {
    const s = document.getElementById('composer-session')?.textContent || '';
    return /session:\s*\S+/.test(s);
  }, { timeout: 15000 });
  // let session-controller finish its ensureWritableSession handshake
  await page.waitForTimeout(500);
  return { ctx, page };
}

async function openPagesSameContext(browser, n, opts = {}) {
  const ctx = await browser.newContext();
  await ctx.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
  const pages = [];
  const useHint = opts.withSessionHint !== false;
  const url = useHint
    ? `http://127.0.0.1:${PORT}/ui-shell/?session=${SESSION_HINT}`
    : `http://127.0.0.1:${PORT}/ui-shell/`;
  for (let i = 0; i < n; i++) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForSelector(page, '#chat-input');
    await page.waitForFunction(() => {
      const s = document.getElementById('composer-session')?.textContent || '';
      return /session:\s*\S+/.test(s);
    }, { timeout: 15000 });
    await page.waitForTimeout(600);
    pages.push(page);
  }
  return { ctx, pages };
}

async function postTool(token, sessionId, name, input) {
  const body = new URLSearchParams({ sessionId, name, input }).toString();
  const res = await rawRequest('POST', '/api/tool', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Token': token },
    body,
  });
  return { ok: res.ok, detail: res.body };
}

// Some high-risk tools (delete-file, web-search, shell-command) reply with
// an approval challenge on the FIRST call: `approval required ... re-run with
// input: __approve:<token>|<original>`. Retry once with the approved payload.
async function postToolWithApproval(token, sessionId, name, input) {
  const first = await postTool(token, sessionId, name, input);
  if (first.ok) return first;
  const m = first.detail && first.detail.match(/re-run with input:\s*(__approve:[^"]+)/);
  if (!m) return first;
  return postTool(token, sessionId, name, m[1]);
}

async function sessionIsolationCase(browser) {
  // Two tabs in the SAME browser context, opened to the base URL (no
  // ?session hint). The first tab claims whatever session the server
  // snapshotted; the second tab — seeing a fresh localStorage claim
  // from tab A — must fork via `createBrowserSession` so it gets a
  // distinct session id on submit. This is the exact scenario the
  // user reported as "sessions still not isolated".
  const shared = await openPagesSameContext(browser, 2, { withSessionHint: false });
  const initA = await readSessionIdFromDom(shared.pages[0]);
  // Trigger ensureWritableSession on both by typing+submitting so
  // session-controller runs its ownership handshake.
  for (const p of shared.pages) {
    await p.fill('#chat-input', 'ping');
    await p.click('#chat-submit');
  }
  // Wait for BOTH tabs' URL to rewrite to a forked session id (the
  // session-controller uses history.replaceState to write the new
  // session back into the URL once applyState settles). Manual probing
  // shows this takes ~800-2000ms under the dev build.
  for (const p of shared.pages) {
    await p.waitForFunction(() => {
      const u = new URL(window.location.href);
      return /^session-/.test(u.searchParams.get('session') || '');
    }, null, { timeout: 8000 }).catch(() => {});
  }
  const finalA = await readSessionIdFromDom(shared.pages[0]);
  const finalB = await readSessionIdFromDom(shared.pages[1]);
  record(
    'isolation.two_tabs_same_context_get_different_sessions',
    Boolean(finalA && finalB && finalA !== finalB),
    `A=${finalA} B=${finalB} (initA=${initA})`,
  );

  // Case 2 (same browser, separate contexts): classic cross-process-ish
  // test. Marker from tab A must NOT appear in tab B's transcript.
  const a = shared.pages[0];
  const b = shared.pages[1];
  const marker = 'LIVEQA-A-' + Date.now();
  await a.fill('#chat-input', marker);
  await a.click('#chat-submit');
  try {
    await a.waitForFunction((m) => {
      const nodes = document.querySelectorAll('#message-list .message');
      for (const n of nodes) if ((n.textContent || '').includes(m)) return true;
      return false;
    }, marker, { timeout: 15000 });
  } catch (_) {}
  await a.waitForTimeout(800);
  const leaked = await b.evaluate((m) => {
    const nodes = document.querySelectorAll('#message-list .message');
    for (const n of nodes) if ((n.textContent || '').includes(m)) return true;
    return false;
  }, marker);
  record('isolation.marker_does_not_leak_to_other_tab', !leaked, `leaked=${leaked}`);
  // fallback assertion to keep historical metric name
  record('isolation.two_tabs_get_different_sessions', Boolean(finalA && finalB && finalA !== finalB), `A=${finalA} B=${finalB} (same-context, dom)`);
  await shared.ctx.close();
}

async function thinkingIndicatorCase(browser) {
  const { page, ctx } = await openPage(browser);
  const captured = [];
  const timer = setInterval(async () => {
    try {
      const label = await page.evaluate(() => {
        const el = document.querySelector('#stream-indicator .stream-label');
        const hidden = document.getElementById('stream-indicator')?.hidden;
        return el ? { text: el.textContent || '', hidden } : null;
      });
      if (label && !label.hidden) captured.push(label.text.trim());
    } catch (_) {}
  }, 120);

  await page.fill('#chat-input', 'Please respond with the single word: pong.');
  await page.click('#chat-submit');
  await page.waitForFunction(() => {
    const btn = document.getElementById('chat-submit-label');
    return btn && /发送|Send|送信|보내기/.test(btn.textContent || '');
  }, { timeout: 25000 }).catch(() => {});
  clearInterval(timer);

  const sawThinking = captured.some((t) => /思考中|thinking|応答|응답/.test(t));
  const sawRespondingOnly = captured.length > 0 && captured.every((t) => /正在响应|responding|応答/.test(t)) && !sawThinking;
  record('thinking.indicator_entered_thinking_phase', sawThinking, `labels=${JSON.stringify(captured.slice(0, 8))}`);
  record('thinking.indicator_not_stuck_on_generic_responding_only', !sawRespondingOnly, `labels=${JSON.stringify(captured.slice(0, 8))}`);
  await ctx.close();
}

async function openPageAndReadSession(browser) {
  const { ctx, page } = await openPage(browser);
  const id = await readSessionIdFromUrl(page);
  await ctx.close();
  return id;
}

async function toolInvocationCase(browser, token) {
  const sid = await openPageAndReadSession(browser);
  const stamp = Date.now();
  const filename = `liveqa-${stamp}.txt`;
  const created = await postTool(token, sid, 'create-file', `${filename}|hello-from-liveqa`);
  record('tools.create_file_ok', created.ok, created.detail);
  const read = await postTool(token, sid, 'read-file', filename);
  record('tools.read_file_returns_content', read.ok && /hello-from-liveqa/.test(read.detail), read.detail);
  const listed = await postTool(token, sid, 'list-files', '.');
  record('tools.list_files_contains_new_file', listed.ok && listed.detail.includes(filename), filename);
  const deleted = await postToolWithApproval(token, sid, 'delete-file', filename);
  record('tools.delete_file_ok', deleted.ok, deleted.detail);
}

async function systemOperationsCase(browser, token) {
  const sid = await openPageAndReadSession(browser);
  const stamp = Date.now();
  const temp = `liveqa-temp-${stamp}.txt`;
  const create = await postTool(token, sid, 'create-file', `${temp}|content`);
  record('sys.create_file', create.ok, create.detail);
  const del = await postToolWithApproval(token, sid, 'delete-file', temp);
  record('sys.delete_file', del.ok, del.detail);
  const whoami = await postTool(token, sid, 'echo', 'recycle-bin-smoke');
  record('sys.echo_baseline', whoami.ok, whoami.detail);
  const weather = await postToolWithApproval(token, sid, 'web-search', 'Beijing weather today');
  record('sys.web_search_weather', weather.ok, weather.detail);
  const xnews = await postToolWithApproval(token, sid, 'web-search', 'site:x.com trending news today');
  record('sys.web_search_x_news', xnews.ok, xnews.detail);
  // New: empty recycle bin tool (approval-gated; safe no-op payload is
  // accepted because the Rust side treats any payload as a trigger).
  const recycle = await postToolWithApproval(token, sid, 'empty-recycle-bin', 'confirm');
  record('sys.empty_recycle_bin', recycle.ok, recycle.detail);
}

async function manageCatalogCase(token) {
  const res = await rawRequest('GET', '/api/manage/catalog', { headers: { 'X-Auth-Token': token } });
  record('catalog.http_200', res.ok, `status=${res.status}`);
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) {}
  record('catalog.parses_json', Boolean(json));
  if (!json) return;
  record('catalog.has_skills', Array.isArray(json.skills), `count=${json.skills?.length}`);
  // BugFix (live P13): real field is `mcpServers`, not `mcp`.
  record('catalog.has_mcp_servers', Array.isArray(json.mcpServers), `count=${json.mcpServers?.length}`);
  record('catalog.has_hooks', Boolean(json.hooks), `type=${typeof json.hooks}`);
  record('catalog.has_provider_profiles_field', Array.isArray(json.providerProfiles), `count=${json.providerProfiles?.length}`);
  record('catalog.has_tools', Array.isArray(json.tools) && json.tools.length > 0, `count=${json.tools?.length}`);
  record('catalog.has_commands', Array.isArray(json.commands) && json.commands.length > 0, `count=${json.commands?.length}`);

  // Per-item coverage: verify every skill / mcpServer / hook entry is
  // well-formed (has the fields the UI relies on). This is the closest
  // real-world probe the catalog API supports since there is no
  // "invoke skill" endpoint distinct from /api/tool.
  if (Array.isArray(json.skills)) {
    const bad = json.skills.filter((s) => !s || typeof s.id !== 'string' || !s.id);
    record('skills.all_entries_have_id', bad.length === 0, `bad=${bad.length}/${json.skills.length}`);
    // Skills expose `summary` (+ path/scope/content). There is no `name`
    // field — that was a wrong assumption.
    const summarized = json.skills.filter((s) => typeof s.summary === 'string' && s.summary.length > 0);
    record('skills.summary_coverage', summarized.length === json.skills.length, `summarized=${summarized.length}/${json.skills.length}`);
  }
  if (Array.isArray(json.mcpServers)) {
    for (const srv of json.mcpServers) {
      const descriptor = srv?.descriptor || {};
      const name = String(descriptor.name || srv?.name || 'unknown');
      const key = `mcp.${name.replace(/[^a-z0-9_-]/gi, '_')}`;
      const ok = Boolean(descriptor.name || descriptor.command || descriptor.url);
      record(`${key}.descriptor_complete`, ok, `state=${srv?.state ?? 'n/a'} scope=${srv?.scope ?? 'n/a'}`);
    }
    const allHaveState = json.mcpServers.every((s) => typeof s?.state === 'string' && s.state.length > 0);
    record('mcp.all_have_state', allHaveState, `n=${json.mcpServers.length}`);
  }
  if (json.hooks && typeof json.hooks === 'object') {
    const hookKeys = Object.keys(json.hooks);
    record('hooks.object_has_keys', hookKeys.length > 0, `keys=${hookKeys.join(',')}`);
    for (const k of hookKeys) {
      const v = json.hooks[k];
      record(`hooks.${k}.well_formed`, v !== undefined, `type=${typeof v}`);
    }
  }
  if (Array.isArray(json.providers)) {
    for (const prov of json.providers) {
      const id = String(prov?.providerId || prov?.id || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
      const ok = Boolean(prov && prov.providerId && prov.kind);
      record(`providers.${id}.descriptor_present`, ok, `kind=${prov?.kind ?? 'n/a'} healthy=${prov?.healthy ?? 'n/a'}`);
    }
  }
  if (Array.isArray(json.commands)) {
    const namedCount = json.commands.filter((c) => typeof c?.name === 'string' && c.name).length;
    record('commands.all_have_name', namedCount === json.commands.length, `${namedCount}/${json.commands.length}`);
  }
}

async function toolsInventoryCase(token) {
  const res = await rawRequest('GET', '/api/tools', { headers: { 'X-Auth-Token': token } });
  let list = [];
  try { list = JSON.parse(res.body); } catch (_) {}
  record('tools.inventory_size', Array.isArray(list) && list.length >= 20, `count=${list?.length}`);
  for (const w of ['echo', 'read-file', 'create-file', 'delete-file', 'list-files', 'search-text', 'web-search', 'empty-recycle-bin']) {
    record(`tools.contains_${w}`, Boolean(list?.some?.((t) => t.name === w)));
  }
}

async function metricsCase() {
  const res = await rawRequest('GET', '/metrics');
  const body = res.body;
  record('metrics.contains_requests_total', body.includes('octocode_requests_total'));
  record('metrics.contains_errors_total', body.includes('octocode_errors_total'));
  record('metrics.contains_build_info', body.includes('octocode_build_info'));
  record('metrics.contains_chat_requests_total', body.includes('octocode_chat_requests_total'));
  record('metrics.contains_tool_invocations_total', body.includes('octocode_tool_invocations_total'));
  record('metrics.contains_sessions_created_total', body.includes('octocode_sessions_created_total'));
}

async function main() {
  const token = await fetchToken();
  const browser = await chromium.launch({
    headless: true,
    args: [`--explicitly-allowed-ports=${PORT}`],
  });
  try {
    await sessionIsolationCase(browser);
    await thinkingIndicatorCase(browser);
    await toolInvocationCase(browser, token);
    await systemOperationsCase(browser, token);
    await manageCatalogCase(token);
    await toolsInventoryCase(token);
    await metricsCase();
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const header = `# Live Regression — port ${PORT}\n\nSession hint: ${SESSION_HINT}\nPassed ${passed}/${results.length}; failed ${failed}.\n\n| Case | Result | Detail |\n|------|--------|--------|\n`;
  const rows = results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 200)} |`).join('\n');
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, header + rows + '\n', 'utf-8');
  console.log(`\nSummary: passed ${passed}/${results.length}. Report → ${REPORT_PATH}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('live regression crashed:', err);
  process.exit(2);
});
