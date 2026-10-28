/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createRequire } from 'node:module';
import { Agent as UndiciAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { X509Certificate, createHash } from 'node:crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
assert.equal(process.versions.electron, '43.8.3');
const baselineTls = tls.checkServerIdentity('127.1', { subject: { CN: '127.0.0.1' } });
if (!process.env.OCTO_TEST_UNPATCHED) await import('../out/bootstrap-node.js');
process.chdir(root);

test('TLS rejects all non-canonical IP spellings for both DNS SAN and common names', () => {
	assert.equal(baselineTls, undefined, 'the controlled baseline must reproduce the embedded Node vulnerability');
	for (const host of ['127.1', '0177.0.0.1', '0x7f.0.0.1', '2130706433', '１２７.0.0.1', '127。0.0.1']) {
		for (const cert of [{ subject: { CN: '127.0.0.1' } }, { subjectaltname: 'DNS:127.0.0.1', subject: {} }]) {
			assert.equal(tls.checkServerIdentity(host, cert)?.code, 'ERR_TLS_CERT_ALTNAME_INVALID', host);
		}
	}
	assert.equal(tls.checkServerIdentity('127.0.0.1', { subjectaltname: 'IP Address:127.0.0.1', subject: {} }), undefined);
	assert.equal(tls.checkServerIdentity('::1', { subjectaltname: 'IP Address:0:0:0:0:0:0:0:1', subject: {} }), undefined);
});

test('DNS rejects NUL before every callback/promise resolver and setLocalAddress binding', () => {
	const methods = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];
	for (const resolver of [dns, new dns.Resolver(), dns.promises, new dns.promises.Resolver()]) {
		for (const method of methods) {
			assert.throws(() => resolver[method]('example.invalid\0.trusted.invalid', () => {}), { code: 'ERR_INVALID_ARG_VALUE' }, method);
		}
	}
	for (const resolver of [new dns.Resolver(), new dns.promises.Resolver()]) {
		assert.throws(() => resolver.setLocalAddress('127.0.0.1\0.invalid'), { code: 'ERR_INVALID_ARG_VALUE' });
		assert.throws(() => resolver.setLocalAddress('127.0.0.1', '::1\0.invalid'), { code: 'ERR_INVALID_ARG_VALUE' });
		resolver.setLocalAddress('127.0.0.1', '::1');
	}
});

test('Chromium-linked Brotli rejects the upstream malformed-block-switch PoC', () => {
	assert.throws(() => zlib.brotliDecompressSync(Buffer.from('200010414141fcffff07002228f00b60f7f41f000000', 'hex')), {
		code: 'ERR__ERROR_FORMAT_BLOCK_SWITCH', errno: -17
	});
});

test('the shipped Electron native TLS verifier enforces its SPKI blocklist', { timeout: 5000 }, async () => {
	const require = createRequire(import.meta.url);
	const bridge = require('../work/verification/spki-test.node');
	const fixture = name => fs.readFileSync(new URL(`./fixtures/node-security/${name}`, import.meta.url));
	const cert = fixture('agent1-cert.pem');
	const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
	const hash = createHash('sha256').update(spki).digest();
	const server = https.createServer({ cert, key: fixture('agent1-key.pem') }, (_req, res) => res.end('verified'));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const options = { hostname: '127.0.0.1', servername: 'agent1', port: server.address().port, ca: fixture('ca1-cert.pem'), agent: false };
	try {
		assert.equal((await request(https, options)).body, 'verified');
		bridge.add(hash);
		await assert.rejects(request(https, options), { code: 'CERT_REVOKED' });
		bridge.clear();
		assert.equal((await request(https, options)).body, 'verified');
	} finally {
		bridge.clear();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});

function request(module, options, onEnd) {
	return new Promise((resolve, reject) => {
		const req = module.get(options, response => {
			const authorized = response.socket.authorized;
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => body += chunk);
			response.on('end', () => { onEnd?.(); resolve({ req, response, body, authorized }); });
		});
		req.on('error', reject);
		const timer = setTimeout(() => { req.destroy(); reject(new Error('Owned request exceeded three seconds')); }, 3000);
		req.on('close', () => clearTimeout(timer));
	});
}

const poison = 'HTTP/1.1 200 OK\r\nX-Poisoned: true\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n';

