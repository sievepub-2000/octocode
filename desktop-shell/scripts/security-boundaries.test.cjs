/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { Readable } = require('node:stream');
const Module = require('node:module');
const root = require('node:path').resolve(__dirname, '..');
const ts = require(root + '/node_modules/typescript');
const baseRequire = Module.createRequire(root + '/package.json');
function execute(source, file, require, extra = {}) { const exports = {}; const context = { exports, module: { exports }, require, Buffer, URL, console, __filename: file, __dirname: file.slice(0, file.lastIndexOf('/')), process: { platform: 'linux', argv: ['node', file, '--port', '15476', '--host', '127.0.0.1', '--no-open'], env: {}, on() { } }, ...extra }; vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context, { filename: file }); return context; }
async function withHandler(handler, test) { const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const request = (path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, headers: { Host: '127.0.0.1:15476', ...headers }, method }, res => { let data = ''; res.on('data', b => data += b); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data })); }); req.on('error', reject); req.end(body); }); try {
	await test(request);
}
finally {
	await new Promise(resolve => server.close(resolve));
} }
(async () => {
	const calls = [];
	const ps = execute(fs.readFileSync(root + '/src/vs/base/node/ps.ts', 'utf8'), root + '/src/vs/base/node/ps.ts', name => { if (name === 'child_process')
		return { execFile(file, args, options, callback) { calls.push({ file, args }); callback(null, file === 'which' ? 'C:/path with spaces/ps$(marker).exe\n' : file.includes('cpuUsage.sh') ? '0.2\n' : '101 1 0.1 1.0 fixture\n', ''); } }; if (name === 'os')
		return { totalmem: () => 1024 * 1024 }; if (name.endsWith('/network.js'))
		return { FileAccess: { asFileUri: f => ({ fsPath: 'C:/path with spaces/$(marker)/' + f }) } }; if (name.endsWith('/platform.js'))
		return { isWindows: false }; return baseRequire(name); });
	assert.equal((await ps.module.exports.listProcesses(101)).pid, 101);
	assert.equal(calls.length, 3);
	assert.deepEqual(Array.from(calls[1].args), ['-ax', '-o', 'pid=,ppid=,pcpu=,pmem=,command=']);
	assert.ok(calls[2].file.includes('$(marker)'));
	assert.deepEqual(Array.from(calls[2].args), ['101']);
	console.log('PASS process paths and numeric PID arguments remain literal argv');
	const parserText = fs.readFileSync(root + '/extensions/terminal-suggest/src/fig/autocomplete-parser/parseArguments.ts', 'utf8');
	const fn = parserText.slice(parserText.indexOf('const executeLoginShell ='), parserText.indexOf('export const parseArguments ='));
	let loginCall;
	const login = execute("import {execFile} from 'child_process';\n" + fn + '\nexports.executeLoginShell=executeLoginShell;', root + '/login-check.ts', () => ({ execFile(file, args, cb) { loginCall = { file, args }; cb(null, 'fixture', ''); } }));
	assert.equal(await login.module.exports.executeLoginShell({ executable: 'C:/shell path/$(marker).exe', command: 'printf "$HOME"' }), 'fixture');
	assert.equal(loginCall.file, 'C:/shell path/$(marker).exe');
	assert.deepEqual(Array.from(loginCall.args), ['-c', 'printf "$HOME"']);
	console.log('PASS login-shell execution has no outer shell interpolation');
	const xterm = fs.readFileSync(root + '/scripts/xterm-update.js', 'utf8');
	let metadata = '["1.0.0","6.1.0-beta.291"]';
	const versions = execute(xterm.slice(xterm.indexOf('function getLatestModuleVersion'), xterm.indexOf('async function update')) + '\nexports.getLatestModuleVersion=getLatestModuleVersion;', root + '/xterm-check.js', baseRequire, { vscodeDir: 'fixture', semver: baseRequire('semver'), cp: { exec(command, opts, cb) { cb(null, metadata, ''); } } });
	assert.equal(await versions.module.exports.getLatestModuleVersion('@xterm/xterm'), '6.1.0-beta.291');
	metadata = '["1.0.0; echo injected"]';
	await assert.rejects(versions.module.exports.getLatestModuleVersion('@xterm/xterm'));
	metadata = '{invalid';
	await assert.rejects(versions.module.exports.getLatestModuleVersion('@xterm/xterm'));
	console.log('PASS updater accepts semver beta, rejects shell metacharacters and malformed JSON');
	let policyHandler, writes = 0;
	const safeFs = { ...fs, existsSync: () => false, readFileSync: () => '{"nameLong":"Fixture"}', writeFileSync() { writes++; throw new Error('Fixture forbids filesystem writes'); } };
	execute(fs.readFileSync(root + '/scripts/mock-policy-server/server.ts', 'utf8'), root + '/scripts/mock-policy-server/server.ts', name => { if (name === 'node:http')
		return { ...http, createServer: handler => (policyHandler = handler, { listen() { } }) }; if (name === 'node:fs')
		return safeFs; if (name === './endpoints.ts')
		return [{ id: 'policy', path: '/mock-policy', label: 'Fixture', presets: [{ body: { fixture: true } }] }]; return baseRequire(name); }, { console: { log() { }, error() { } } });
	await withHandler(policyHandler, async (request) => { assert.equal((await request('/api/wire', { Origin: 'https://evil.invalid' }, 'POST')).status, 403); assert.equal((await request('/api/state', { Host: 'evil.invalid:15476' })).status, 403); assert.equal((await request('/mock-policy', { Origin: 'https://evil.invalid' })).status, 403); const local = await request('/mock-policy', { Origin: 'http://localhost:8080' }); assert.equal(local.status, 200); assert.equal(local.headers['access-control-allow-origin'], 'http://localhost:8080'); assert.equal((await request('/api/state', { Origin: 'http://127.0.0.1:15476' }, 'POST', JSON.stringify({ endpoint: 'policy', body: { test: true } }))).status, 200); assert.equal((await request('http://[bad')).status, 400); assert.equal(writes, 0); });
	console.log('PASS mock policy host/origin/CSRF rejection and loopback web-build compatibility');
	let sessionsHandler;
	const sessions = execute(fs.readFileSync(root + '/scripts/code-sessions-web.js', 'utf8').replace('main();', 'globalThis.started=main();'), root + '/scripts/code-sessions-web.js', name => { if (name === 'http')
		return { ...http, createServer: handler => (sessionsHandler = handler, { listen() { }, close() { } }) }; if (name === 'tinyglobby')
		return { glob: async () => [] }; if (name === 'fs')
		return { ...fs, existsSync: () => true, statSync: () => ({ isFile: () => true }), createReadStream: () => Readable.from('export const fixture = true;') }; return baseRequire(name); });
	await sessions.started;
	await withHandler(sessionsHandler, async (request) => { assert.equal((await request('/fixture.js', { Origin: 'https://evil.invalid' })).status, 403); const local = await request('/fixture.js', { Origin: 'http://127.0.0.1:15476' }); assert.equal(local.status, 200); assert.equal(local.headers['access-control-allow-origin'], undefined); assert.equal((await request('http://[bad')).status, 400); });
	console.log('PASS sessions web blocks foreign origin and invalid URL, serves same-origin assets');
})().catch(e => { console.error(e); process.exitCode = 1; });
