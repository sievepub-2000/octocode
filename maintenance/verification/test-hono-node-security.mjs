import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const pkg = path.resolve(process.argv[2]);
const require = createRequire(path.join(pkg, 'package.json'));
const { Hono } = require('hono');
const { serve } = await import(pathToFileURL(path.join(pkg, 'dist/index.mjs')));
const { serveStatic } = await import(pathToFileURL(path.join(pkg, 'dist/serve-static.mjs')));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-hono-security-'));
fs.mkdirSync(path.join(fixture, 'static/admin'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'static/admin/secret.txt'), 'owned private fixture');
fs.writeFileSync(path.join(fixture, 'static/public.txt'), 'public fixture');
const app = new Hono();
app.use('/static/admin/*', c => c.text('Unauthorized', 401));
app.use('/static/*', serveStatic({ root: fixture }));
app.post('/echo', async c => c.json(await c.req.json()));
let server;
try {
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (requestPath, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: requestPath, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Owned HTTP fixture timed out')));
    req.on('error', reject); req.end(body);
  });
  for (const url of ['/static/admin/secret.txt', '/static/%61dmin/secret.txt']) {
    assert.equal((await request(url)).status, 401);
  }
  const attack = await request('/static/%%36%31dmin/secret.txt');
  assert.equal(attack.status, 404, 'Double decoding must not bypass protected static middleware');
  assert(!attack.text.includes('owned private fixture'));
  assert.deepEqual(await request('/static/public.txt'), { status: 200, text: 'public fixture' });
  assert.deepEqual(await request('/static/public.txt', 'HEAD'), { status: 200, text: '' });
  const range = await request('/static/public.txt', 'GET', { range: 'bytes=0-5' });
  assert.deepEqual(range, { status: 206, text: 'public' });
  const echo = await request('/echo', 'POST', { 'content-type': 'application/json' }, '{"owned":true}');
  assert.equal(echo.status, 200); assert.deepEqual(JSON.parse(echo.text), { owned: true });
  console.log(JSON.stringify({ status: 'PASS', staticAuth: true, encodedPathRejected: true, getHeadRange: true, jsonPost: true }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith('octocode-hono-security-'));
  fs.rmSync(fixture, { recursive: true });
}
