// Real WebUI end-to-end test for the chat → text-parser → tool-registry
// dispatch path. Requires the server to be running on 127.0.0.1:<port>
// and the active provider to be `stub` (so it echoes back the user text,
// which keeps the flow deterministic without depending on an LLM).
//
// Usage: node scripts/live-chat-toolcall.mjs <port> <sessionId>
// Exit 0 on pass, non-zero on failure.

import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.argv[2] || 999);
const SESSION_HINT = process.argv[3] || 'liveqa';
const WS_ROOT = path.resolve('.');
const TARGET_FILE = path.join(WS_ROOT, 'test.text');
const TARGET_CONTENT = '你好，世界！';

function rawRequest(method, pathAndQuery, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathAndQuery,
        method,
        headers: {
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchToken() {
  const res = await rawRequest('GET', `/ui-shell/?session=${SESSION_HINT}`);
  const m = res.body.match(/window\.__OCTOCODE_AUTH_TOKEN__="([^"]+)"/);
  if (!m) throw new Error('auth token not in shell');
  return m[1];
}

async function ensureStubProvider(token) {
  const body = new URLSearchParams({
    sessionId: SESSION_HINT,
    providerId: 'stub',
    permissionMode: 'workspace-write',
  }).toString();
  const res = await rawRequest('POST', '/api/settings', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Auth-Token': token,
    },
    body,
  });
  if (!res.ok) throw new Error(`settings failed: ${res.status}`);
}

async function main() {
  try {
    fs.unlinkSync(TARGET_FILE);
  } catch (_) {}

  const token = await fetchToken();
  await ensureStubProvider(token);

  const browser = await chromium.launch({
    args: [`--explicitly-allowed-ports=${PORT}`],
  });
  const ctx = await browser.newContext();
  await ctx.setExtraHTTPHeaders({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text());
  });

  const url = `http://127.0.0.1:${PORT}/ui-shell/?session=${SESSION_HINT}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat-input', { state: 'attached', timeout: 15000 });
  // Give session-controller its ensureWritableSession handshake budget.
  await page.waitForFunction(() => {
    const s = document.getElementById('composer-session')?.textContent || '';
    return /session:\s*\S+/.test(s);
  }, { timeout: 15000 });
  await page.waitForTimeout(600);

  const prompt =
    `<|tool_call>tool-create-file(path="test.text", content="${TARGET_CONTENT}")<tool_call|>`;

  await page.fill('#chat-input', prompt);
  await page.click('#chat-submit');

  // Wait for the runtime to stream back the execution marker into the DOM.
  let uiSawExecuting = false;
  try {
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll('#message-list .message, #message-list *');
        for (const n of nodes) {
          const t = n.textContent || '';
          if (t.includes('[executing: create-file]') || t.includes('created ')) return true;
        }
        return false;
      },
      null,
      { timeout: 20000 },
    );
    uiSawExecuting = true;
  } catch (_) {
    uiSawExecuting = false;
  }

  // Assert the file was actually created by the tool dispatch.
  let fileOk = false;
  let fileContent = '';
  for (let i = 0; i < 30 && !fileOk; i++) {
    try {
      fileContent = fs.readFileSync(TARGET_FILE, 'utf-8');
      fileOk = fileContent === TARGET_CONTENT;
    } catch (_) {}
    if (!fileOk) await new Promise((r) => setTimeout(r, 200));
  }

  // Snapshot the DOM transcript so we can compare WebUI output to a
  // direct CLI-runtime output for parity.
  const transcript = await page.evaluate(() => {
    const nodes = document.querySelectorAll('#message-list .message, #message-list *');
    const out = [];
    nodes.forEach((n) => {
      const role = n.getAttribute?.('data-role') || n.className || '';
      const text = (n.textContent || '').trim();
      if (text) out.push(`${role}: ${text.slice(0, 800)}`);
    });
    return out.join('\n---\n');
  });

  await browser.close();

  // Compare to the CLI path: POST /api/chat directly with the same text.
  // Both code paths go through runtime.prompt_in_session, so the session
  // transcripts must match structurally (stub echo + tool dispatch).
  const cliSession = SESSION_HINT + '-cli';
  const chatBody = new URLSearchParams({ sessionId: cliSession, text: prompt }).toString();
  await rawRequest('POST', '/api/chat', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Auth-Token': token,
    },
    body: chatBody,
  });
  const cliSnap = await rawRequest('GET', `/api/state?session=${cliSession}`, {
    headers: { 'X-Auth-Token': token },
  });
  const cliSeesCreateFile =
    cliSnap.body.includes('create-file') && cliSnap.body.includes('created');

  const pass = fileOk && uiSawExecuting && cliSeesCreateFile;
  const report = {
    uiSawExecuting,
    fileOk,
    fileContent,
    cliSeesCreateFile,
    transcriptPreview: transcript.slice(0, 600),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
