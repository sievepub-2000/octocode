/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

/** A child target must not inherit Electron configuration from its npm parent. */
export function configureNodeGypEnvironment(env: NodeJS.ProcessEnv, config: Record<string, unknown>): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith('npm_package_config_node_gyp_')) {
			delete env[key];
		}
	}
	for (const [key, value] of Object.entries(config)) {
		env[`npm_package_config_${key}`] = String(value);
	}
}

function replaceKnownSource(source: string, original: string, replacement: string, label: string): string {
	const newline = source.includes('\r\n') ? '\r\n' : '\n';
	const before = original.replaceAll('\n', newline);
	const after = replacement.replaceAll('\n', newline);
	if (source.includes(after) && source.indexOf(after) === source.lastIndexOf(after)) {
		return source;
	}
	if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
		throw new Error(`${label} source changed; review the maintained compatibility patch`);
	}
	return source.replace(before, after);
}

/** Explicit .exe paths accept argv directly; batch launchers retain the upstream path. */
export function patchPythonFinderSource(source: string): string {
	return replaceKnownSource(source,
		'    if (this.win) {\n      // Arguments have to be manually quoted',
		'    if (this.win && !/\\.exe$/i.test(command)) {\n      // Arguments have to be manually quoted',
		'node-gyp Python finder');
}

/** Match the Windows SDK typedef's SAL contract without changing NTSTATUS's ABI. */
export function patchLibuvWindowsHeaderSource(source: string): string {
	return replaceKnownSource(source,
		'#ifndef _NTDEF_\n  typedef LONG NTSTATUS;\n  typedef NTSTATUS *PNTSTATUS;',
		'#ifndef _NTDEF_\n#if defined(_MSC_VER)\n  typedef _Return_type_success_(return >= 0) LONG NTSTATUS;\n#else\n  typedef LONG NTSTATUS;\n#endif\n  typedef NTSTATUS *PNTSTATUS;',
		'libuv NTSTATUS');
}

export function prepareNodeGypPython(packageRoot: string): void {
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
	if (manifest.name !== 'node-gyp' || !['11.2.0', '13.0.0', '13.1.0'].includes(manifest.version)) {
		throw new Error(`Unreviewed node-gyp package at ${packageRoot}`);
	}
	const filename = path.join(packageRoot, 'lib', 'find-python.js');
	const original = fs.readFileSync(filename, 'utf8');
	const patched = patchPythonFinderSource(original);
	if (patched !== original) {
		fs.writeFileSync(filename, patched);
	}
}

export function prepareLibuvWindowsHeader(headersPath: string): void {
	const filename = path.join(headersPath, 'uv', 'win.h');
	const original = fs.readFileSync(filename, 'utf8');
	const patched = patchLibuvWindowsHeaderSource(original);
	if (patched !== original) {
		fs.writeFileSync(filename, patched);
	}
}
