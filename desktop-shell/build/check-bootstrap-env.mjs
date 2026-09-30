import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync('src/bootstrap-node.ts', 'utf8');
const start = source.indexOf('\tfor (const [key, relative]');
const end = source.indexOf('\n\t// npm resolves', start);
assert(start > 0 && end > start);
const code = source.slice(start, end);
const environments = path.resolve('isolated-environments');
const rustup = path.join(environments, 'rust/rustup');
const run = (files, env) => {
  vm.runInNewContext(code, {path, fs: {existsSync: p => files.includes(p)}, environments, process: {env}});
  return env;
};
assert.equal(run([], {RUSTUP_HOME: 'user-toolchain'}).RUSTUP_HOME, 'user-toolchain');
assert.equal(run([rustup], {RUSTUP_HOME: rustup}).RUSTUP_HOME, undefined);
const files = ['rust/cargo/bin/rustup.exe', 'rust/rustup/settings.toml'].map(p => path.join(environments, p));
assert.equal(run(files, {}).RUSTUP_HOME, rustup);
assert.equal(run(files, {}).CARGO_HOME, path.join(environments, 'rust/cargo'));
assert.equal(run([], {JAVA_HOME: path.join(environments, 'jdk')}).JAVA_HOME, undefined);
assert.equal(run([path.join(environments, 'jdk')], {}).JAVA_HOME, path.join(environments, 'jdk'));
console.log('Optional SDK environment checks passed');
