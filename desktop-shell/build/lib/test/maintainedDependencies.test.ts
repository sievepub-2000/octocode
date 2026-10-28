/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { test } from 'node:test';
import { once } from 'events';
import { Readable } from 'stream';
import { spawnSync } from 'child_process';
import VinylFile from 'vinyl';
import { glob, globSync, hasMagic } from 'glob';
import { rcedit } from 'rcedit';
import sinon from 'sinon';

const require = createRequire(import.meta.url);

async function collect(stream: NodeJS.ReadWriteStream): Promise<VinylFile[]> {
	const files: VinylFile[] = [];
	stream.on('data', file => files.push(file));
	await once(stream, 'end');
	return files;
}

test('modern glob preserves Windows paths, exclusions, dot files and caller-sorted order', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-glob-test-'));
	try {
		for (const filename of ['z.ts', 'a.ts', '.hidden.ts', 'ignored/x.ts']) {
			await fs.promises.mkdir(path.dirname(path.join(fixture, filename)), { recursive: true });
			await fs.promises.writeFile(path.join(fixture, filename), '');
		}
		const options = { windowsPathsNoEscape: true, nodir: true, dot: true, ignore: ['**/ignored/**'] };
		const pattern = path.join(fixture, '**', '*.ts');
		const expected = ['.hidden.ts', 'a.ts', 'z.ts'].map(file => path.join(fixture, file).replace(/\\/g, '/')).sort();
		assert.deepStrictEqual((await glob(pattern, options)).map(file => file.replace(/\\/g, '/')).sort(), expected);
		assert.deepStrictEqual(globSync(pattern, options).map(file => file.replace(/\\/g, '/')).sort(), expected);
		assert.strictEqual(hasMagic('**/*.ts'), true);
		assert.strictEqual(hasMagic('literal.ts'), false);
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});

test('JSON editor supports the maintained beautifier and preserves indentation and content', async () => {
	const editor = require('gulp-json-editor');
	const stream = editor((json: { value: number }) => ({ ...json, value: 2 }), { indent_with_tabs: true });
	const result = collect(stream);
	stream.end(new VinylFile({ path: 'package.json', contents: Buffer.from('{\n\t"value": 1,\n\t"nested": {"text": "中文"}\n}\n') }));
	const [file] = await result;
	assert.deepStrictEqual(JSON.parse(file.contents!.toString()), { value: 2, nested: { text: '中文' } });
	assert.match(file.contents!.toString(), /\n\t"value": 2/);
});

test('maintained sourcemaps maps CSS positions and round trips inline maps', async () => {
	const maps = require('gulp-sourcemaps');
	const { SourceMapConsumer } = require('source-map');
	const css = '@media screen {\n  .a {\n    color: red;\n  }\n}\n';
	const stream = maps.init({ identityMap: true });
	const result = collect(stream);
	stream.end(new VinylFile({ base: process.cwd(), path: path.join(process.cwd(), 'style.css'), contents: Buffer.from(css) }));
	const [file] = await result;
	const map = (file as VinylFile & { sourceMap: object }).sourceMap;
	const consumer = new SourceMapConsumer(map);
	assert.deepStrictEqual(consumer.originalPositionFor({ line: 3, column: 4 }), { source: 'style.css', line: 3, column: 4, name: null });
	const written = maps.write();
	const writtenResult = collect(written);
	written.end(file);
	const [withMap] = await writtenResult;
	const reloaded = maps.init({ loadMaps: true });
	const reloadedResult = collect(reloaded);
	reloaded.end(new VinylFile({ base: file.base, path: file.path, contents: withMap.contents }));
	const [roundTrip] = await reloadedResult;
	assert.deepStrictEqual((roundTrip as VinylFile & { sourceMap: { sourcesContent: string[] } }).sourceMap.sourcesContent, [css]);
});

