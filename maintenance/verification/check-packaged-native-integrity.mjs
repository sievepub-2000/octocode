import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(source, 'desktop-shell/package.json'));
const { getRawHeader } = require('@electron/asar');
const product = path.resolve(process.argv[2] || path.join(source, 'VSCode-win32-x64'));
const archive = path.join(product, 'resources/app/node_modules.asar');
const unpacked = fs.realpathSync(archive + '.unpacked');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let files = 0, native = 0;
function check(directory, prefix = '') {
  for (const [name, entry] of Object.entries(directory.files)) {
    const relative = path.join(prefix, name);
    if (entry.files) { check(entry, relative); continue; }
    if (!entry.unpacked || entry.link) continue;
    const filename = fs.realpathSync(path.join(unpacked, relative));
    assert(filename.startsWith(unpacked + path.sep), `Unpacked path escapes its root: ${relative}`);
    const bytes = fs.readFileSync(filename);
    assert.equal(entry.size, bytes.length, `Stale ASAR size: ${relative}`);
    assert.equal(entry.integrity?.algorithm, 'SHA256', `Missing ASAR integrity: ${relative}`);
    assert.equal(entry.integrity.hash, hash(bytes), `Stale ASAR hash: ${relative}`);
    assert(Number.isSafeInteger(entry.integrity.blockSize) && entry.integrity.blockSize > 0);
    const blocks = [];
    for (let offset = 0; offset < bytes.length; offset += entry.integrity.blockSize) {
      blocks.push(hash(bytes.subarray(offset, offset + entry.integrity.blockSize)));
    }
    if (!bytes.length) blocks.push(hash(bytes));
    assert.deepEqual(entry.integrity.blocks, blocks, `Stale ASAR blocks: ${relative}`);
    files++;
    if (relative.endsWith('.node')) native++;
  }
}
const header = getRawHeader(archive).header;
if (fs.existsSync(path.join(product, 'OctoCode.exe'))) {
  for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    const relative = path.join('node-pty', 'prebuilds', 'win32-x64', 'conpty', name);
    let entry = header;
    for (const part of relative.split(path.sep)) entry = entry?.files?.[part];
    assert(entry?.unpacked, `Required native PowerShell dependency is not unpacked: ${relative}`);
  }
}
check(header);
assert(files > 0 && native > 0, 'Expected packaged native dependencies');
console.log(JSON.stringify({ unpackedFiles: files, nativeModules: native, integrity: 'PASS' }));
