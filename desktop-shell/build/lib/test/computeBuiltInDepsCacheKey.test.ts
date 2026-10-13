/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { after, before, suite, test } from 'node:test';

interface Extension {
	name: string;
	version: string;
	platformSpecific?: Record<string, string>;
}

suite('computeBuiltInDepsCacheKey', () => {
	const temporaryRoot = path.resolve(os.tmpdir());
	let directory: string;
	let cli: string;

	before(() => {
		directory = fs.mkdtempSync(path.join(temporaryRoot, 'builtin-cache-key-'));
		const buildRoot = path.resolve(import.meta.dirname, '../..');
		cli = path.join(directory, 'build/azure-pipelines/common/computeBuiltInDepsCacheKey.ts');
		const target = path.join(directory, 'build/lib/extensionTarget.ts');
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(buildRoot, 'azure-pipelines/common/computeBuiltInDepsCacheKey.ts'), cli);
		fs.copyFileSync(path.join(buildRoot, 'lib/extensionTarget.ts'), target);
		fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
	});

	after(() => {
		if (directory) {
			assert.strictEqual(path.dirname(path.resolve(directory)), temporaryRoot);
			assert.ok(path.basename(directory).startsWith('builtin-cache-key-'));
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	function key(extensions: Extension[], target = 'win32-x64', arch = 'x64'): string {
		const builtInExtensions = extensions.map(extension => ({
			...extension,
			sha256: 'a'.repeat(64),
			repo: 'https://github.com/example/fixture',
			metadata: {
				id: '00000000-0000-0000-0000-000000000001',
				publisherId: {
					publisherId: '00000000-0000-0000-0000-000000000002',
					publisherName: extension.name.split('.')[0],
					displayName: 'Fixture publisher',
					flags: 'verified'
				},
				publisherDisplayName: 'Fixture publisher'
			}
		}));
		fs.writeFileSync(path.join(directory, 'product.json'), JSON.stringify({ builtInExtensions }));
		const output = execFileSync(process.execPath, [cli], {
			encoding: 'utf8', timeout: 10000,
			env: { ...process.env, VSCODE_EXTENSION_TARGET: target, VSCODE_ARCH: arch }
		});
		assert.match(output, /^[a-f0-9]{64}$/);
		return output;
	}

	test('distinguishes valid extension lists with the same concatenated names and versions', () => {
		const first = [{ name: 'vendor.one', version: '1.0.1' }, { name: '0vendor.two', version: '2.0.0' }];
		const second = [{ name: 'vendor.one', version: '1.0.10' }, { name: 'vendor.two', version: '2.0.0' }];
		assert.notStrictEqual(key(first), key(second));
	});

	test('distinguishes valid prerelease versions at extension boundaries', () => {
		const first = [{ name: 'vendor.one', version: '1.2.3-a' }, { name: 'bvendor.two', version: '1.0.0' }];
		const second = [{ name: 'vendor.one', version: '1.2.3-ab' }, { name: 'vendor.two', version: '1.0.0' }];
		assert.notStrictEqual(key(first), key(second));
	});

	test('includes every extension name and version', () => {
		const extensions = [{ name: 'vendor.one', version: '1.0.0' }, { name: 'vendor.two', version: '2.0.0' }];
		const original = key(extensions);
		for (const index of [0, 1]) {
			for (const field of ['name', 'version'] as const) {
				const changed = extensions.map(extension => ({ ...extension }));
				changed[index][field] = field === 'name' ? 'other.extension' : '3.0.0';
				assert.notStrictEqual(key(changed), original);
			}
		}
	});

	test('encodes delimiters and escaped Unicode strings without merging fields', () => {
		for (const delimiter of ['@', ':', '","', '\n', '扩展🚀']) {
			const first = [{ name: `vendor.one${delimiter}part`, version: '1.0.0' }];
			const second = [{ name: 'vendor.one', version: `part${delimiter}1.0.0` }];
			assert.notStrictEqual(key(first), key(second));
			assert.notStrictEqual(key([{ name: `vendor.${delimiter}`, version: '1.0.0' }]), key([{ name: 'vendor.other', version: '1.0.0' }]));
		}
	});

	test('preserves extension order', () => {
		const extensions = [{ name: 'vendor.one', version: '1.0.0' }, { name: 'vendor.two', version: '2.0.0' }];
		assert.notStrictEqual(key(extensions), key([...extensions].reverse()));
	});

	test('distinguishes an empty list and additional extensions', () => {
		const extension = { name: 'vendor.one', version: '1.0.0' };
		assert.notStrictEqual(key([]), key([extension]));
		assert.notStrictEqual(key([extension]), key([extension, extension]));
	});

	test('recomputes the same key deterministically', () => {
		const extensions = [{ name: 'vendor.one', version: '1.0.0', platformSpecific: { 'win32-x64': 'a'.repeat(64) } }];
		assert.strictEqual(key(extensions), key(JSON.parse(JSON.stringify(extensions))));
	});

	test('shares non-specific lists across target and architecture settings', () => {
		const extensions = [{ name: 'vendor.one', version: '1.0.0' }];
		for (const list of [[], extensions]) {
			const shared = key(list);
			for (const target of ['linux-arm64', 'darwin-arm64', 'win32-arm64', 'unsupported', '']) {
				assert.strictEqual(key(list, target, 'unsupported'), shared);
			}
		}
	});

	test('includes the target when a later extension is platform-specific', () => {
		const checksum = 'a'.repeat(64);
		const extensions = [
			{ name: 'vendor.one', version: '1.0.0' },
			{ name: 'vendor.two', version: '2.0.0', platformSpecific: { 'win32-x64': checksum, 'linux-arm64': checksum } }
		];
		assert.notStrictEqual(key(extensions, 'win32-x64'), key(extensions, 'linux-arm64'));
	});

	test('includes each selected checksum but ignores unselected checksums and map order', () => {
		const extensions = ['one', 'two'].map(name => ({
			name: `vendor.${name}`, version: '1.0.0',
			platformSpecific: { 'win32-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) }
		}));
		const original = key(extensions);
		for (const index of [0, 1]) {
			const changed = extensions.map(extension => ({ ...extension, platformSpecific: { ...extension.platformSpecific } }));
			changed[index].platformSpecific['win32-x64'] = 'c'.repeat(64);
			assert.notStrictEqual(key(changed), original);
			changed[index].platformSpecific = { 'linux-arm64': 'c'.repeat(64), 'win32-x64': 'a'.repeat(64) };
			assert.strictEqual(key(changed), original);
		}
	});

	test('preserves the target salt and absent checksum branch for empty or missing selected assets', () => {
		const extension = { name: 'vendor.one', version: '1.0.0' };
		const missing = [{ ...extension, platformSpecific: {} }];
		assert.strictEqual(key(missing), key([{ ...extension, platformSpecific: { 'win32-x64': '' } }]));
		assert.strictEqual(key(missing), key([{ ...extension, platformSpecific: { 'linux-arm64': 'a'.repeat(64) } }]));
		assert.notStrictEqual(key(missing), key([extension]));
		assert.notStrictEqual(key(missing, 'win32-x64'), key(missing, 'linux-arm64'));
	});

	test('keeps a selected checksum separate from version text', () => {
		const first = [{ name: 'vendor.one', version: '1.0.0', platformSpecific: { 'win32-x64': 'sha:part' } }];
		const second = [{ name: 'vendor.one', version: '1.0.0:sha', platformSpecific: { 'win32-x64': 'part' } }];
		assert.notStrictEqual(key(first), key(second));
	});

	test('omits the target and selected checksum when the host target is unsupported', () => {
		const extension = { name: 'vendor.one', version: '1.0.0' };
		const specific = [{ ...extension, platformSpecific: { 'win32-x64': 'a'.repeat(64) } }];
		assert.strictEqual(key(specific, '', 'unsupported'), key([extension], '', 'unsupported'));
	});
});
