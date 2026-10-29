import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { getExtensionStream, type IExtensionDefinition } from '../builtInExtensions.ts';

test('cached extensions preserve binary bytes', async () => {
	const cache = await fs.mkdtemp(path.resolve('.build/builtInExtensions/octocode-binary-test-'));
	const contents = Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0x80, 0, 0xc0]);
	try {
		await fs.writeFile(path.join(cache, 'package.json'), JSON.stringify({ version: '1.0.0' }));
		await fs.writeFile(path.join(cache, 'binding.node'), contents);
		const definition = { name: path.basename(cache), version: '1.0.0' } as IExtensionDefinition;
		const files: { path: string; contents: Buffer }[] = [];
		await new Promise<void>((resolve, reject) => {
			getExtensionStream(definition).on('data', file => files.push(file)).on('error', reject).on('end', resolve);
		});
		assert.deepStrictEqual(files.find(file => file.path.endsWith('binding.node'))?.contents, contents);
	} finally {
		await fs.rm(cache, { recursive: true, force: true });
	}
});
