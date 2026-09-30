/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run with the repository's declared Node runtime:
// node --test extensions/html-language-features/server/test/typecheck.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const project = path.join(root, 'extensions/html-language-features/server/tsconfig.json');
const compiler = path.join(path.dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json')), 'bin/tsc');

test('HTML server retains LSP Range members in fresh and warm incremental typechecks', () => {
	const cacheDirectory = mkdtempSync(path.join(tmpdir(), 'octocode-html-typecheck-'));
	try {
		for (const phase of ['fresh', 'warm']) {
			const result = spawnSync(process.execPath, [compiler, '--project', project, '--pretty', 'false',
				'--incremental', '--noEmit', '--tsBuildInfoFile', path.join(cacheDirectory, 'html.tsbuildinfo')],
			{ cwd: root, encoding: 'utf8', timeout: 60_000 });
			assert.equal(result.error, undefined, `${phase}: ${result.error}`);
			assert.equal(result.status, 0, `${phase}: ${result.stdout}\n${result.stderr}`);
		}
	} finally {
		rmSync(cacheDirectory, { recursive: true, force: true });
	}
});
