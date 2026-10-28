/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { test } from 'node:test';
import VinylFile from 'vinyl';
import { getRawHeader } from '@electron/asar';
import { createAsar } from '../asar.ts';
import { brandWin32Dependencies, brandWin32DependencyFile, isPrebrandedWin32Dependency } from '../win32DependencyBranding.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = (contents: Buffer) => createHash('sha256').update(contents).digest('hex');
function collect(stream: NodeJS.ReadWriteStream, files: VinylFile[]): Promise<VinylFile[]> {
	return new Promise((resolve, reject) => {
		const output: VinylFile[] = [];
		stream.on('data', file => output.push(file));
		stream.on('error', reject);
		stream.on('end', () => resolve(output));
		for (const file of files) { stream.write(file); }
		stream.end();
	});
}
function temporaryBrandingDirectories(): string[] {
	return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('octocode-brand-native-')).sort();
}
function signatureSize(contents: Buffer): number {
	const optionalHeader = contents.readUInt32LE(0x3c) + 24;
	const dataDirectories = optionalHeader + (contents.readUInt16LE(optionalHeader) === 0x20b ? 112 : 96);
	return contents.readUInt32LE(dataDirectories + 4 * 8 + 4);
}

test('post-package branding excludes only already processed root dependency paths', () => {
	for (const file of ['resources/app/node_modules.asar.unpacked/native/binding.node', 'resources/app/node_modules/vsda/native.node', 'commit/resources/app/node_modules.asar.unpacked/tool/rg.exe']) {
		assert(isPrebrandedWin32Dependency(file), file);
		assert(isPrebrandedWin32Dependency(file.replaceAll('/', path.win32.sep)), file);
	}
	for (const file of ['resources/app/extensions/native/binding.node', 'resources/app/extensions/node_modules/native/binding.node', 'resources/app/bin/rg.exe', 'resources/app/resources/win32/code_explorer_command_x64.dll']) {
		assert.strictEqual(isPrebrandedWin32Dependency(file), false, file);
	}
});

test('branding leaves ordinary files unchanged and rejects unbuffered native input', async () => {
	const ordinary = new VinylFile({ path: path.resolve('ordinary.js'), contents: Buffer.from('ordinary') });
	assert.strictEqual((await collect(brandWin32Dependencies('2.0.0', 'OctoCode'), [ordinary]))[0], ordinary);
	await assert.rejects(collect(brandWin32Dependencies('2.0.0', 'OctoCode'), [new VinylFile({ path: path.resolve('invalid.node') })]), /requires buffered contents/);
});

test('the former archive-then-brand sequence reproduces stale size and integrity on a real PE', { skip: process.platform !== 'win32' }, async () => {
	const fixture = fs.mkdtempSync('E:/Program Files/octocode/test/native-branding-before-');
	const input = path.join(fixture, 'input/node_modules');
	const filename = path.join(input, 'binding.node');
	const original = fs.readFileSync(path.join(root, 'work/verification/spki-test.node'));
	fs.mkdirSync(input, { recursive: true });
	fs.writeFileSync(filename, original);
	const output = await collect(createAsar(input, ['**/*.node'], [], [], 'node_modules.asar'), [new VinylFile({ base: path.dirname(input), path: filename, stat: fs.statSync(filename), contents: original })]);
	for (const file of output) {
		const target = file.path.endsWith('.asar') ? path.join(fixture, 'node_modules.asar') : path.join(fixture, 'node_modules.asar.unpacked/binding.node');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file.contents as Buffer);
	}
	const header = getRawHeader(path.join(fixture, 'node_modules.asar')).header as { files: Record<string, { size: number; integrity: { hash: string } }> };
	assert.strictEqual(header.files['binding.node'].integrity.hash, hash(original));
	const unpacked = path.join(fixture, 'node_modules.asar.unpacked/binding.node');
	await brandWin32DependencyFile(unpacked, '2.0.0', 'OctoCode');
	const after = fs.readFileSync(unpacked);
	assert.notStrictEqual(header.files['binding.node'].integrity.hash, hash(after));
	assert.notStrictEqual(header.files['binding.node'].size, after.length);
	console.log(JSON.stringify({ formerOrderReproducesStaleMetadata: true, fixture, headerSize: header.files['binding.node'].size, brandedSize: after.length }));
});

