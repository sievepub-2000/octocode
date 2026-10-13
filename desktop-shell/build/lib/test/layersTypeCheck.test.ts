/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { after, before, suite, test } from 'node:test';
import ts from 'typescript';

suite('layersTypeCheck', () => {
	const repositoryRoot = path.join(import.meta.dirname, '../../..');
	const temporaryRoot = path.resolve(os.tmpdir());
	const nativeCompiler = path.join(path.dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json')), 'bin/tsc');
	let directory: string;
	let webEvent: string;

	before(() => {
		directory = fs.mkdtempSync(path.join(temporaryRoot, 'layers-type-check-'));
		webEvent = path.join(directory, 'web-event.mts');
		fs.writeFileSync(webEvent, `export const update = new TextUpdateEvent('textupdate');\n`);
	});

	after(() => {
		if (directory) {
			assert.strictEqual(path.dirname(path.resolve(directory)), temporaryRoot);
			assert.ok(path.basename(directory).startsWith('layers-type-check-'));
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	function project(lane: string) {
		const file = path.join(repositoryRoot, 'build/checker', `tsconfig.${lane}.json`);
		const config = ts.readConfigFile(file, ts.sys.readFile);
		assert.strictEqual(config.error, undefined);
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(file), undefined, file);
		assert.deepStrictEqual(parsed.errors, []);
		return { file, config: config.config, parsed };
	}

	function typeCheck(lane: string, fixture: string) {
		const value = project(lane);
		const config = path.join(directory, `${lane}.json`);
		const ambientFiles = value.parsed.fileNames.filter(file => file.replaceAll('\\', '/').includes('/src/typings/'));
		fs.writeFileSync(config, JSON.stringify({
			extends: value.file,
			include: [],
			files: [fixture, ...ambientFiles],
			compilerOptions: {
				typeRoots: [path.join(repositoryRoot, 'node_modules/@types')],
				noEmit: true,
				incremental: false,
				composite: false
			}
		}));
		const result = spawnSync(process.execPath, [nativeCompiler, '--project', config, '--pretty', 'false'], {
			cwd: repositoryRoot, encoding: 'utf8', timeout: 30000
		});
		assert.strictEqual(result.error, undefined);
		return result;
	}

	test('electron-utility rejects browser-only EditContext event constructors', () => {
		const result = typeCheck('electron-utility', webEvent);
		assert.strictEqual(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout + result.stderr, /Cannot find name 'TextUpdateEvent'/);
		assert.ok(!project('electron-utility').parsed.fileNames.some(file => file.endsWith('editContext.d.ts')));
	});

	test('electron-utility and node accept Node-only APIs', () => {
		const fixture = path.join(directory, 'node-only.mts');
		fs.writeFileSync(fixture, 'export const platform: string = process.platform;\nexport const controller = new AbortController();\n');
		for (const lane of ['electron-utility', 'node']) {
			const result = typeCheck(lane, fixture);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		}
	});

	test('browser lanes retain EditContext declarations and event constructors', () => {
		for (const lane of ['browser', 'electron-browser']) {
			assert.ok(project(lane).parsed.fileNames.some(file => file.endsWith('editContext.d.ts')));
			const result = typeCheck(lane, webEvent);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		}
	});

	test('electron-utility preserves the node compiler options and exclusions', () => {
		const utility = project('electron-utility');
		const node = project('node');
		const options = (value: ts.CompilerOptions) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'configFilePath'));
		assert.deepStrictEqual(options(utility.parsed.options), options(node.parsed.options));
		for (const exclusion of node.config.exclude as string[]) {
			assert.ok(utility.config.exclude.includes(exclusion), exclusion);
		}
	});
});