for (const queued of [false, true]) {
	test(`HTTP prevents poisoned socket reuse for ${queued ? 'queued maxSockets=1' : 'idle pool'} requests`, { timeout: 5000 }, async () => {
		const connections = new Set();
		let serverSocket;
		const server = http.createServer((req, res) => {
			connections.add(req.socket);
			serverSocket ??= req.socket;
			res.end(req.url);
		});
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
		try {
			const options = { hostname: '127.0.0.1', port: server.address().port, agent };
			const first = request(http, { ...options, path: '/first' }, () => {
				serverSocket.write(poison);
				const deadline = Date.now() + 20;
				while (Date.now() < deadline) { /* Give the OS data time to arrive without polling Node's data guard. */ }
			});
			const second = queued ? request(http, { ...options, path: '/second' }) : undefined;
			assert.equal((await first).body, '/first');
			const result = await (second ?? request(http, { ...options, path: '/second' }));
			assert.equal(result.body, '/second');
			assert.equal(result.response.headers['x-poisoned'], undefined);
			assert.equal(result.req.reusedSocket, false);
			assert.equal(connections.size, 2);
			assert.equal(agent.maxSockets, 1);
		} finally {
			agent.destroy();
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	});
}

for (const viaProxy of [false, true]) {
test(`${viaProxy ? 'CONNECT proxy' : 'HTTPS'} preserves pinned CA validation and bounded queued requests`, { timeout: 10000 }, async () => {
	// Public Node.js v24.22.1 test fixtures, covered by its MIT license.
	const fixture = name => fs.readFileSync(new URL(`./fixtures/node-security/${name}`, import.meta.url));
	const ca = fixture('ca1-cert.pem');
	const server = https.createServer({ cert: fixture('agent1-cert.pem'), key: fixture('agent1-key.pem') }, (req, res) => res.end(req.url));
	const proxy = http.createServer();
	const tunnels = new Set();
	proxy.on('connect', (req, socket, head) => {
		assert.equal(req.url, `127.0.0.1:${server.address().port}`);
		const upstream = net.connect(server.address().port, '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		tunnels.add(socket);
		socket.on('close', () => { tunnels.delete(socket); upstream.destroy(); });
		upstream.on('error', () => socket.destroy());
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
	const agents = [viaProxy ? new HttpsProxyAgent(`http://127.0.0.1:${proxy.address().port}`, { keepAlive: true, maxSockets: 1 }) : new https.Agent({ keepAlive: true, maxSockets: 1 })];
	try {
		for (const agent of agents) {
			const options = { hostname: '127.0.0.1', servername: 'agent1', port: server.address().port, ca, agent };
			const results = await Promise.all([request(https, { ...options, path: '/first' }), request(https, { ...options, path: '/second' })]);
			assert.deepEqual(results.map(result => result.body), ['/first', '/second']);
			assert(results.every(result => result.authorized));
		}
		if (viaProxy) {
			const require = createRequire(import.meta.url);
			const proxyRequire = createRequire(require.resolve('@vscode/proxy-agent'));
			const { ProxyAgent } = proxyRequire('undici');
			const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.address().port}`, requestTls: { ca, servername: 'agent1' } });
			try {
				const response = await fetch(`https://127.0.0.1:${server.address().port}/maintained-fetch`, { dispatcher });
				assert.equal(await response.text(), '/maintained-fetch');
			} finally {
				await dispatcher.close();
			}
		}
	} finally {
		for (const agent of agents) agent.destroy();
		for (const socket of tunnels) socket.destroy();
		server.closeAllConnections();
		await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => server.close(resolve))]);
	}
});
}

test('maintained model-style fetch streams retain their own connection pool', { timeout: 5000 }, async () => {
	const connections = new Set();
	const server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/event-stream');
		res.write('data: owned stream\n\n');
		res.end('data: [DONE]\n\n');
	});
	server.on('connection', socket => connections.add(socket));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const original = getGlobalDispatcher();
	const dispatcher = new UndiciAgent({ connections: 1 });
	let dispatcherClosed = false;
	setGlobalDispatcher(dispatcher);
	try {
		const start = performance.now();
		for (let index = 0; index < 20; index++) {
			const response = await fetch(`http://127.0.0.1:${server.address().port}/stream`);
			assert.equal(await response.text(), 'data: owned stream\n\ndata: [DONE]\n\n');
		}
		assert.equal(connections.size, 1);
		const streamingMs = performance.now() - start;
		await dispatcher.close();
		dispatcherClosed = true;
		connections.clear();
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
		try {
			const legacyStart = performance.now();
			for (let index = 0; index < 20; index++) {
				await request(http, { hostname: '127.0.0.1', port: server.address().port, agent });
			}
			assert.equal(connections.size, process.env.OCTO_TEST_UNPATCHED ? 1 : 20);
			console.log(JSON.stringify({ controlledLoopbackBenchmark: true, callsPerAPI: 20, fetchConnections: 1, fetchMs: streamingMs, legacyHttpConnections: connections.size, legacyHttpMs: performance.now() - legacyStart }));
		} finally {
			agent.destroy();
		}
	} finally {
		setGlobalDispatcher(original);
		if (!dispatcherClosed) await dispatcher.close();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
