/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { configureNodeGypEnvironment, patchLibuvWindowsHeaderSource, patchPythonFinderSource } from './nativeToolchainPatch.ts';

const npmRoot = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
const finderFile = path.join(npmRoot, 'node_modules', 'node-gyp', 'lib', 'find-python.js');
const upstreamFinder = fs.readFileSync(finderFile, 'utf8');

interface Finder {
	win: boolean;
	run(command: string, args: string[], shell: boolean): Promise<string>;
	checkCommand(command: string): Promise<string>;
	checkExecPath(command: string): Promise<string>;
}

function makeFinder(): Finder {
	const fixtureModule: { exports: unknown } = { exports: {} };
	const evaluate = new Function('require', 'module', 'exports', patchPythonFinderSource(upstreamFinder));
	evaluate(createRequire(finderFile), fixtureModule, fixtureModule.exports);
	assert(typeof fixtureModule.exports === 'function');
	return Reflect.construct(fixtureModule.exports, []) as Finder;
}

test('Python executable paths retain argv without a Windows shell', async () => {
	const finder = makeFinder();
	finder.win = true;
	const command = 'C:\\fixture space & 中文\\python.exe';
	let invocation: { command: string; args: string[]; shell: boolean } | undefined;
	finder.run = async (command, args, shell) => {
		invocation = { command, args, shell };
		return command;
	};
	finder.checkExecPath = async command => command;
	assert.equal(await finder.checkCommand(command), command);
	assert(invocation);
	assert.equal(invocation.command, command);
	assert.equal(invocation.shell, false);
	assert.equal(invocation.args[0], '-c');
	assert(!invocation.args[1].startsWith('"'));
});

test('Windows Python batch launchers retain their existing compatibility path', async () => {
	const finder = makeFinder();
	finder.win = true;
	let usedShell = false;
	finder.run = async (_command, _args, shell) => {
		usedShell = shell;
		return 'C:\\python.exe';
	};
	finder.checkExecPath = async command => command;
	assert.equal(await finder.checkCommand('C:\\fixture\\python.cmd'), 'C:\\python.exe');
	assert.equal(usedShell, true);
});

test('patched finder discovers the real source Python executable without a deprecation', async () => {
	const python = path.resolve(path.dirname(process.execPath), '..', 'python', 'python.exe');
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on('warning', onWarning);
	try {
		assert.equal(await makeFinder().checkCommand(python), python);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(warnings, []);
	} finally {
		process.off('warning', onWarning);
	}
});
test('Python maintenance is idempotent and rejects an unknown source shape', () => {
	const patched = patchPythonFinderSource(upstreamFinder);
	assert.equal(patchPythonFinderSource(patched), patched);
	assert.throws(() => patchPythonFinderSource('unexpected finder'), /Python finder/);
});

test('libuv NTSTATUS keeps SDK success annotations on MSVC and the non-MSVC definition', () => {
	const original = '#ifndef _NTDEF_\n  typedef LONG NTSTATUS;\n  typedef NTSTATUS *PNTSTATUS;\n#endif\n';
	const patched = patchLibuvWindowsHeaderSource(original);
	assert.match(patched, /#if defined\(_MSC_VER\)\n  typedef _Return_type_success_\(return >= 0\) LONG NTSTATUS;/);
	assert.match(patched, /#else\n  typedef LONG NTSTATUS;\n#endif/);
	assert.match(patched, /typedef NTSTATUS \*PNTSTATUS;/);
	assert.equal(patchLibuvWindowsHeaderSource(patched), patched);
	assert.throws(() => patchLibuvWindowsHeaderSource('unexpected header'), /libuv NTSTATUS/);
});

test('maintenance preserves CRLF source line endings', () => {
	const original = '#ifndef _NTDEF_\r\n  typedef LONG NTSTATUS;\r\n  typedef NTSTATUS *PNTSTATUS;\r\n#endif\r\n';
	const patched = patchLibuvWindowsHeaderSource(original);
	assert(!/(?<!\r)\n/.test(patched));
});

test('root, remote and build use only their actual target configuration', () => {
	const root = path.resolve(import.meta.dirname, '..', '..');
	for (const [directory, target] of [['', '43.8.3'], ['remote', '24.22.1'], ['build', '26.12.1']]) {
		const config = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8')).config;
		const env: NodeJS.ProcessEnv = {
			npm_package_config_node_gyp_target: 'wrong-target',
			npm_package_config_node_gyp_dist_url: 'https://wrong.invalid',
			npm_package_config_node_gyp_stale: 'must disappear',
			NODE_GYP_FORCE_PYTHON: 'authoritative-python.exe'
		};
		configureNodeGypEnvironment(env, config);
		assert.equal(env.npm_package_config_node_gyp_target, target);
		assert.equal(env.npm_package_config_node_gyp_dist_url, config.node_gyp_dist_url);
		assert.equal(env.npm_package_config_node_gyp_stale, undefined);
		assert.equal(env.NODE_GYP_FORCE_PYTHON, 'authoritative-python.exe');
		configureNodeGypEnvironment(env, {});
		assert(!Object.keys(env).some(key => key.startsWith('npm_package_config_node_gyp_')));
		assert.equal(env.NODE_GYP_FORCE_PYTHON, 'authoritative-python.exe');
	}
});

test('npm permits the reviewed native file sources by their exact source identity', () => {
	const require = createRequire(import.meta.url);
	const policy = require(path.join(npmRoot, 'node_modules', '@npmcli', 'arborist', 'lib', 'script-allowed.js')) as {
		isScriptAllowed(node: { resolved: string; root: { path: string }; inBundle: boolean }, policy: Record<string, boolean>): boolean | null;
	};
	const root = path.resolve(import.meta.dirname, '..', '..');
	for (const directory of ['', 'remote']) {
		const project = path.join(root, directory);
		const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
		const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
		for (const name of ['@parcel/watcher', '@vscode/deviceid', '@vscode/spdlog', 'kerberos']) {
			const resolved = lock.packages[`node_modules/${name}`].resolved;
			assert(resolved.startsWith('file:'));
			assert.equal(policy.isScriptAllowed({ resolved, root: { path: project }, inBundle: false }, manifest.allowScripts), true, `${directory}/${name}`);
		}
	}
});
