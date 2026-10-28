/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Readable } from 'stream';
import es from 'event-stream';
import { createPackageFromStreams } from '@electron/asar';
import VinylFile from 'vinyl';
import { minimatch } from 'minimatch';

export function createAsar(folderPath: string, unpackGlobs: string[], skipGlobs: string[], duplicateGlobs: string[], destFilename: string): NodeJS.ReadWriteStream {

	const shouldUnpackFile = (file: VinylFile): boolean => {
		for (let i = 0; i < unpackGlobs.length; i++) {
			if (minimatch(file.relative, unpackGlobs[i])) {
				return true;
			}
		}
		return false;
	};

	const shouldSkipFile = (file: VinylFile): boolean => {
		for (const skipGlob of skipGlobs) {
			if (minimatch(file.relative, skipGlob)) {
				return true;
			}
		}
		return false;
	};

	// Files that should be duplicated between
	// node_modules.asar and node_modules
	const shouldDuplicateFile = (file: VinylFile): boolean => {
		for (const duplicateGlob of duplicateGlobs) {
			if (minimatch(file.relative, duplicateGlob)) {
				return true;
			}
		}
		return false;
	};

	const entries: Parameters<typeof createPackageFromStreams>[1] = [];

	// Do not insert twice the same directory
	const seenDir: { [key: string]: boolean } = {};
	const insertDirectoryRecursive = (dir: string) => {
		if (seenDir[dir]) {
			return;
		}

		let lastSlash = dir.lastIndexOf('/');
		if (lastSlash === -1) {
			lastSlash = dir.lastIndexOf('\\');
		}
		if (lastSlash !== -1) {
			insertDirectoryRecursive(dir.substring(0, lastSlash));
		}
		seenDir[dir] = true;
		entries.push({ type: 'directory', path: dir, unpacked: false });
	};

	const insertDirectoryForFile = (file: string) => {
		let lastSlash = file.lastIndexOf('/');
		if (lastSlash === -1) {
			lastSlash = file.lastIndexOf('\\');
		}
		if (lastSlash !== -1) {
			insertDirectoryRecursive(file.substring(0, lastSlash));
		}
	};

	return es.through(function (file) {
		if (file.stat.isDirectory()) {
			return;
		}
		if (!file.stat.isFile()) {
			throw new Error(`unknown item in stream!`);
		}
		if (!Buffer.isBuffer(file.contents)) {
			throw new Error(`ASAR requires buffered contents: ${file.path}`);
		}
		if (shouldSkipFile(file)) {
			this.queue(new VinylFile({
				base: '.',
				path: file.path,
				stat: file.stat,
				contents: file.contents
			}));
			return;
		}
		if (shouldDuplicateFile(file)) {
			this.queue(new VinylFile({
				base: '.',
				path: file.path,
				stat: file.stat,
				contents: file.contents
			}));
		}
		const shouldUnpack = shouldUnpackFile(file);
		// The Vinyl base can be the app root; the archive and its unpacked sibling
		// must both be rooted at folderPath (node_modules), with identical paths.
		const relative = path.relative(folderPath, file.path);
		if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
			throw new Error(`ASAR input is outside its source folder: ${file.path}`);
		}
		insertDirectoryForFile(relative);
		// Use the transformed Vinyl buffer, not the possibly stale source file on disk.
		const contents = file.contents;
		entries.push({
			type: 'file', path: relative, unpacked: shouldUnpack,
			stat: { ...file.stat, size: contents.length },
			streamGenerator: () => Readable.from([contents])
		});

		if (shouldUnpack) {
			// The file goes outside of xx.asar, in a folder xx.asar.unpacked
			this.queue(new VinylFile({
				base: '.',
				path: path.join(destFilename + '.unpacked', relative),
				stat: file.stat,
				contents: file.contents
			}));
		}
	}, function () {
		const finish = async () => {
			const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-asar-'));
			try {
				const archive = path.join(temporary, 'archive.asar');
				await createPackageFromStreams(archive, entries);
				this.queue(new VinylFile({ base: '.', path: destFilename, contents: await fs.promises.readFile(archive) }));
			} finally {
				entries.length = 0;
				await fs.promises.rm(temporary, { recursive: true, force: true });
			}
		};
		void finish().then(() => this.queue(null), error => this.emit('error', error));
	});
}
