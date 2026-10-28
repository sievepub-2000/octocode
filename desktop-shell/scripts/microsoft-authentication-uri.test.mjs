/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';
import { URI } from '../out/vs/base/common/uri.js';
import { CancellationError } from '../out/vs/base/common/errors.js';

const require = createRequire(import.meta.url);
const opened = [];
const originalLoad = Module._load;
let UriHandlerLoopbackClient;
let acquireTokenByUri;
try {
	// The actual callback client uses the editor's URI implementation; only its host API is supplied here.
	Module._load = function (specifier, ...args) {
		if (specifier === 'vscode') return { Uri: URI, CancellationError, env: { openExternal: async uri => { opened.push(uri); return true; } } };
		return Reflect.apply(originalLoad, this, [specifier, ...args]);
	};
	({ UriHandlerLoopbackClient } = require('../extensions/microsoft-authentication/out/common/loopbackClientAndOpener.js'));
	({ acquireTokenByUri } = require('../extensions/microsoft-authentication/out/node/uriAuth.js'));
} finally {
	Module._load = originalLoad;
}

function fixture() {
	opened.length = 0;
	const listeners = new Set();
	const handler = { event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } };
	const callback = URI.parse('vscode://owned-auth/callback?windowId=owned-window');
	const client = new UriHandlerLoopbackClient(handler, 'https://vscode.dev/redirect', callback, { debug() { } });
	const request = { scopes: ['owned-scope'], openBrowser: url => client.openBrowser(url) };
	return { client, request, listeners, fire: uri => { for (const listener of [...listeners]) listener(uri); } };
}

test('the real URI client preserves callback parameters and sends exactly one bound state', async () => {
	const f = fixture();
	const state = f.client.getAuthState('owned-state-nonce');
	assert.equal(new URL(state).searchParams.get('windowId'), 'owned-window');
	assert.equal(new URL(state).searchParams.get('authSession'), 'owned-state-nonce');
	const authorizationUrl = `https://login.microsoftonline.com/owned?state=${encodeURIComponent(state)}`;
	await f.client.openBrowser(authorizationUrl);
	assert.equal(opened.length, 1);
	assert.deepEqual(opened[0], URI.parse(authorizationUrl));
	const pending = f.client.listenForAuthCode();
	const returned = new URL(state);
	returned.searchParams.set('code', 'owned-code');
	returned.searchParams.set('state', state);
	f.fire(URI.parse(returned.href));
	assert.deepEqual(await pending, { code: 'owned-code', state, error: undefined, error_description: undefined, error_uri: undefined });
	assert.equal(f.listeners.size, 0);
	f.client.closeServer();
});

test('cancel before provider discovery finishes cannot reopen a browser or callback listener', async () => {
	const f = fixture();
	let resolveUrl;
	let entered;
	let exchanges = 0;
	const started = new Promise(resolve => entered = resolve);
	const pca = {
		getAuthCodeUrl: () => { entered(); return new Promise(resolve => resolveUrl = resolve); },
		acquireTokenByCode: async () => { exchanges++; throw new Error('unexpected exchange'); }
	};
	const running = acquireTokenByUri(pca, f.request, f.client);
	const rejected = assert.rejects(running, error => error instanceof CancellationError);
	await started;
	f.client.closeServer();
	resolveUrl('https://login.microsoftonline.com/owned');
	await rejected;
	assert.equal(opened.length, 0);
	assert.equal(f.listeners.size, 0);
	assert.equal(exchanges, 0);
});

test('the actual callback rejects missing, changed, prefixed and duplicate states', async () => {
	for (const kind of ['missing', 'changed', 'suffix', 'duplicate', 'missing-nonce', 'changed-nonce', 'duplicate-nonce', 'unknown-prefix', 'unknown-suffix', 'encoded-separator']) {
		const f = fixture();
		const state = f.client.getAuthState('owned-state-nonce');
		const returned = new URL(state);
		returned.searchParams.set('code', 'owned-code');
		if (kind !== 'missing') returned.searchParams.set('state', kind === 'changed' ? state.replace('owned-state-nonce', 'other-nonce') : kind === 'suffix' ? `${state}other` : state);
		if (kind === 'duplicate') returned.searchParams.append('state', state);
		if (kind === 'missing-nonce') returned.searchParams.delete('authSession');
		if (kind === 'changed-nonce') returned.searchParams.set('authSession', 'other');
		if (kind === 'duplicate-nonce') returned.searchParams.append('authSession', 'owned-state-nonce');
		if (kind === 'unknown-prefix') returned.search = `injected=1&${returned.search.slice(1)}`;
		if (kind === 'unknown-suffix') returned.searchParams.append('injected', '1');
		if (kind === 'encoded-separator') returned.searchParams.set('code', 'owned&authSession=other');
		const pending = f.client.listenForAuthCode();
		f.fire(URI.parse(returned.href));
		assert.equal((await pending).state, undefined, kind);
		assert.equal(f.listeners.size, 0);
		f.client.closeServer();
	}
});

