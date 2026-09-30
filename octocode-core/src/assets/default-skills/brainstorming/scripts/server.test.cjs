const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { decodeFrame, MAX_FRAME_PAYLOAD_BYTES } = require('./server.cjs');

function frame(text, first = 0x81) {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([first, 0x80 | payload.length, 0, 0, 0, 0]), payload]);
}

test('token bootstrap escapes script endings, token configuration validates, and launcher never uses a shell', () => {
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, 'server.cjs'), 'utf8');
  const env = { BRAINSTORM_TOKEN: 'a'.repeat(64), BRAINSTORM_PORT: '12345', BRAINSTORM_OPEN: '1',
    BRAINSTORM_OPEN_CMD: 'launcher with spaces', BRAINSTORM_URL_HOST: '$(do-not-run)', SUPERPOWERS_DISABLE_TELEMETRY: '1' };
  function load(overrides = {}) {
    const context = vm.createContext({ Buffer, URLSearchParams, console, __dirname, module: { exports: {} },
      process: { env: { ...env, ...overrides }, platform: process.platform },
      require: name => name === 'child_process' ? { execFile: (...args) => calls.push(args) } : require(name) });
    vm.runInContext(source, context);
    return context;
  }
  assert.throws(() => load({ BRAINSTORM_TOKEN: '</script>' }), /hexadecimal/);
  assert.throws(() => load({ BRAINSTORM_PORT: 'abc' }), /Invalid BRAINSTORM_PORT/);
  const context = load();
  const framed = vm.runInContext('wrapInFrame(\'<button onclick="toggleSelect(this)">Choose</button>\')', context);
  assert.match(framed, /class="status" role="status"/);
  assert.match(framed, /onclick="toggleSelect\(this\)"/);
  const dark = framed.split('@media (prefers-color-scheme: dark)')[1].split('}')[0];
  const darkError = dark.match(/--error: (#[0-9a-f]{6})/);
  assert.ok(darkError, 'Dark small-text error color must be defined');
  const luminance = hex => hex.slice(1).match(/../g).map(byte => parseInt(byte, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = dark.match(/--bg-secondary: (#[0-9a-f]{6})/)[1];
  assert.ok((luminance(darkError[1]) + 0.05) / (luminance(background) + 0.05) >= 4.5);
  const html = vm.runInContext('bootstrapPage("</script><script>bad()</script>")', context);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  vm.runInContext('maybeOpenBrowser()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], env.BRAINSTORM_OPEN_CMD);
  assert.equal(calls[0][1].length, 1);
  assert.match(calls[0][1][0], /\$\(do-not-run\)/);
});

test('decoder rejects invalid flags and oversized control frames before waiting for payload', () => {
  assert.equal(decodeFrame(Buffer.from([0x81])), null);
  assert.throws(() => decodeFrame(frame('{}', 0x01)), /fragment/i);
  assert.throws(() => decodeFrame(frame('{}', 0xc1)), /reserved/i);
  assert.throws(() => decodeFrame(Buffer.from([0x89, 0xfe, 0, 126])), /control/i);
  const huge = Buffer.alloc(10);
  huge[0] = 0x81; huge[1] = 0xff;
  huge.writeBigUInt64BE(BigInt(MAX_FRAME_PAYLOAD_BYTES + 1), 2);
  assert.throws(() => decodeFrame(huge), /size/);
});

test('real server bounds files, survives filesystem errors, handles upgrade head and rejects invalid handshakes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-test-'));
  const content = path.join(dir, 'content');
  const state = path.join(dir, 'state');
  fs.mkdirSync(content); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'server-info'), 'old', { mode: 0o644 });
  const preload = path.join(dir, 'slow-filesystem.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    const originalAsyncOpen = fs.promises.open;
    const slow = new Set();
    fs.openSync = function(file, ...args) {
      const fd = originalOpen.call(this, file, ...args);
      if (String(file).endsWith('slow.html')) slow.add(fd);
      return fd;
    };
    fs.readSync = function(fd, ...args) {
      if (slow.delete(fd)) {
        process.stdout.write('SLOW_SCREEN_READ\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      }
      return originalRead.call(this, fd, ...args);
    };
    fs.promises.open = async function(file, ...args) {
      if (String(file).endsWith('slow.html')) {
        process.stdout.write('SLOW_SCREEN_READ\\n');
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      return originalAsyncOpen.call(this, file, ...args);
    };
  `);
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.cjs')], {
    env: { ...process.env, BRAINSTORM_DIR: dir, BRAINSTORM_PORT: '0', BRAINSTORM_HOST: '127.0.0.1',
      BRAINSTORM_TOKEN: 'a'.repeat(64), BRAINSTORM_PORT_FILE: '', BRAINSTORM_TOKEN_FILE: '',
      BRAINSTORM_OPEN: '', SUPERPOWERS_DISABLE_TELEMETRY: '1', BRAINSTORM_OWNER_PID: '',
      BRAINSTORM_IDLE_TIMEOUT_MS: '60000', BRAINSTORM_LIFECYCLE_CHECK_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = ''; let err = '';
  child.stderr.on('data', data => { err += data; });
  const sockets = [];
  try {
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timed out: ' + err)), 8000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${err}`)); });
      child.stdout.on('data', data => {
        log += data;
        const line = log.split('\n').find(line => line.startsWith('{"type":"server-started"'));
        if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
    });
    assert.ok(info.port > 0);
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { Cookie: `brainstorm-key-${info.port}=${'a'.repeat(64)}` };
    let res = await fetch(base, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    await res.text();
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(state, 'server-info')).mode & 0o777, 0o600);

    fs.renameSync(content, content + '-saved');
    res = await fetch(base, { headers });
    assert.equal(res.status, 500); await res.text();
    fs.renameSync(content + '-saved', content);
    const fd = fs.openSync(path.join(content, 'huge.bin'), 'w');
    fs.ftruncateSync(fd, MAX_FRAME_PAYLOAD_BYTES + 1); fs.closeSync(fd);
    res = await fetch(base + '/files/huge.bin', { headers });
    assert.equal(res.status, 413); await res.text();
    fs.mkdirSync(path.join(state, 'events'));

    async function connect(extraHeaders, payload = Buffer.alloc(0), version = '13') {
      const socket = net.connect(info.port, '127.0.0.1'); sockets.push(socket);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(Buffer.concat([Buffer.from(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: ${version}\r\nCookie: ${headers.Cookie}\r\n${extraHeaders}\r\n`), payload]));
      return socket;
    }
    const socket = await connect(`Origin: ${base}\r\n`, frame('{"choice":"A"}'));
    let reply = ''; socket.on('data', data => { reply += data.toString(); });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.match(reply, /101 Switching/);
    assert.match(log, /"choice":"A"/); // upgrade's head was not discarded
    assert.match(err, /persist user event/i);
    const wrongOrigin = await connect('Origin: http://attacker.invalid\r\n');
    await once(wrongOrigin, 'close');
    const wrongVersion = await connect(`Origin: ${base}\r\n`, Buffer.alloc(0), '12');
    await once(wrongVersion, 'close');
    const invalidFrame = await connect(`Origin: ${base}\r\n`, frame('{}', 0xc1));
    invalidFrame.resume();
    await once(invalidFrame, 'close');
    res = await fetch(base, { headers });
    assert.equal(res.status, 200); await res.text();
    fs.writeFileSync(path.join(content, 'fast.txt'), 'fast');
    fs.writeFileSync(path.join(content, 'slow.html'), '<p>slow screen</p>');
    const reading = new Promise(resolve => {
      const observe = data => {
        if (data.toString().includes('SLOW_SCREEN_READ')) { child.stdout.off('data', observe); resolve(); }
      };
      child.stdout.on('data', observe);
    });
    const slowResponse = fetch(base, { headers });
    await reading;
    const start = Date.now();
    const fastResponse = await fetch(base + '/files/fast.txt', { headers });
    assert.equal(await fastResponse.text(), 'fast');
    const elapsed = Date.now() - start;
    console.log(`Independent asset request during 1200ms screen delay: ${elapsed}ms`);
    assert.ok(elapsed < 700, 'A delayed screen read must not block independent asset requests');
    assert.match(await (await slowResponse).text(), /slow screen/);
    assert.equal(child.exitCode, null);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
