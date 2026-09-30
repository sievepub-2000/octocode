/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dependency-free regression tests: node --test test/unit/node/lifecycleMainService.daemon.test.mjs
// Execute the actual service with mocked imports; never contact or modify a live daemon.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { win32 as path } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const sourceURL = new URL('../../../src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts', import.meta.url);
const source = readFileSync(sourceURL, 'utf8').replace(/^import .*;\r?$/gm, '')
	.replace(/@(ILogService|IStateService|IEnvironmentMainService|IProductService) /g, '')
	.replace(/^export /gm, '');
const script = stripTypeScriptTypes(source, { mode: 'transform' }) + '\nLifecycleMainService;';
const root = 'D:\\Program Files\\OctoCode';
const store = path.join(root, 'data', 'user-data', 'User', 'globalStorage', 'octocode.octocode', 'harness-runtime');
const health = (extra = {}) => ({ ok: true, pid: 42, store, problems: [], ...extra });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

function fixture({ token = true, fetch = async () => { throw refused(); } } = {}) {
	const errors = [], infos = [], calls = [];
	const context = vm.createContext({
		Disposable: class {}, createDecorator: () => () => {},
		isWindows: true, isMacintosh: false, join: path.join, normalize: path.normalize,
		electron: { app: { getAppPath: () => path.join(root, 'resources', 'app') } },
		process: { pid: 123, cwd: () => root }, AbortSignal,
		existsSync: () => token, readFileSync: () => { if (!token) throw new Error('ENOENT'); return 'test-token'; },
		unlinkSync: () => { calls.push('unlink'); }, timeout: async () => {},
		fetch: async (...args) => { calls.push(args); return fetch(...args); }
	});
	const Service = vm.runInContext(script, context);
	const service = Object.create(Service.prototype);
	Object.assign(service, {
		productService: { nameShort: 'OctoCode' }, daemonStopping: false, daemonPreserveForRestart: false,
		logService: { error: value => errors.push(String(value)), info: value => infos.push(value) },
		startDaemon: () => calls.push('start')
	});
	return { service, errors, infos, calls, context };
}

for (const token of [false, true]) {
	test(`cold start with ${token ? 'stale' : 'no'} token starts without false errors`, async () => {
		const f = fixture({ token });
		await f.service.ensureDaemon();
		assert.equal(f.calls.filter(c => c === 'start').length, 1);
		assert.deepEqual(f.errors, []);
	});
}

test('reattaches a degraded live daemon with authentication and preserves its token', async () => {
	const f = fixture({ fetch: async url => response(url.endsWith('/health') ? health({ ok: false, problems: ['stale heartbeat'] }) : {}) });
	await f.service.ensureDaemon();
	assert.equal(f.calls[1][1].headers.authorization, 'Bearer test-token');
	assert.match(f.calls[1][0], /attach\?pid=123$/);
	assert.ok(f.service.daemonTokenPath.endsWith('api-token'));
	assert.ok(f.errors.some(e => e.includes('stale heartbeat')));
	assert.ok(!f.calls.includes('start'));
});

for (const [name, fetch, token] of [
	['authentication rejection', async url => url.endsWith('/health') ? response(health()) : response({}, 401), true],
	['missing token for a live daemon', async () => response(health()), false],
	['foreign store sharing the root prefix', async () => response(health({ store: store + '-other' })), true],
	['malformed health', async () => response({ pid: 42 }), true],
	['HTTP failure', async () => response({}, 503), true],
	['ambiguous timeout', async () => { throw new Error('request timed out'); }, true]
]) {
	test(`${name} is reported without starting or taking ownership`, async () => {
		const f = fixture({ token, fetch });
		await f.service.ensureDaemon();
		assert.equal(f.errors.length, 1);
		assert.ok(!f.calls.includes('start'));
		assert.equal(f.service.daemonTokenPath, undefined);
	});
}

test('shutdown during health lookup cannot start or attach a daemon', async () => {
	let release;
	const f = fixture({ fetch: url => url.endsWith('/health') ? new Promise(resolve => { release = resolve; }) : response({}) });
	const starting = f.service.ensureDaemon();
	const stopping = f.service.stopDaemon();
	release(response(health()));
	await Promise.all([starting, stopping]);
	assert.equal(f.calls.length, 1);
});

test('concurrent ensure calls share one attachment', async () => {
	const f = fixture({ fetch: async url => response(url.endsWith('/health') ? health() : {}) });
	await Promise.all([f.service.ensureDaemon(), f.service.ensureDaemon()]);
	assert.equal(f.calls.length, 2);
});

