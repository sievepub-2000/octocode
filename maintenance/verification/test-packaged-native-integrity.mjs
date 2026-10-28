import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(source, 'desktop-shell/package.json'));
const { createPackageWithOptions } = require('@electron/asar');
const fixture = fs.mkdtempSync('E:/Program Files/octocode/test/native-integrity-check-');
try {
  const input = path.join(fixture, 'input');
  const app = path.join(fixture, 'resources/app');
  fs.mkdirSync(input);
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(input, 'fixture.node'), 'owned integrity bytes');
  fs.writeFileSync(path.join(input, 'empty.node'), '');
  const archive = path.join(app, 'node_modules.asar');
  await createPackageWithOptions(input, archive, { unpack: '*.node' });
  const check = () => spawnSync(process.execPath, [path.join(source, 'maintenance/verification/check-packaged-native-integrity.mjs'), fixture], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(check().status, 0);
  fs.writeFileSync(path.join(fixture, 'OctoCode.exe'), 'owned product marker');
  const missingConsole = check();
  assert.notEqual(missingConsole.status, 0);
  assert.match(missingConsole.stderr, /native PowerShell dependency is not unpacked/);
  fs.unlinkSync(path.join(fixture, 'OctoCode.exe'));
  const physical = archive + '.unpacked/fixture.node';
  fs.writeFileSync(physical, 'Owned integrity bytes');
  const hashFailure = check();
  assert.notEqual(hashFailure.status, 0);
  assert.match(hashFailure.stderr, /Stale ASAR hash/);
  fs.writeFileSync(physical, 'owned integrity bytes plus changed length');
  const sizeFailure = check();
  assert.notEqual(sizeFailure.status, 0);
  assert.match(sizeFailure.stderr, /Stale ASAR size/);
  console.log('PASS: current and empty native entries accepted; hash and size tampering rejected');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