test('vinyl-fs 4 interoperates with legacy gulp streams without changing binary bytes', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-vinyl-test-'));
	try {
		const vfs = require('vinyl-fs');
		const es = require('event-stream');
		const symdest = require('gulp-symdest');
		const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x00, 0x80, 0xc0, 0x55]);
		const filename = path.join(fixture, 'source', 'icon.bin');
		await fs.promises.mkdir(path.dirname(filename));
		await fs.promises.writeFile(filename, bytes);
		await collect(vfs.src(filename, { encoding: false }).pipe(es.mapSync((file: VinylFile) => file)).pipe(vfs.dest(path.join(fixture, 'result'))));
		assert.deepStrictEqual(await fs.promises.readFile(path.join(fixture, 'result', 'icon.bin')), bytes);
		await collect(Readable.from([new VinylFile({ base: path.dirname(filename), path: filename, contents: bytes })]).pipe(symdest(path.join(fixture, 'symdest'))));
		assert.deepStrictEqual(await fs.promises.readFile(path.join(fixture, 'symdest', 'icon.bin')), bytes);
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});

test('W3C websocket native EventTarget preserves real wire events, handler replacement and removal', async () => {
	const { server: Server, w3cwebsocket: Client } = require('websocket');
	const httpServer = http.createServer();
	const server = new Server({ httpServer });
	server.on('request', (request: { accept(): { on(type: string, listener: (message: { type: string; utf8Data: string }) => void): void; sendUTF(text: string): void } }) => {
		const connection = request.accept();
		connection.on('message', message => { if (message.type === 'utf8') connection.sendUTF(message.utf8Data); });
	});
	httpServer.listen(0, '127.0.0.1');
	await once(httpServer, 'listening');
	const address = httpServer.address();
	assert(address && typeof address !== 'string');
	const client = new Client(`ws://127.0.0.1:${address.port}`);
	try {
		let removed = 0;
		const listener = () => removed++;
		client.addEventListener('message', listener);
		client.removeEventListener('message', listener);
		await new Promise<void>((resolve, reject) => { client.onopen = () => resolve(); client.onerror = reject; });
		const message = new Promise<void>((resolve, reject) => {
			client.onmessage = () => reject(new Error('replaced handler ran'));
			client.onmessage = (event: MessageEvent) => {
				try { assert.strictEqual(event.target, client); assert.strictEqual(event.data, '中文 😀'); resolve(); } catch (error) { reject(error); }
			};
		});
		client.send('中文 😀');
		await message;
		assert.strictEqual(removed, 0);
		const closed = new Promise<void>(resolve => { client.onclose = () => resolve(); });
		client.close(1000, 'complete');
		await closed;
	} finally {
		client.close();
		server.shutDown();
		await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
	}
});

test('maintained rcedit edits an isolated Windows executable and rejects invalid input', { skip: process.platform !== 'win32' }, async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-rcedit-test-'));
	try {
		const invalid = path.join(fixture, 'invalid.exe');
		await fs.promises.writeFile(invalid, 'not a PE');
		await assert.rejects(rcedit(invalid, {}), /requires a Windows PE/);
		assert.strictEqual(await fs.promises.readFile(invalid, 'utf8'), 'not a PE');
		const input = path.resolve(path.dirname(require.resolve('rcedit')), '../bin/rcedit-x64.exe');
		const target = path.join(fixture, 'with spaces & unicode 中文.exe');
		await fs.promises.copyFile(input, target);
		await rcedit(target, { 'version-string': { FileDescription: 'OctoCode maintained resource editor fixture' }, 'file-version': '2.0.0.0' });
		assert((await fs.promises.readFile(target)).includes(Buffer.from('OctoCode maintained resource editor fixture', 'utf16le')));
		const inspector = path.join(fixture, 'inspect.ps1');
		await fs.promises.writeFile(inspector, 'param([string]$Executable)\n[System.Diagnostics.FileVersionInfo]::GetVersionInfo($Executable) | Select-Object FileDescription,FileVersion | ConvertTo-Json -Compress\n');
		const inspected = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', inspector, target], { encoding: 'utf8' });
		assert.strictEqual(inspected.status, 0, inspected.stderr);
		assert.deepStrictEqual(JSON.parse(inspected.stdout), { FileDescription: 'OctoCode maintained resource editor fixture', FileVersion: '2.0.0.0' });
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});