test('final branded PE bytes, size and every integrity block agree before native ASAR loading', { skip: process.platform !== 'win32' }, async () => {
	const fixture = fs.mkdtempSync('E:/Program Files/octocode/test/native-branding-');
	const input = path.join(fixture, 'input/node_modules');
	const filename = path.join(input, '@octo-fixture/native/binding.node');
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	const originalPath = path.join(root, 'work/verification/spki-test.node');
	const original = fs.readFileSync(originalPath);
	fs.writeFileSync(filename, original);
	const beforeDirectories = temporaryBrandingDirectories();
	const files = await collect(brandWin32Dependencies('2.0.0', 'OctoCode'), [new VinylFile({ base: path.dirname(input), path: filename, stat: fs.statSync(filename), contents: original })]);
	const branded = files[0].contents as Buffer;
	assert.notStrictEqual(hash(branded), hash(original), 'the real PE resource update must change bytes');
	assert.strictEqual(hash(fs.readFileSync(filename)), hash(original));
	assert.strictEqual(hash(fs.readFileSync(originalPath)), hash(original));
	assert.strictEqual(files[0].stat!.size, branded.length);
	assert(branded.includes(Buffer.from('OctoCode', 'utf16le')));
	assert.deepStrictEqual(temporaryBrandingDirectories(), beforeDirectories);
	const output = await collect(createAsar(input, ['**/*.node'], [], ['**/binding.node'], 'node_modules.asar'), files);
	for (const file of output) {
		const target = file.path.endsWith('.asar') ? path.join(fixture, 'node_modules.asar')
			: file.path.includes('node_modules.asar.unpacked') ? path.join(fixture, 'node_modules.asar.unpacked/@octo-fixture/native/binding.node')
				: path.join(fixture, 'node_modules/@octo-fixture/native/binding.node');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file.contents as Buffer);
	}
	const archive = path.join(fixture, 'node_modules.asar');
	type NativeEntry = { size: number; unpacked: boolean; integrity: { hash: string; blockSize: number; blocks: string[] } };
	type Directory<T> = { files: Record<string, T> };
	const header = getRawHeader(archive).header as Directory<Directory<Directory<NativeEntry>>>;
	const entry = header.files['@octo-fixture'].files.native.files['binding.node'];
	assert.strictEqual(entry.unpacked, true);
	assert.strictEqual(entry.size, branded.length);
	assert.strictEqual(entry.integrity.hash, hash(branded));
	const blocks: string[] = [];
	for (let offset = 0; offset < branded.length; offset += entry.integrity.blockSize) { blocks.push(hash(branded.subarray(offset, offset + entry.integrity.blockSize))); }
	assert.deepStrictEqual(entry.integrity.blocks, blocks);
	for (const filename of ['node_modules.asar.unpacked/@octo-fixture/native/binding.node', 'node_modules/@octo-fixture/native/binding.node']) {
		assert.strictEqual(hash(fs.readFileSync(path.join(fixture, filename))), entry.integrity.hash);
	}
	const runtimeReport = JSON.parse(fs.readFileSync(path.join(root, '../../reports/packaged-node-security-oct25.json'), 'utf8'));
	const executable = path.join(runtimeReport.fixture, 'OctoCode.exe');
	const result = spawnSync(executable, ['-e', `require(${JSON.stringify(archive + '/@octo-fixture/native/binding.node')}).clear(); console.log('native-loaded')`], { cwd: fixture, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
	assert.strictEqual(result.status, 0, result.stderr);
	assert.match(result.stdout, /native-loaded/);
	console.log(JSON.stringify({ nativeBrandingFixture: fixture, originalSha256: hash(original), finalSha256: hash(branded), finalSize: branded.length, nativeLoaded: true }));
});

test('verified signed inputs are stripped only in the temporary copy and invalid PE errors clean up', { skip: process.platform !== 'win32' }, async () => {
	const signTool = 'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64';
	assert(fs.existsSync(path.join(signTool, 'signtool.exe')));
	const originalPath = path.join(root, '.build/environments/node/node.exe');
	const original = fs.readFileSync(originalPath);
	assert(signatureSize(original) > 0, 'official signed Node fixture required');
	const originalPathEnvironment = process.env.PATH;
	process.env.PATH = signTool + path.delimiter + originalPathEnvironment;
	try {
		const beforeDirectories = temporaryBrandingDirectories();
		const [file] = await collect(brandWin32Dependencies('2.0.0', 'OctoCode'), [new VinylFile({ path: path.resolve('rg.exe'), stat: fs.statSync(originalPath), contents: original })]);
		assert.strictEqual(signatureSize(file.contents as Buffer), 0);
		assert.strictEqual(hash(fs.readFileSync(originalPath)), hash(original), 'original signed source must remain unchanged');
		assert(signatureSize(original) > 0);
		await assert.rejects(collect(brandWin32Dependencies('2.0.0', 'OctoCode'), [new VinylFile({ path: path.resolve('broken.node'), contents: Buffer.from('not a Windows PE') })]), /Resource editing requires a Windows PE executable/);
		assert.deepStrictEqual(temporaryBrandingDirectories(), beforeDirectories);
	} finally {
		process.env.PATH = originalPathEnvironment;
	}
});
