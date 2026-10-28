/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { test } from 'node:test';
import VinylFile from 'vinyl';
import { filter } from '../gulp/facade.ts';
import { getNodePtyExcludeFilter } from '../nativePlatformPackages.ts';

test('node-pty packaging retains only target prebuilds and shared runtime files', async () => {
	const root = path.resolve(import.meta.dirname, '../../..');
	const prebuilds = fs.readdirSync(path.join(root, 'node_modules/node-pty/prebuilds'));
	for (const [platform, arch, target] of [['win32', 'x64', 'win32-x64'], ['win32', 'arm64', 'win32-arm64'], ['darwin', 'arm64', 'darwin-arm64'], ['linux', 'x64', 'linux-x64'], ['linux', 'armhf', 'linux-arm'], ['alpine', 'arm64', 'linux-arm64']]) {
		const input = [
			...prebuilds.flatMap(directory => fs.readdirSync(path.join(root, 'node_modules/node-pty/prebuilds', directory), { recursive: true }).map(file => `node_modules/node-pty/prebuilds/${directory}/${String(file).replace(/\\/g, '/')}`)),
			'node_modules/node-pty/lib/utils.js', 'node_modules/node-pty/build/Release/conpty.node',
			'node_modules/unrelated/prebuilds/linux-x64/other.node',
		];
		const stream = filter(getNodePtyExcludeFilter(platform, arch));
		const retained: string[] = [];
		const complete = new Promise<void>((resolve, reject) => {
			stream.on('data', (file: VinylFile) => retained.push(file.relative.replace(/\\/g, '/')));
			stream.on('end', resolve);
			stream.on('error', reject);
		});
		for (const relative of input) {
			stream.write(new VinylFile({ base: root, path: path.join(root, relative), contents: Buffer.alloc(0) }));
		}
		stream.end();
		await complete;
		assert.deepStrictEqual(retained, input.filter(file => !file.startsWith('node_modules/node-pty/prebuilds/') || file.startsWith(`node_modules/node-pty/prebuilds/${target}/`)), `${platform}-${arch}`);
	}
});