test('localization CLI exports strings with the maintained glob API', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-l10n-test-'));
	try {
		await fs.promises.writeFile(path.join(fixture, 'input.ts'), 'import * as l10n from "@vscode/l10n"; l10n.t("fixture message");');
		const cli = path.join(path.dirname(require.resolve('@vscode/l10n-dev')), 'cli.js');
		const result = spawnSync(process.execPath, [...process.execArgv, cli, 'export', '-o', path.join(fixture, 'out'), path.join(fixture, '*.ts')], { encoding: 'utf8' });
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		const output = JSON.parse(await fs.promises.readFile(path.join(fixture, 'out', 'bundle.l10n.json'), 'utf8'));
		assert(Object.keys(output).includes('fixture message'));
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});

test('tsec classifies literal and wildcard exemptions with the maintained glob API', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-tsec-test-'));
	try {
		const filename = path.join(fixture, 'exemptions.json');
		await fs.promises.writeFile(filename, JSON.stringify({ fixture: ['literal.ts', '**/*.test.ts'] }));
		const parse = require(path.resolve(path.dirname(require.resolve('tsec')), '../../common/exemption_config.js')).parseExemptionConfig;
		const exemptions = parse(filename);
		assert(!Array.isArray(exemptions), JSON.stringify(exemptions));
		const rule = exemptions.get('fixture');
		assert.deepStrictEqual(rule.path, [path.join(fixture, 'literal.ts').replace(/\\/g, '/')]);
		assert(new RegExp(rule.regexp[0]).test(path.join(fixture, 'nested/file.test.ts').replace(/\\/g, '/')));
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});

test('maintained Sinon timers, promise scheduling and sinon-test restore their sandboxes', async () => {
	const nativeTimeout = globalThis.setTimeout;
	const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	try {
		const callback = sinon.spy();
		setTimeout(() => Promise.resolve().then(callback), 20);
		await clock.tickAsync(20);
		assert.strictEqual(callback.callCount, 1);
	} finally {
		clock.restore();
	}
	assert.strictEqual(globalThis.setTimeout, nativeTimeout);
	const sinonTest = require('sinon-test')(sinon);
	const target = { method: () => 1 };
	sinonTest(function (this: { stub: typeof sinon.stub }) {
		this.stub(target, 'method').returns(2);
		assert.strictEqual(target.method(), 2);
	}).call({});
	assert.strictEqual(target.method(), 1);
});

test('Electron packager signature fixtures clean temporary files on success and failure', async () => {
	const win32 = require(path.join(path.dirname(require.resolve('@vscode/gulp-electron')), 'win32.js'));
	for (const fail of [false, true]) {
		let temporary = '';
		const original = Buffer.from('fixture bytes');
		const result = await new Promise<{ error: Error | null; file: VinylFile }>(resolve => {
			win32._removeSignature(new VinylFile({ path: 'fixture.exe', contents: original }), (error: Error | null, file: VinylFile) => resolve({ error, file }), {
				getSignTool: () => 'fixture-signtool',
				spawnSync: (_command: string, args: string[]) => {
					temporary = args.at(-1)!;
					assert.deepStrictEqual(fs.readFileSync(temporary), original);
					return fail ? { status: 2, stderr: 'fixture inspection failed' } : { status: 1, stdout: 'No signature found' };
				}
			});
		});
		assert(temporary);
		assert.strictEqual(fs.existsSync(temporary), false);
		if (fail) assert.match(result.error!.message, /Failed to inspect/);
		else { assert.ifError(result.error); assert.deepStrictEqual(result.file.contents, original); }
	}
});

