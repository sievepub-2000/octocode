/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateWindowsUpdate, verifyWindowsUpdatePackage } from '../../electron-main/win32UpdatePackage.js';

suite('Windows update package', () => {
	const update = { version: '20260920-a1b2', productVersion: '1.0.0', url: 'https://updates.octocode.invalid/setup.exe', sha256hash: createHash('sha256').update('installer').digest('hex') };

	test('rejects unsafe metadata before downloading or constructing paths', () => {
		validateWindowsUpdate(update);
		for (const version of ['../outside', 'a/../../outside', 'a\\outside', '.', 'a:stream']) {
			assert.throws(() => validateWindowsUpdate({ ...update, version }));
		}
		assert.throws(() => validateWindowsUpdate({ ...update, sha256hash: undefined }));
		assert.throws(() => validateWindowsUpdate({ ...update, sha256hash: 'bad' }));
		assert.throws(() => validateWindowsUpdate({ ...update, url: 'http://example.com/setup.exe' }));
		assert.throws(() => validateWindowsUpdate({ ...update, size: -1 }));
	});

	test('verifies both fresh and cached packages and rejects tampering', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'octocode-update-'));
		try {
			const file = join(directory, 'setup.exe');
			await writeFile(file, 'installer');
			await verifyWindowsUpdatePackage(file, update);
			await verifyWindowsUpdatePackage(file, { ...update, size: 9 });
			await assert.rejects(verifyWindowsUpdatePackage(file, { ...update, size: 10 }), /size/);
			await verifyWindowsUpdatePackage(file, { ...update, sha256hash: update.sha256hash.toUpperCase() });
			await writeFile(file, 'tampered');
			await assert.rejects(verifyWindowsUpdatePackage(file, update));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
