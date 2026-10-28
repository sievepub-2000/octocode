/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import * as undici from 'undici';
import { EventSourceStream } from '../node_modules/undici/lib/web/eventsource/eventsource-stream.js';
import { z } from 'zod';
import { NetworkConfigSchema } from '@vscode/sandbox-runtime/dist/sandbox/sandbox-config.js';

test('Zod rejects oversized collections before validating attacker-controlled elements', async () => {
	let parsed = 0;
	const element = z.preprocess(value => { parsed++; return value; }, z.string());
	const values = Array.from({ length: 100_000 }, (_, index) => index);
	for (const [schema, input] of [
		[z.array(element).max(2), values],
		[z.array(element).length(2), values],
		[z.set(element).max(2), new Set(values)],
		[z.map(element, element).max(2), new Map(values.map(value => [value, value]))]
	]) {
		for (const result of [schema.safeParse(input), await schema.safeParseAsync(input)]) {
			assert.equal(result.success, false);
			assert.equal(result.error.issues.length, 1);
			assert.equal(result.error.issues[0].code, 'too_big');
		}
	}
	assert.equal(parsed, 0);
});

test('sandbox domain validation retains its security boundary after the Zod upgrade', () => {
	assert.equal(NetworkConfigSchema.safeParse({ allowedDomains: ['example.com'], deniedDomains: [] }).success, true);
	assert.equal(NetworkConfigSchema.safeParse({ allowedDomains: ['*'], deniedDomains: [] }).success, false);
});

test('EventSource bounds tiny fields and buffered chunks independently of the byte limit', async () => {
	const parser = new EventSourceStream({ maxEventSize: 1_000_000_000 });
	const complete = finished(parser, { readable: false });
	parser.end('data:\n'.repeat(131_073));
	await assert.rejects(complete, /EventSource message size exceeded/);
});

test('Node bootstrap uses maintained HTTP globals and rejects hostile response integrity/encoding', async () => {
	const cwd = process.cwd();
	try {
		await import('../src/bootstrap-node.ts');
	} finally {
		process.chdir(cwd);
	}
	for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'EventSource', 'WebSocket']) {
		assert.equal(globalThis[name], undici[name], name);
	}
	const server = http.createServer((request, response) => {
		if (request.url === '/encoding') {
			response.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip', 'content-length': '10' });
			response.flushHeaders();
			response.end();
		} else {
			response.end('attacker-controlled body');
		}
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const url = `http://127.0.0.1:${server.address().port}`;
		const pinned = createHash('sha256').update('pinned body').digest('base64');
		for (const algorithm of ['sha256', 'SHA256', 'Sha256']) {
			await assert.rejects(fetch(url, { integrity: `${algorithm}-${pinned}` }), /fetch failed/);
		}
		await assert.rejects(fetch(`${url}/encoding`), /fetch failed/);
		await new Promise(resolve => setTimeout(resolve, 50));
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});