test('coverage plugin instruments source with the maintained exclusion engine', async () => {
	const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
		import assert from 'node:assert/strict';
		import path from 'node:path';
		import istanbul from 'vite-plugin-istanbul';
		const plugin = istanbul({ cwd: process.cwd(), include: ['**/fixture-source.js'], forceBuildInstrument: true });
		await plugin.config({ build: { sourcemap: true } }, { command: 'build', mode: 'production' });
		const result = plugin.transform.call({ getCombinedSourcemap: () => ({ version: 3, sources: [], names: [], mappings: '' }) }, 'export const value = 1;', path.join(process.cwd(), 'fixture-source.js'));
		assert.match(result.code, /__coverage__/);
		assert(result.map);
	`], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
	assert.strictEqual(result.status, 0, result.stderr + result.stdout);
});

test('Component Explorer serves instrumented source through its actual Vite integration', async () => {
	const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
		import assert from 'node:assert/strict';
		import fs from 'node:fs/promises';
		import path from 'node:path';
		import { pathToFileURL, fileURLToPath } from 'node:url';
		const cli = path.dirname(fileURLToPath(import.meta.resolve('@vscode/component-explorer-cli')));
		const { createViteServer } = await import(pathToFileURL(path.join(cli, 'server/viteServer.js')).href);
		const fixture = await fs.mkdtemp(path.join(process.cwd(), '.octocode-explorer-probe-'));
		let server;
		try {
			const configFile = path.join(fixture, 'vite.config.mjs');
			await fs.writeFile(configFile, 'export default { build: { sourcemap: true }, optimizeDeps: { noDiscovery: true, include: [] } };');
			await fs.writeFile(path.join(fixture, 'fixture-source.js'), 'export const value = 1;');
			const warnings = [];
			const logger = { debug() {}, trace() {}, log() {}, info(message) { warnings.push(message); } };
			server = await createViteServer({ cwd: { value: fixture }, configFile: { value: configFile } }, {
				logger, istanbulCoverage: { include: ['**/fixture-source.js'], exclude: [] }
			});
			const response = await fetch(server.url + '/fixture-source.js');
			assert.equal(response.status, 200);
			assert.match(await response.text(), /__coverage__/);
			assert.deepEqual(warnings, []);
		} finally {
			if (server) await server.dispose();
			await fs.rm(fixture, { recursive: true, force: true });
		}
	`], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
	assert.strictEqual(result.status, 0, result.stderr + result.stdout);
	assert.strictEqual(result.stderr, '');
});

test('maintained Mocha TDD runner and c8 produce real coverage reports', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-coverage-test-'));
	try {
		await fs.promises.writeFile(path.join(fixture, 'covered.cjs'), 'module.exports = value => value ? 2 : 1;\n');
		await fs.promises.writeFile(path.join(fixture, 'fixture.test.cjs'), 'const assert = require("node:assert/strict"); const calculate = require("./covered.cjs"); suite("maintained runner", () => test("executes both branches", () => { assert.equal(calculate(true), 2); assert.equal(calculate(false), 1); }));\n');
		const mocha = path.resolve(path.dirname(require.resolve('mocha/package.json')), 'bin/mocha.js');
		const c8 = path.resolve(path.dirname(require.resolve('c8')), 'bin/c8.js');
		const result = spawnSync(process.execPath, [c8, '--reporter=json', '--reports-dir=coverage', process.execPath, mocha, '--ui=tdd', 'fixture.test.cjs'], { cwd: fixture, encoding: 'utf8', timeout: 15000 });
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /1 passing/);
		const coverage = JSON.parse(await fs.promises.readFile(path.join(fixture, 'coverage', 'coverage-final.json'), 'utf8'));
		assert(coverage[path.join(fixture, 'covered.cjs')]);
	} finally {
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});
