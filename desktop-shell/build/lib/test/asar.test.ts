/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { test } from 'node:test';
import { createPackageWithOptions, extractAll, extractFile, listPackage, statFile, uncacheAll } from '@electron/asar';
import VinylFile from 'vinyl';
import { createAsar } from '../asar.ts';

test('ASAR preserves buffered content, insertion order, duplicate contents and unpacked output', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-asar-test-'));
	try {
		const source = path.join(fixture, 'source');
		await fs.promises.mkdir(source);
		const files = [
			['z.txt', 'same content'], ['a.txt', 'same content'], ['module/native.node', 'native'],
			['module/duplicate.txt', 'duplicate'], ['module/skip.txt', 'skip'], ['empty.txt', '']
		];
		const archive = createAsar(source, ['**/*.node'], ['**/skip.txt'], ['**/duplicate.txt'], 'modules.asar');
		const output: VinylFile[] = [];
		const complete = new Promise<void>((resolve, reject) => {
			archive.on('data', file => output.push(file));
			archive.on('end', resolve);
			archive.on('error', reject);
		});
		for (const [relative, content] of files) {
			const filename = path.join(source, relative);
			await fs.promises.mkdir(path.dirname(filename), { recursive: true });
			await fs.promises.writeFile(filename, 'stale source content');
			// Production streams have an app-root base, while folderPath is node_modules.
			// Archive paths must use folderPath, not the unrelated Vinyl base.
			archive.write(new VinylFile({ base: fixture, path: filename, stat: await fs.promises.stat(filename), contents: Buffer.from(content) }));
		}
		archive.end();
		await complete;
		const destination = path.join(fixture, 'result');
		await fs.promises.mkdir(destination);
		for (const file of output) {
			const relative = file.path.endsWith('.asar') ? 'modules.asar' : file.path.includes('.asar.unpacked') ? path.join('modules.asar.unpacked', 'module', 'native.node') : path.relative(source, file.path);
			const target = path.join(destination, relative);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(target, file.contents as Buffer);
		}
		const filename = path.join(destination, 'modules.asar');
		assert.deepStrictEqual(listPackage(filename, { isPack: false }).map(item => item.replace(/\\/g, '/')), ['/z.txt', '/a.txt', '/module', '/module/native.node', '/module/duplicate.txt', '/empty.txt']);
		for (const [relative, content] of files.filter(([relative]) => !relative.endsWith('skip.txt'))) {
			assert.strictEqual(extractFile(filename, relative).toString(), content);
		}
		assert.strictEqual(fs.readFileSync(path.join(destination, 'module/duplicate.txt'), 'utf8'), 'duplicate');
		assert.strictEqual(fs.readFileSync(path.join(destination, 'module/skip.txt'), 'utf8'), 'skip');
		const native = statFile(filename, 'module/native.node');
		assert.strictEqual(Object.getOwnPropertyDescriptor(native, 'unpacked')?.value, true);
		extractAll(filename, path.join(fixture, 'extracted'));
		assert.strictEqual(fs.readFileSync(path.join(fixture, 'extracted/module/native.node'), 'utf8'), 'native');
	} finally {
		uncacheAll();
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});

test('ASAR rejects unbuffered input before producing an invalid archive', () => {
	const stream = createAsar('.', [], [], [], 'modules.asar') as NodeJS.ReadWriteStream & { destroy(): void };
	assert.throws(() => stream.write(new VinylFile({ path: 'invalid', stat: { isDirectory: () => false, isFile: () => true } as fs.Stats })), /requires buffered contents/);
	stream.destroy();
});

test('ASAR rejects a buffered file outside its declared source folder', () => {
	const fixture = path.join(os.tmpdir(), 'octocode-asar-path-scope');
	const source = path.join(fixture, 'node_modules');
	const stream = createAsar(source, [], [], [], 'modules.asar') as NodeJS.ReadWriteStream & { destroy(): void };
	assert.throws(() => stream.write(new VinylFile({
		base: fixture,
		path: path.join(fixture, 'outside.js'),
		stat: { isDirectory: () => false, isFile: () => true } as fs.Stats,
		contents: Buffer.from('outside')
	})), /outside its source folder/);
	stream.destroy();
});

test('universal bundler merges real ASAR archives through the maintained namespace API', async () => {
	const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-universal-asar-test-'));
	try {
		for (const arch of ['x64', 'arm64']) {
			const source = path.join(fixture, arch);
			await fs.promises.mkdir(source);
			await fs.promises.writeFile(path.join(source, 'common.txt'), 'common content');
			await fs.promises.writeFile(path.join(source, `${arch}-only.txt`), arch);
			await fs.promises.writeFile(path.join(source, 'native.node'), 'identical native fixture');
			await createPackageWithOptions(source, path.join(fixture, `${arch}.asar`), { unpack: '**/*.node' });
		}
		const require = createRequire(import.meta.url);
		const utils = require(path.join(path.dirname(require.resolve('vscode-universal-bundler')), 'asar-utils.js'));
		const output = path.join(fixture, 'universal.asar');
		await utils.mergeASARs({ x64AsarPath: path.join(fixture, 'x64.asar'), arm64AsarPath: path.join(fixture, 'arm64.asar'), outputAsarPath: output, singleArchFiles: '*-only.txt' });
		assert.strictEqual(extractFile(output, 'common.txt').toString(), 'common content');
		assert.strictEqual(extractFile(output, 'x64-only.txt').toString(), 'x64');
		assert.strictEqual(extractFile(output, 'arm64-only.txt').toString(), 'arm64');
		assert.strictEqual(extractFile(output, 'native.node').toString(), 'identical native fixture');
		const native = statFile(output, 'native.node');
		assert.strictEqual(Object.getOwnPropertyDescriptor(native, 'unpacked')?.value, true);
		assert.strictEqual(utils.generateAsarIntegrity(output).hash.length, 64);
	} finally {
		uncacheAll();
		await fs.promises.rm(fixture, { recursive: true, force: true });
	}
});
