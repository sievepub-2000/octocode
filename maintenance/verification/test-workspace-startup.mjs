import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureOctoCodeWorkspace } from '../../desktop-shell/src/vs/code/node/octocodeWorkspace.ts';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'OctoCode startup with spaces '));
try {
	const appRoot = path.join(fixture, 'resources', 'app');
	const marker = path.join(fixture, 'workspace', 'Program');
	await ensureOctoCodeWorkspace(appRoot);
	assert.equal(await fs.readFile(marker, 'utf8'), '');
	await fs.writeFile(marker, 'preserve existing content');
	await ensureOctoCodeWorkspace(appRoot);
	assert.equal(await fs.readFile(marker, 'utf8'), 'preserve existing content');
	await fs.rm(marker);
	await ensureOctoCodeWorkspace(appRoot);
	assert.equal(await fs.readFile(marker, 'utf8'), '');
	assert.equal((await fs.readdir(fixture)).includes('Program'), false);
	console.log('Desktop startup workspace creation, missing-file repair, and content preservation: PASS');
} finally {
	await fs.rm(fixture, { recursive: true, force: true });
}
