/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { ClientAssertionCredential } from '@azure/identity';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import { ConfidentialClientApplication, type ClientCredentialRequest } from '@azure/msal-node';
import uri from 'fast-uri';
import { fetch } from 'undici';
import { getAccessToken } from '../azure-pipelines/common/getPublishAuthTokens.ts';

test('build client assertion flow remains compatible with patched MSAL, including Azure Identity resolution', async context => {
	const require = createRequire(import.meta.url);
	for (const consumer of [require, createRequire(require.resolve('@azure/identity'))]) {
		const version: string = consumer('@azure/msal-node/package.json').version;
		const [major, minor] = version.split('.').map(Number);
		assert.ok(major > 7 || (major === 7 && minor >= 1));
	}
	const calls: ClientCredentialRequest[] = [];
	context.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential', async (request: ClientCredentialRequest) => {
		calls.push(request);
		return { accessToken: 'fixture-only', expiresOn: new Date(123000), refreshOn: new Date(100000) };
	});
	const credential = new ClientAssertionCredential('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', async () => 'fixture-only');
	assert.equal(typeof credential.getToken, 'function');
	assert.deepEqual(await getAccessToken('https://resource.example/', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'fixture-only'), {
		token: 'fixture-only', expiresOnTimestamp: 123000, refreshAfterTimestamp: 100000,
	});
	assert.deepEqual(calls.map(call => call.scopes), [['https://resource.example/.default']]);
});

test('fast-uri does not turn the upstream percent-encoded scheme PoC into an active scheme', () => {
	for (const encoded of ['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)']) {
		assert.equal(uri.parse(encoded).error, 'URI scheme is malformed.');
		assert.equal(uri.normalize(encoded), encoded);
		assert.throws(() => uri.resolve('https://example.com/', encoded), /URI scheme is malformed/);
	}
	assert.equal(uri.equal('%68ttp://example.com/', 'http://example.com/'), false);
	assert.equal(uri.equal('https://example.com/', 'HTTPS://EXAMPLE.COM/'), true);
});

test('Azure Identity executes its real assertion credential flow against a closed HTTP fixture', async () => {
	const tenant = '00000000-0000-0000-0000-000000000001';
	const authority = `https://login.microsoftonline.com/${tenant}`;
	const requests: string[] = [];
	const credential = new ClientAssertionCredential(tenant, '00000000-0000-0000-0000-000000000002', async () => 'fixture-assertion', {
		disableInstanceDiscovery: true,
		httpClient: { async sendRequest(request) {
			requests.push(request.url);
			const requestUrl = new URL(request.url);
			if (requestUrl.origin !== new URL(authority).origin || requestUrl.pathname !== `/${tenant}/oauth2/v2.0/token`) {
				throw new Error('Unexpected fixture HTTP request; no real network is allowed');
			}
			assert.equal(request.method, 'POST');
			assert.match(String(request.body), /client_assertion=fixture-assertion/);
			const body = { access_token: 'identity-fixture-only', token_type: 'Bearer', expires_in: 3600 };
			return { request, status: 200, headers: createHttpHeaders({ 'content-type': 'application/json' }), bodyAsText: JSON.stringify(body) };
		} },
	});
	assert.equal((await credential.getToken('https://resource.example/.default'))?.token, 'identity-fixture-only');
	assert.equal(requests.length, 1);
});

test('undici handles excessive content encodings and an early body close without an orphan stream error', { timeout: 5000 }, async () => {
	const server = createServer(socket => socket.once('data', () => socket.end(
		'HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n',
	)));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		await assert.rejects(fetch(`http://127.0.0.1:${address.port}/`), error => {
			assert.ok(error instanceof TypeError);
			assert.match(String(error.cause), /too many content-encodings/);
			return true;
		});
		await setTimeout(50);
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
