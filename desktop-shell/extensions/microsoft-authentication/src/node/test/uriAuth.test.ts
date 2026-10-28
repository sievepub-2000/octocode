/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import type { AuthenticationResult, AuthorizationCodeRequest, AuthorizationUrlRequest, AuthorizeResponse, InteractiveRequest, PublicClientApplication } from '@azure/msal-node';
import type { ILoopbackClientAndOpener } from '../../common/loopbackClientAndOpener';
import { acquireTokenByUri } from '../uriAuth';

function fixture() {
	const authorization: AuthorizationUrlRequest[] = [];
	const codes: AuthorizationCodeRequest[] = [];
	const payloads: Array<Parameters<PublicClientApplication['acquireTokenByCode']>[1]> = [];
	const order: string[] = [];
	let response: Partial<AuthorizeResponse> = {};
	const result: AuthenticationResult = {
		authority: '', uniqueId: '', tenantId: '', scopes: [], account: null, idToken: '', idTokenClaims: {},
		accessToken: 'owned-result', fromCache: false, expiresOn: null, tokenType: 'Bearer', correlationId: ''
	};
	const pca: Pick<PublicClientApplication, 'getAuthCodeUrl' | 'acquireTokenByCode'> = {
		async getAuthCodeUrl(request) {
			order.push('url');
			authorization.push(request);
			return 'https://login.microsoftonline.com/owned-authorize';
		},
		async acquireTokenByCode(request, payload) {
			order.push('exchange');
			codes.push(request);
			payloads.push(payload);
			return result;
		}
	};
	const loopback: ILoopbackClientAndOpener = {
		getRedirectUri: () => 'https://vscode.dev/redirect',
		getAuthState: nonce => `vscode://owned/callback?authSession=${nonce}`,
		async listenForAuthCode() {
			order.push('listen');
			return { code: 'owned-code', state: authorization[0].state, ...response };
		},
		closeServer: () => { order.push('close'); },
		async openBrowser() { }
	};
	const request: InteractiveRequest = {
		authority: 'https://login.microsoftonline.com/common', scopes: ['owned-scope'], resource: 'https://owned.invalid/resource',
		async openBrowser() { order.push('open'); }
	};
	return { pca, loopback, request, authorization, codes, payloads, order, result, setResponse: (value: Partial<AuthorizeResponse>) => { response = value; } };
}

suite('URI Microsoft sign-in with MSAL 7', () => {
	test('binds the same resource, redirect, nonce and S256 verifier across authorization and exchange', async () => {
		const f = fixture();
		assert.strictEqual(await acquireTokenByUri(f.pca, f.request, f.loopback), f.result);
		assert.deepStrictEqual(f.order, ['url', 'listen', 'open', 'exchange', 'close']);
		const authorization = f.authorization[0];
		const token = f.codes[0];
		assert.strictEqual(authorization.resource, f.request.resource);
		assert.strictEqual(token.resource, f.request.resource);
		assert.strictEqual(token.redirectUri, 'https://vscode.dev/redirect');
		assert.strictEqual(authorization.responseMode, 'query');
		assert.strictEqual(authorization.codeChallengeMethod, 'S256');
		assert.strictEqual(createHash('sha256').update(token.codeVerifier!).digest('base64url'), authorization.codeChallenge);
		assert.strictEqual(token.nonce, authorization.nonce);
		assert.ok(token.nonce);
		assert.strictEqual(token.state, authorization.state);
		assert.ok(authorization.state?.startsWith('vscode://owned/callback?authSession='));
		assert.deepStrictEqual(f.payloads, [{ code: 'owned-code', state: authorization.state }]);
	});

	test('generates fresh state, nonce and PKCE on every attempt', async () => {
		const a = fixture();
		const b = fixture();
		await Promise.all([acquireTokenByUri(a.pca, a.request, a.loopback), acquireTokenByUri(b.pca, b.request, b.loopback)]);
		for (const key of ['state', 'nonce', 'codeChallenge'] as const) {
			assert.notStrictEqual(a.authorization[0][key], b.authorization[0][key]);
		}
	});

	test('does not forward untrusted callback routing, nonce or client metadata', async () => {
		const f = fixture();
		const untrusted = { code: 'owned-code', nonce: 'owned-attacker-nonce', cloud_instance_host_name: 'attacker.invalid', client_info: 'owned-attacker-client-info' };
		f.setResponse(untrusted);
		await acquireTokenByUri(f.pca, f.request, f.loopback);
		assert.strictEqual(f.codes[0].authority, f.request.authority);
		assert.notStrictEqual(f.codes[0].nonce, untrusted.nonce);
		assert.deepStrictEqual(f.payloads, [{ code: 'owned-code', state: f.authorization[0].state }]);
	});

	for (const state of [undefined, 'owned-attacker-state']) {
		test(`rejects ${state === undefined ? 'missing' : 'mismatching'} state before token exchange`, async () => {
			const f = fixture();
			f.setResponse({ state });
			await assert.rejects(acquireTokenByUri(f.pca, f.request, f.loopback), { errorCode: 'state_mismatch' });
			assert.strictEqual(f.codes.length, 0);
			assert.strictEqual(f.order.at(-1), 'close');
		});
	}

	test('does not exchange an error or a missing authorization code', async () => {
		for (const response of [{ code: undefined }, { error: 'access_denied', error_description: 'owned refusal' }]) {
			const f = fixture();
			f.setResponse(response);
			await assert.rejects(acquireTokenByUri(f.pca, f.request, f.loopback));
			assert.strictEqual(f.codes.length, 0);
			assert.strictEqual(f.order.at(-1), 'close');
		}
	});

	test('closes the URI listener if opening the browser fails', async () => {
		const f = fixture();
		f.request.openBrowser = async () => { throw new Error('owned browser failure'); };
		await assert.rejects(acquireTokenByUri(f.pca, f.request, f.loopback), /owned browser failure/);
		assert.strictEqual(f.codes.length, 0);
		assert.strictEqual(f.order.at(-1), 'close');
	});

	test('closes the callback on provider discovery failure without opening a browser', async () => {
		const f = fixture();
		f.pca.getAuthCodeUrl = async () => { throw new Error('owned discovery failure'); };
		await assert.rejects(acquireTokenByUri(f.pca, f.request, f.loopback), /owned discovery failure/);
		assert.deepStrictEqual(f.order, ['close']);
	});

	test('closing a pending URI callback cancels the exchange', async () => {
		const f = fixture();
		let cancel: ((error: Error) => void) | undefined;
		f.loopback.listenForAuthCode = () => new Promise((_resolve, reject) => { cancel = reject; });
		f.loopback.closeServer = () => {
			f.order.push('close');
			cancel?.(new Error('owned cancellation'));
			cancel = undefined;
		};
		const result = acquireTokenByUri(f.pca, f.request, f.loopback);
		const rejected = assert.rejects(result, /owned cancellation/);
		await new Promise(resolve => setImmediate(resolve));
		assert.ok(cancel);
		f.loopback.closeServer();
		await rejected;
		assert.strictEqual(f.codes.length, 0);
	});
});