test('no token does not make a timeout safe to start a replacement daemon', async () => {
	const f = fixture({ token: false, fetch: async () => { throw new Error('request timed out'); } });
	await f.service.ensureDaemon();
	assert.equal(f.calls.length, 1);
	assert.match(f.errors[0], /request timed out/);
	assert.equal(f.service.daemonTokenPath, undefined);
});

test('a timeout followed by refused connections still prevents replacement', async () => {
	let attempts = 0;
	const f = fixture({ fetch: async () => {
		if (attempts++ === 0) throw new Error('request timed out');
		throw refused();
	} });
	await f.service.ensureDaemon();
	assert.equal(attempts, 5);
	assert.equal(f.errors.length, 1);
	assert.ok(!f.calls.includes('start'));
	assert.equal(f.service.daemonTokenPath, undefined);
});

test('actual startDaemon sets the token path before spawn and authenticated readiness', async () => {
	const f = fixture({ fetch: async url => response(url.endsWith('/health') ? health() : {}) });
	const child = Object.assign(new EventEmitter(), { pid: 42 });
	const expectedTokenPath = path.join(root, 'data', 'user-data', 'User', 'globalStorage', 'octocode.octocode', 'daemon', 'api-token');
	let writtenPath, readPath, readiness;
	Object.assign(f.context, {
		mkdirSync: () => {}, execFileSync: () => 'S-1-5-21-123',
		randomBytes: () => ({ toString: () => 'test-token' }),
		writeFileSync: tokenPath => { writtenPath = tokenPath; },
		openSync: () => 1, closeSync: () => {},
		readFileSync: tokenPath => { readPath = tokenPath; assert.equal(tokenPath, expectedTokenPath); return 'test-token'; },
		spawn: () => {
			assert.equal(writtenPath, expectedTokenPath);
			assert.equal(f.service.daemonTokenPath, expectedTokenPath);
			return child;
		}
	});
	const checkDaemon = f.service.checkDaemon;
	f.service.checkDaemon = (...args) => readiness = checkDaemon.apply(f.service, args);
	delete f.service.startDaemon;
	f.service.startDaemon();
	await readiness;
	assert.equal(readPath, expectedTokenPath);
	assert.equal(f.calls.find(c => Array.isArray(c) && c[0].includes('/attach?'))[1].headers.authorization, 'Bearer test-token');
	assert.ok(f.infos.some(info => info.includes('daemon ready')));
	assert.deepEqual(f.errors, []);
});

test('shutdown waits for pending authentication before shutting down the attached daemon', async () => {
	let release;
	let healthCalls = 0;
	const f = fixture({ fetch: async url => {
		if (url.endsWith('/health')) {
			if (healthCalls++ === 0) return response(health());
			throw refused();
		}
		if (url.includes('/attach?')) return new Promise(resolve => { release = resolve; });
		return response({});
	} });
	const starting = f.service.ensureDaemon();
	while (!release) await Promise.resolve();
	const stopping = f.service.stopDaemon();
	release(response({}));
	await Promise.all([starting, stopping]);
	assert.ok(f.calls.some(c => Array.isArray(c) && c[0].endsWith('/shutdown')));
	assert.ok(f.calls.includes('unlink'));
	assert.deepEqual(f.errors, []);
});

test('readiness never authenticates a different child PID', async () => {
	const f = fixture({ fetch: async () => response(health({ pid: 99 })) });
	const child = { pid: 42 };
	f.service.daemon = child;
	await f.service.checkDaemon(child, root);
	assert.match(f.errors[0], /different daemon PID/);
	assert.ok(f.calls.every(c => c[0].endsWith('/health')));
});

test('readiness reports the underlying authentication failure', async () => {
	const f = fixture({ fetch: async url => url.endsWith('/health') ? response(health()) : response({}, 403) });
	const child = { pid: 42 };
	f.service.daemon = child;
	f.service.daemonTokenPath = 'test-token-path';
	await f.service.checkDaemon(child, root);
	assert.equal(f.errors.length, 1);
	assert.match(f.errors[0], /Attach failed: HTTP 403/);
});

test('restart preserves the child and token; a veto restores normal shutdown', async () => {
	const f = fixture();
	let ended = 0;
	f.service.daemon = { stdin: { end: value => { assert.equal(value, undefined); ended++; } } };
	f.service.daemonTokenPath = 'test-token-path';
	f.service.trace = () => {};
	f.service.doQuit = async () => { await f.service.stopDaemon(); return false; };
	assert.equal(await f.service.quit(true), false);
	assert.equal(ended, 1);
	assert.deepEqual(f.calls, []);
	assert.equal(f.service.daemonPreserveForRestart, false);
	f.service.daemonStopping = false;
	f.service.doQuit = async () => true;
	assert.equal(await f.service.quit(true), true);
	assert.equal(f.service.daemonPreserveForRestart, false);
});
