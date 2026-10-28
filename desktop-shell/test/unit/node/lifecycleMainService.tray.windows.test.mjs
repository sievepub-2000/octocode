/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test test/unit/node/lifecycleMainService.tray.windows.test.mjs
// Uses a candidate Electron and an owned profile, never the production bootstrap or daemon.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const candidate = process.env.OCTOCODE_TRAY_TEST_ELECTRON || join(root, '.build', 'electron', 'OctoCode.exe');

async function until(check, description) {
	const deadline = Date.now() + 10000;
	while (!check()) {
		assert.ok(Date.now() < deadline, `Timed out: ${description}`);
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

async function stopOwnedFixture(child) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	// Only the still-running child spawned by this test, including its Chromium descendants.
	await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
	await until(() => child.exitCode !== null || child.signalCode !== null, 'owned fixture process exits');
}

export async function runTrayFixture() {
	const electron = require('electron');
	const { app, BrowserWindow, Menu, Tray } = electron;
	const owned = resolve(process.env.OCTOCODE_TRAY_TEST_OWNED);
	assert.equal(resolve(app.getAppPath()), owned);
	for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
		const folder = join(owned, name);
		mkdirSync(folder, { recursive: true });
		app.setPath(name, folder);
	}
	app.on('window-all-closed', () => {});
	const errors = [], registered = [], unloaded = [], beforeClose = [], shutdowns = [];
	let service, nativeMenu, failure, result;
	const buildMenu = Menu.buildFromTemplate;
	// Observe the native menu that the real handler creates, without replacing its items or callbacks.
	Menu.buildFromTemplate = function (...args) { nativeMenu = buildMenu.apply(this, args); return nativeMenu; };
	try {
		await app.whenReady();
		assert.equal(resolve(app.getPath('userData')), join(owned, 'userData'));
		const source = readFileSync(join(root, 'src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts'), 'utf8')
			.replace(/^import .*;\r?$/gm, '')
			.replace(/@(ILogService|IStateService|IEnvironmentMainService|IProductService) /g, '')
			.replace(/^export /gm, '');
		const ts = require('typescript');
		const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nLifecycleMainService;';
		class DisposableStore {
			items = [];
			add(item) { this.items.push(item); return item; }
			dispose() { for (const item of this.items.splice(0)) item.dispose(); }
		}
		const forbidden = () => { throw new Error('Fixture attempted daemon, network or process access'); };
		const context = vm.createContext({
			Disposable: class {}, DisposableStore, createDecorator: () => () => {},
			isWindows: true, isMacintosh: false, electron, join,
			assertReturnsDefined: value => { assert.ok(value); return value; },
			Event: { fromNodeEventEmitter: (emitter, name) => listener => {
				emitter.on(name, listener); return { dispose: () => emitter.removeListener(name, listener) };
			} },
			UnloadReason: { CLOSE: 2 }, ShutdownReason: { QUIT: 1 },
			fetch: forbidden, spawn: forbidden, execFileSync: forbidden
		});
		const Service = vm.runInContext(script, context);
		// Do not execute the constructor: daemon initialization is outside this native tray fixture.
		service = Object.create(Service.prototype);
		Object.assign(service, {
			productService: { nameShort: 'OctoCode' }, environmentMainService: {},
			windowCounter: 0, windowToCloseRequest: new Set(), trayWindows: new Set(), _quitRequested: false,
			_register: item => { registered.push(item); return item; },
			logService: { error: value => errors.push(String(value)) }, trace: () => {},
			_onWillLoadWindow: { fire: () => {} }, _onBeforeCloseWindow: { fire: window => beforeClose.push(window.id) },
			unload: async window => { unloaded.push(window.id); return false; },
			fireOnWillShutdown: reason => shutdowns.push(reason),
			startDaemon: forbidden, ensureDaemon: forbidden, relaunch: forbidden, quit: forbidden
		});
		const html = 'data:text/html,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>OctoCode isolated tray test</title>Isolated tray lifecycle fixture');
		const makeWindow = async () => {
			const win = new BrowserWindow({ width: 320, height: 180, show: false,
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
			await win.loadURL(html);
			service.registerWindow({ id: win.id, win, close: () => win.close(), onWillLoad: () => ({ dispose() {} }) });
			return win;
		};
		const remaining = await makeWindow(), lastRegistered = await makeWindow();
		assert.ok(service.tray instanceof Tray);
		assert.ok(nativeMenu instanceof Menu);
		assert.equal(service.windowCounter, 2);
		assert.equal(service.trayWindow, lastRegistered);
		lastRegistered.close();
		await until(() => lastRegistered.isDestroyed(), 'last registered native window closes');
		assert.equal(service.windowCounter, 1);
		assert.equal(service.trayWindow, undefined);
		assert.deepEqual(unloaded, [lastRegistered.id]);
		assert.deepEqual(beforeClose, [lastRegistered.id]);
		const observations = [];
		for (const action of ['click', 'menu']) {
			remaining.show();
			remaining.close();
			await until(() => !remaining.isVisible(), 'closing last window hides it');
			assert.equal(remaining.isDestroyed(), false);
			assert.equal(service.windowCounter, 1);
			assert.equal(service.trayWindows.has(remaining), true);
			// Exercise both the destroyed-target fallback and restoring a minimized native window.
			service.trayWindow = lastRegistered;
			remaining.show();
			remaining.minimize();
			await until(() => remaining.isMinimized(), 'native minimize');
			remaining.hide();
			assert.equal(remaining.isVisible(), false);
			if (action === 'click') service.tray.emit('click');
			else {
				const item = nativeMenu.items.find(item => item.label === 'Open OctoCode');
				assert.ok(item);
				item.click(item, remaining, {});
			}
			await until(() => remaining.isVisible() && !remaining.isMinimized() && remaining.isFocused(), `${action} restores visible, normal, focused native window`);
			assert.equal(BrowserWindow.getFocusedWindow(), remaining);
			assert.equal(service.trayWindow, remaining);
			observations.push({ action, visible: remaining.isVisible(), minimized: remaining.isMinimized(), focused: remaining.isFocused() });
		}
		assert.deepEqual(errors, []);
		assert.deepEqual(shutdowns, []);
		result = { pid: process.pid, electron: process.versions.electron, userData: app.getPath('userData'), nativeTray: !service.tray.isDestroyed(), nativeMenu: nativeMenu instanceof Menu, closedWindow: lastRegistered.id, remainingWindow: remaining.id, observations };
	} catch (error) { failure = error; }
	finally {
		Menu.buildFromTemplate = buildMenu;
		if (service) service._quitRequested = true;
		for (const win of BrowserWindow.getAllWindows()) win.destroy();
		for (const item of registered) item.dispose();
		assert.equal(BrowserWindow.getAllWindows().length, 0);
		if (service?.tray) assert.equal(service.tray.isDestroyed(), true);
		if (result) {
			assert.equal(service.windowCounter, 0);
			assert.equal(service.trayWindows.size, 0);
			assert.deepEqual(shutdowns, [1]);
			result.cleanup = { windows: 0, registeredWindows: 0, trayDestroyed: service.tray.isDestroyed() };
		}
	}
	if (failure) { console.error(failure); app.exit(1); }
	else { writeFileSync(join(owned, 'result.json'), JSON.stringify(result, null, 2)); app.exit(0); }
}

if (!process.versions.electron) {
	test('Windows candidate Electron: real tray restores surviving native window after the newest closes', {
		skip: process.platform !== 'win32' ? 'Windows native tray test' : false, timeout: 60000
	}, async t => {
		assert.ok(existsSync(candidate), `Build candidate Electron first: ${candidate}`);
		const owned = mkdtempSync(join(tmpdir(), 'octocode-tray-fixture-'));
		const resultPath = join(owned, 'result.json');
		let child;
		try {
			mkdirSync(join(owned, 'resources', 'win32'), { recursive: true });
			copyFileSync(join(root, 'resources', 'win32', 'code_70x70.png'), join(owned, 'resources', 'win32', 'code_70x70.png'));
			writeFileSync(join(owned, 'package.json'), JSON.stringify({ name: 'octocode-owned-tray-fixture', version: '1.0.0', main: 'fixture.cjs' }));
			writeFileSync(join(owned, 'fixture.cjs'), `import(${JSON.stringify(import.meta.url)}).then(m => m.runTrayFixture()).catch(e => { console.error(e); require('electron').app.exit(1); });`);
			const env = { ...process.env, OCTOCODE_TRAY_TEST_OWNED: owned };
			delete env.ELECTRON_RUN_AS_NODE;
			child = spawn(candidate, [owned], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '', stderr = '';
			child.stdout.on('data', data => stdout += data);
			child.stderr.on('data', data => stderr += data);
			const exitCode = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					void stopOwnedFixture(child).then(() => reject(new Error(`Native fixture timeout\n${stderr}`)), reject);
				}, 45000);
				child.once('error', error => { clearTimeout(timer); reject(error); });
				child.once('exit', code => { clearTimeout(timer); resolve(code); });
			});
			assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
			assert.equal(stderr, '', 'Native Electron stderr must be investigated');
			const result = JSON.parse(readFileSync(resultPath, 'utf8'));
			assert.equal(result.pid, child.pid);
			assert.deepEqual(result.observations, ['click', 'menu'].map(action => ({ action, visible: true, minimized: false, focused: true })));
			assert.deepEqual(result.cleanup, { windows: 0, registeredWindows: 0, trayDestroyed: true });
			t.diagnostic(JSON.stringify(result));
			if (stderr) t.diagnostic(stderr);
			if (process.env.OCTOCODE_TRAY_TEST_RESULT) {
				mkdirSync(dirname(resolve(process.env.OCTOCODE_TRAY_TEST_RESULT)), { recursive: true });
				copyFileSync(resultPath, resolve(process.env.OCTOCODE_TRAY_TEST_RESULT));
			}
		} finally {
			await stopOwnedFixture(child);
			assert.equal(dirname(owned), tmpdir());
			assert.ok(owned.startsWith(join(tmpdir(), 'octocode-tray-fixture-')));
			rmSync(owned, { recursive: true, force: true });
		}
	});
}
