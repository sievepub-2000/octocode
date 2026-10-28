import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const product = path.resolve(process.argv[2] || path.join(source, 'VSCode-win32-x64'));
const shell = path.join(source, 'desktop-shell');
const fixture = path.join('E:/Program Files/octocode/test', `packaged-node-security-${randomUUID()}`);
assert.match(fixture.replaceAll('\\', '/'), /^E:\/Program Files\/octocode\/test\/packaged-node-security-[a-f0-9-]{36}$/);
assert.equal(fs.existsSync(fixture), false);
const app = path.join(fixture, 'resources/app');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const copied = [];
function copy(from, relative) {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    assert.equal(digest(from), digest(target), relative);
    copied.push({ relative, sha256: digest(target), bytes: fs.statSync(target).size });
}
for (const name of ['OctoCode.exe', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']) copy(path.join(product, name), name);
for (const name of ['package.json', 'product.json', 'node_modules.asar', 'out/bootstrap-fork.js']) copy(path.join(product, 'resources/app', name), `resources/app/${name}`);
for (const name of ['agent1-cert.pem', 'agent1-key.pem', 'ca1-cert.pem']) copy(path.join(shell, 'scripts/fixtures/node-security', name), `resources/app/scripts/fixtures/node-security/${name}`);
copy(path.join(shell, 'work/verification/spki-test.node'), 'resources/app/work/verification/spki-test.node');

function replaceOnce(text, before, after) {
    assert.equal(text.split(before).length, 2, `Expected one test adapter boundary: ${before}`);
    return text.replace(before, after);
}
let nodeTests = fs.readFileSync(path.join(shell, 'scripts/electron-node-security.test.mjs'), 'utf8');
nodeTests = replaceOnce(nodeTests, "const baselineTls = tls.checkServerIdentity('127.1', { subject: { CN: '127.0.0.1' } });", 'const baselineTls = globalThis.__octoUnpatchedTls;');
nodeTests = replaceOnce(nodeTests, "if (!process.env.OCTO_TEST_UNPATCHED) await import('../out/bootstrap-node.js');", '// The unchanged packaged bootstrap-fork has already initialized this test entrypoint.');
fs.writeFileSync(path.join(app, 'scripts/electron-node-security.test.mjs'), nodeTests);
let depsTests = fs.readFileSync(path.join(shell, 'scripts/security-dependencies.test.mjs'), 'utf8');
depsTests = replaceOnce(depsTests, "'../node_modules/undici/lib/web/eventsource/eventsource-stream.js'", "'undici/lib/web/eventsource/eventsource-stream.js'");
depsTests = replaceOnce(depsTests, "await import('../src/bootstrap-node.ts');", 'assert.equal(globalThis.fetch, undici.fetch); // Installed by the unchanged packaged bootstrap.');
fs.writeFileSync(path.join(app, 'scripts/security-dependencies.test.mjs'), depsTests);
fs.writeFileSync(path.join(app, 'scripts/baseline.mjs'), `import tls from 'node:tls';
globalThis.__octoUnpatchedTls = tls.checkServerIdentity('127.1', { subject: { CN: '127.0.0.1' } });
`);
fs.writeFileSync(path.join(app, 'out/packaged-security-entry.js'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const names = ['undici', 'zod', '@vscode/sandbox-runtime/dist/sandbox/sandbox-config.js', '@vscode/proxy-agent'];
const resolved = Object.fromEntries(names.map(name => [name, require.resolve(name)]));
for (const file of Object.values(resolved)) assert(file.includes('node_modules.asar'), file);
assert.equal(globalThis.fetch, require('undici').fetch);
const identity = { execPath: process.execPath, versions: process.versions, resolved,
    undiciVersion: require('undici/package.json').version, zodVersion: require('zod/package.json').version };
assert.equal(identity.undiciVersion, '8.12.3');
assert.equal(identity.zodVersion, '4.6.6');
fs.writeFileSync(new URL('../runtime-identity.json', import.meta.url), JSON.stringify(identity, null, 2));
await import('../scripts/electron-node-security.test.mjs');
await import('../scripts/security-dependencies.test.mjs');
`);

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_ESM_ENTRYPOINT: 'packaged-security-entry', VSCODE_HANDLES_UNCAUGHT_ERRORS: '1', VSCODE_ASAR_TRACE: path.join(fixture, 'asar-trace.log') };
for (const key of ['VSCODE_DEV', 'NODE_PATH', 'NODE_OPTIONS', 'VSCODE_PARENT_PID', 'OCTO_TEST_UNPATCHED']) delete env[key];
const child = spawnSync(path.join(fixture, 'OctoCode.exe'), ['--import', pathToFileURL(path.join(app, 'scripts/baseline.mjs')).href, '--test', '--test-isolation=none', path.join(app, 'out/bootstrap-fork.js')], {
    cwd: fixture, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024
});
const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
fs.writeFileSync(path.join(fixture, 'security-tests.log'), output);
const identityPath = path.join(app, 'runtime-identity.json');
const report = { fixture, status: child.status, signal: child.signal, error: child.error?.message, copied,
    identity: fs.existsSync(identityPath) ? JSON.parse(fs.readFileSync(identityPath, 'utf8')) : null,
    boundary: 'Unchanged packaged bootstrap-fork.js, product-branded Electron and exact packaged ASAR. Only test import locations/baseline capture are adapted; no source bootstrap is loaded.' };
fs.writeFileSync(path.join(source, '../reports/packaged-node-security-oct25.json'), JSON.stringify(report, null, 2));
process.stdout.write(output);
console.log(JSON.stringify({ fixture, status: child.status, error: child.error?.message }));
assert.equal(child.status, 0, 'Packaged runtime security regression failed');
assert.match(output, /(?:tests 13|# tests 13)/);
assert.match(output, /(?:fail 0|# fail 0)/);
