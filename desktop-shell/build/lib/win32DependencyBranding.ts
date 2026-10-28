/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import es from 'event-stream';
import type VinylFile from 'vinyl';
import { rcedit } from 'rcedit';

function hasAuthenticodeSignature(filePath: string): Promise<boolean> {
	return new Promise(resolve => {
		const proc = cp.spawn('signtool.exe', ['verify', '/pa', filePath]);
		proc.on('error', () => resolve(false));
		proc.on('exit', code => resolve(code === 0));
	});
}

async function stripAuthenticodeSignature(filePath: string): Promise<void> {
	// Preserve the existing signing policy: remove a verified signature before
	// rcedit changes its signed bytes. Final distribution signing happens later.
	if (!await hasAuthenticodeSignature(filePath)) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const proc = cp.spawn('signtool.exe', ['remove', '/s', filePath]);
		let out = '';
		proc.stdout?.on('data', chunk => out += chunk.toString());
		proc.stderr?.on('data', chunk => out += chunk.toString());
		proc.on('error', reject);
		proc.on('exit', code => {
			if (code === 0) {
				resolve();
			} else {
				process.stderr.write(out);
				reject(new Error(`signtool remove /s failed for ${filePath} (exit ${code})`));
			}
		});
	});
}

export async function brandWin32DependencyFile(filePath: string, version: string, productName: string): Promise<void> {
	await stripAuthenticodeSignature(filePath);
	await rcedit(filePath, {
		'file-version': version.replace(/-.*$/, ''),
		'version-string': {
			'CompanyName': 'OctoCode',
			'FileDescription': productName,
			'FileVersion': version,
			'InternalName': path.basename(filePath),
			'LegalCopyright': '',
			'OriginalFilename': path.basename(filePath),
			'ProductName': productName,
			'ProductVersion': version,
		}
	});
}

export function isPrebrandedWin32Dependency(filePath: string): boolean {
	const normalized = '/' + filePath.replaceAll(path.win32.sep, '/');
	return normalized.includes('/resources/app/node_modules.asar.unpacked/') || normalized.includes('/resources/app/node_modules/');
}

export function brandWin32Dependencies(version: string, productName: string): NodeJS.ReadWriteStream {
	return es.map((file: VinylFile, callback) => {
		const basename = path.basename(file.path);
		if (!basename.endsWith('.node') && basename !== 'rg.exe' && basename !== 'tgrep.exe' && !/explorer_command.*\.dll$/.test(basename)) {
			callback(undefined, file);
			return;
		}
		if (!Buffer.isBuffer(file.contents)) {
			callback(new Error(`Win32 dependency branding requires buffered contents: ${file.path}`));
			return;
		}
		const contents = file.contents;
		void (async () => {
			const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'octocode-brand-native-'));
			try {
				const target = path.join(temporary, basename);
				await fs.promises.writeFile(target, contents);
				await brandWin32DependencyFile(target, version, productName);
				file.contents = await fs.promises.readFile(target);
				if (file.stat) { file.stat.size = file.contents.length; }
				return file;
			} finally {
				await fs.promises.rm(temporary, { recursive: true, force: true });
			}
		})().then(result => callback(undefined, result), callback);
	});
}
