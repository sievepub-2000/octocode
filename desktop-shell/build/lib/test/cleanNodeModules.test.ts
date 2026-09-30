/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import VinylFile from 'vinyl';
import { cleanNodeModules } from '../util.ts';

test('cleanNodeModules excludes matching files and preserves explicit inclusions', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-node-modules-'));
	const rules = path.join(directory, '.moduleignore');
	fs.writeFileSync(rules, 'pkg/build/**\n!pkg/build/Release/addon.node\n');
	try {
		const names = ['node_modules/pkg/index.js', 'node_modules/pkg/build/debug.pdb', 'node_modules/pkg/build/Release/addon.node'];
		const files = names.map(name => new VinylFile({ cwd: directory, base: directory, path: path.join(directory, name), contents: Buffer.from(name) }));
		const output: string[] = [];
		for await (const file of Readable.from(files).pipe(cleanNodeModules(rules)) as AsyncIterable<VinylFile>) {
			output.push(file.relative.replaceAll('\\', '/'));
		}
		assert.deepEqual(output, ['node_modules/pkg/index.js', 'node_modules/pkg/build/Release/addon.node']);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
