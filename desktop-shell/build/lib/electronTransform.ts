/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import { createRequire } from 'node:module';
import { Duplex, PassThrough, Transform } from 'node:stream';
import type VinylFile from 'vinyl';
import { mergeStreams as merge } from './mergeStreams.ts';

const require = createRequire(import.meta.url);
const download = require('@vscode/gulp-electron/src/download');

export function electronTransform(options: any): NodeJS.ReadWriteStream {
	if (!options.version || !options.platform) {
		throw new Error('Electron version and platform are required.');
	}

	const electronFiles = new PassThrough({ objectMode: true });
	let move: ((file: VinylFile) => VinylFile) | undefined;
	const buffered: VinylFile[] = [];

	const appFiles = new Transform({
		objectMode: true,
		transform(file: VinylFile, _encoding, callback) {
			if (!move) {
				buffered.push(file);
				if (file.relative !== 'package.json') {
					callback();
					return;
				}

				const manifest = JSON.parse(file.contents!.toString());
				const resolved = { ...options, productName: manifest.name, productVersion: manifest.version };
				const platform = require(`@vscode/gulp-electron/src/${resolved.platform}`);
				const appPath = platform.getAppPath(resolved);
				move = item => {
					item.path = path.join(item.base, appPath, item.relative);
					return item;
				};
				for (const item of buffered.splice(0)) {
					this.push(move(item));
				}

				const archive = download(resolved);
				const patched = archive.pipe(platform.patch(resolved));
				archive.on('error', (error: Error) => electronFiles.destroy(error));
				patched.on('error', (error: Error) => electronFiles.destroy(error));
				patched.pipe(electronFiles);
				callback();
				return;
			}

			callback(null, move(file));
		},
		flush(callback) {
			if (!move) {
				const error = new Error('Electron input did not contain package.json.');
				electronFiles.destroy(error);
				callback(error);
				return;
			}
			callback();
		}
	});

	const input = new PassThrough({ objectMode: true });
	input.pipe(appFiles);
	return Duplex.from({ writable: input, readable: merge(appFiles, electronFiles) });
}