test('the real callback accepts reordered fields and preserves encoded plus and equals in a code', async () => {
	const f = fixture();
	const state = f.client.getAuthState('owned-state-nonce');
	const returned = new URL(state);
	returned.searchParams.set('code', 'owned+code=value');
	returned.searchParams.set('state', state);
	returned.searchParams.sort();
	const pending = f.client.listenForAuthCode();
	f.fire(URI.parse(returned.href));
	assert.deepEqual(await pending, { code: 'owned+code=value', state, error: undefined, error_description: undefined, error_uri: undefined });
	f.client.closeServer();
});

test('a real provider error remains bound to the same state and never exchanges a token', async () => {
	const f = fixture();
	let exchanges = 0;
	let authorization;
	const pca = {
		getAuthCodeUrl: async request => { authorization = request; return 'https://login.microsoftonline.com/owned'; },
		acquireTokenByCode: async () => { exchanges++; throw new Error('unexpected exchange'); }
	};
	f.request.openBrowser = async () => {
		const returned = new URL(authorization.state);
		returned.searchParams.set('state', authorization.state);
		returned.searchParams.set('error', 'access_denied');
		returned.searchParams.set('error_description', 'owned user cancellation');
		f.fire(URI.parse(returned.href));
	};
	await assert.rejects(acquireTokenByUri(pca, f.request, f.client), error => error.errorCode === 'access_denied');
	assert.equal(exchanges, 0);
	assert.equal(f.listeners.size, 0);
});

test('an already closed URI client rejects before discovery and cleans an active listener on cancellation', async () => {
	const f = fixture();
	let discoveries = 0;
	f.client.closeServer();
	await assert.rejects(acquireTokenByUri({ getAuthCodeUrl: async () => { discoveries++; return ''; }, acquireTokenByCode: async () => { throw new Error('unexpected exchange'); } }, f.request, f.client), error => error instanceof CancellationError);
	assert.equal(discoveries, 0);
	assert.equal(opened.length, 0);
	const active = fixture();
	const pending = active.client.listenForAuthCode();
	const rejected = assert.rejects(pending, error => error instanceof CancellationError);
	assert.equal(active.listeners.size, 1);
	active.client.closeServer();
	await rejected;
	assert.equal(active.listeners.size, 0);
	await assert.rejects(active.client.openBrowser('https://login.microsoftonline.com/owned'), error => error instanceof CancellationError);
	assert.equal(opened.length, 0);
});

test('the shipped MSAL confidential-client fix rejects instance-aware routing and sanitizes response metadata', async () => {
	const msalRequire = createRequire(new URL('../extensions/microsoft-authentication/package.json', import.meta.url));
	const { ConfidentialClientApplication } = msalRequire('@azure/msal-node');
	const config = { auth: { clientId: '00000000-0000-0000-0000-000000000001', clientSecret: 'owned-fixture-secret' } };
	assert.throws(() => new ConfidentialClientApplication({ auth: { ...config.auth, instanceAware: true } }), error => error.errorCode === 'unsupported_cca_instance_aware');
	const base = Object.getPrototypeOf(ConfidentialClientApplication.prototype);
	const original = base.acquireTokenByCode;
	const request = { scopes: ['owned-scope'], redirectUri: 'https://owned.invalid/callback', code: 'owned-request-code', nonce: 'owned-request-nonce' };
	let captured;
	try {
		base.acquireTokenByCode = async (input, response) => { captured = { input, response }; return {}; };
		await new ConfidentialClientApplication(config).acquireTokenByCode(request, { code: 'attacker-code', nonce: 'attacker-nonce', state: 'owned-state', cloud_instance_host_name: 'attacker.invalid', cloud_graph_host_name: 'attacker.invalid', msgraph_host: 'attacker.invalid' });
		assert.equal(captured.input, request);
		assert.deepEqual(captured.response, { code: request.code, nonce: request.nonce, state: 'owned-state' });
	} finally { base.acquireTokenByCode = original; }
});
