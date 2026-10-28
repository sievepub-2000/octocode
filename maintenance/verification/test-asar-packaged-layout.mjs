import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shell = path.join(source, 'desktop-shell');
const product = path.join(source, 'VSCode-win32-x64');
const fixture = path.join('E:/Program Files/octocode/test', `asar-layout-${randomUUID()}`);
assert.equal(fs.existsSync(fixture), false);
const app = path.join(fixture, 'resources/app');
const input = path.join(fixture, 'build-input/node_modules');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const name of ['OctoCode.exe', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'resources/app/package.json', 'resources/app/product.json', 'resources/app/out/bootstrap-fork.js']) {
    const target = path.join(fixture, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(product, name), target);
    assert.equal(sha(target), sha(path.join(product, name)));
}
fs.mkdirSync(input, { recursive: true });
fs.cpSync(path.join(shell, 'node_modules/undici'), path.join(input, 'undici'), { recursive: true });
const probe = path.join(input, '@octo-fixture/probe');
const native = path.join(input, '@octo-fixture/native');
fs.mkdirSync(probe, { recursive: true });
fs.mkdirSync(native, { recursive: true });
fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: '@octo-fixture/probe', type: 'module', exports: { import: './index.mjs', require: './index.cjs' } }));
fs.writeFileSync(path.join(probe, 'index.mjs'), 'export const condition = "import"; export const location = import.meta.url;');
fs.writeFileSync(path.join(probe, 'index.cjs'), 'exports.condition = "require"; exports.location = __filename;');
fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: '@octo-fixture/native', main: 'binding.node' }));
fs.copyFileSync(path.join(shell, 'work/verification/spki-test.node'), path.join(native, 'binding.node'));
const { createAsar } = await import(pathToFileURL(path.join(shell, 'build/lib/asar.ts')).href);
const { default: Vinyl } = await import(pathToFileURL(path.join(shell, 'node_modules/vinyl/index.js')).href);
const archive = createAsar(input, ['**/*.node'], [], [], 'node_modules.asar');
const completed = new Promise((resolve, reject) => {
    archive.on('data', file => {
        const relative = file.path.includes('node_modules.asar.unpacked') ? file.path.slice(file.path.indexOf('node_modules.asar.unpacked')) : 'node_modules.asar';
        const target = path.join(app, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.contents);
    });
    archive.on('error', reject);
    archive.on('end', resolve);
});
for (const file of fs.readdirSync(input, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const absolute = path.join(file.parentPath, file.name);
    // Exactly the production mismatch: Vinyl base is the app/build-input root,
    // while createAsar's root is the nested node_modules directory.
    archive.write(new Vinyl({ base: path.dirname(input), path: absolute, stat: fs.statSync(absolute), contents: fs.readFileSync(absolute) }));
}
archive.end();
await completed;
fs.writeFileSync(path.join(app, 'out/layout-entry.js'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cjs = require('@octo-fixture/probe');
const esm = await import('@octo-fixture/probe');
assert.equal(cjs.condition, 'require');
assert.equal(esm.condition, 'import');
assert(cjs.location.includes('node_modules.asar'));
assert(esm.location.includes('node_modules.asar'));
assert.equal(globalThis.fetch, require('undici').fetch);
assert(require.resolve('undici').includes('node_modules.asar'));
const nativePath = require.resolve('@octo-fixture/native');
assert(nativePath.includes('node_modules.asar'));
const bridge = require('@octo-fixture/native');
bridge.clear();
const identity = { execPath: process.execPath, versions: process.versions, cjs: cjs.location, esm: esm.location, native: nativePath,
undici: require.resolve('undici'), undiciVersion: require('undici/package.json').version };
fs.writeFileSync(new URL('../layout-runtime.json', import.meta.url), JSON.stringify(identity, null, 2));
console.log('PASS: actual branded Electron, unchanged packaged bootstrap, real production ASAR builder, conditional CJS/ESM and unpacked native addon');
`);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_ESM_ENTRYPOINT: 'layout-entry', VSCODE_HANDLES_UNCAUGHT_ERRORS: '1' };
for (const key of ['VSCODE_DEV', 'NODE_PATH', 'NODE_OPTIONS', 'VSCODE_PARENT_PID']) delete env[key];
const child = spawnSync(path.join(fixture, 'OctoCode.exe'), [path.join(app, 'out/bootstrap-fork.js')], { cwd: fixture, env, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
fs.writeFileSync(path.join(fixture, 'layout-tests.log'), output);
const report = { fixture, status: child.status, error: child.error?.message, exeSha256: sha(path.join(fixture, 'OctoCode.exe')),
    packagedBootstrapSha256: sha(path.join(app, 'out/bootstrap-fork.js')), archiveSha256: sha(path.join(app, 'node_modules.asar')),
    boundary: 'This validates the corrected production archive builder using a deliberately small new package. It does not certify the old product ASAR; that product still requires a rebuild and all 13 attack tests.' };
fs.writeFileSync(path.join(source, '../reports/desktop-asar-layout-runtime-oct25.json'), JSON.stringify(report, null, 2));
process.stdout.write(output);
console.log(JSON.stringify(report));
assert.equal(child.status, 0);
assert.match(output, /PASS: actual branded Electron/);
