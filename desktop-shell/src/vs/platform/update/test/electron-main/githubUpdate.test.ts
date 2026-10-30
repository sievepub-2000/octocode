/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'crypto';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { IRequestService } from '../../../request/common/request.js';
import { getGitHubReleaseFeed, gitHubReleaseUpdate, isGitHubAssetRedirect } from '../../common/githubUpdate.js';
import { requestGitHubAsset, requestGitHubUpdate, verifyGitHubReleaseManifest } from '../../electron-main/githubUpdate.js';
import { RELEASE_PUBLIC_KEY_SPKI_BASE64, RELEASE_PUBLIC_KEY_SHA256 } from '../../common/releaseTrust.js';

suite('Private GitHub Windows updates', () => {
	const feed = getGitHubReleaseFeed('https://api.github.com/repos/sievepub-2000/octocode/releases/latest')!;
	const digest = 'a'.repeat(64);
	const asset = { id: 11, name: 'OctoCodeSetup.exe', state: 'uploaded', size: 7, digest: `sha256:${digest}`, url: 'https://api.github.com/repos/sievepub-2000/octocode/releases/assets/11' };
	const release = { id: 10, tag_name: 'v2.0.0', draft: false, prerelease: false, assets: [asset] };
	const manifest = { schemaVersion: 1, product: 'OctoCode', repository: feed.repository, version: '2.0.0', tag: release.tag_name, assets: { 'windows-x64-system': { name: asset.name, sha256: digest, size: 7 } } };
	const context = (statusCode: number, contents = '', headers = {}): IRequestContext => ({ res: { statusCode, headers }, stream: bufferToStream(VSBuffer.fromString(contents)) });

	test('only official fixed API endpoints are recognized', () => {
		assert.ok(feed);
		for (const url of ['http://api.github.com/repos/a/b/releases/latest', `${feed.url}?access_token=secret`, `${feed.url}#secret`, feed.url.replace('api.github.com', 'api.github.com.evil.test'), feed.url.replace('https://', 'https://user:pass@')]) {
			assert.strictEqual(getGitHubReleaseFeed(url), undefined);
		}
	});

	test('real stable versions compare independently from VS Code API versions', () => {
		assert.deepStrictEqual(gitHubReleaseUpdate(feed, release, '1.132.4', 'win32-x64', manifest), { version: 'github-10-2.0.0', productVersion: '2.0.0', url: asset.url, sha256hash: digest, size: 7 });
		assert.strictEqual(gitHubReleaseUpdate(feed, release, '2.0.0', 'win32-x64'), null);
		assert.strictEqual(gitHubReleaseUpdate(feed, release, '2.1.0', 'win32-x64'), null);
		assert.strictEqual(gitHubReleaseUpdate(feed, { ...release, draft: true }, '1.0.0', 'win32-x64'), null);
		assert.strictEqual(gitHubReleaseUpdate(feed, { ...release, prerelease: true }, '1.0.0', 'win32-x64'), null);
	});

	test('two-part stable release metadata normalizes and is current at 2.0.0', async () => {
		const metadata = { ...release, tag_name: 'v2.0' };
		const service = { request: async () => context(200, JSON.stringify(metadata)) } as unknown as IRequestService;
		assert.throws(() => gitHubReleaseUpdate(feed, metadata, '1.132.4', 'win32-x64'));
		assert.strictEqual(gitHubReleaseUpdate(feed, metadata, '1.132.4', 'win32-x64', { ...manifest, tag: 'v2.0' })?.productVersion, '2.0.0');
		assert.strictEqual(await requestGitHubUpdate(service, feed, 'fixture-token', '2.0.0', 'win32-x64', CancellationToken.None), null);
		assert.strictEqual(gitHubReleaseUpdate(feed, { ...metadata, tag_name: '2.0' }, '1.0.0', 'win32-x64', { ...manifest, tag: '2.0' })?.productVersion, '2.0.0');
	});

	test('short tags reject leading zeros, malformed tags and prereleases', () => {
		for (const tag_name of ['v02.0', 'v2.00', '02.0', 'v2.0-beta.1', 'v2.0.0-rc.1', 'v2.0.0-0', 'v2.0.0-01', 'v2', 'v2.0.0.0', 'v2.0suffix', ' v2.0', 'v2.0\n', 'v2.0.0\n']) {
			assert.throws(() => gitHubReleaseUpdate(feed, { ...release, tag_name }, '1.0.0', 'win32-x64'), /stable product version/);
		}
	});

	test('missing, ambiguous, digest-mismatched, external and wrong-platform assets fail', () => {
		for (const assets of [[], [asset, { ...asset, id: 12 }], [{ ...asset, digest: 'sha256:' + 'b'.repeat(64) }], [{ ...asset, size: 8 }], [{ ...asset, url: 'https://evil.test/setup.exe' }], [{ ...asset, state: 'new' }]]) {
			assert.throws(() => gitHubReleaseUpdate(feed, { ...release, assets }, '1.0.0', 'win32-x64', manifest));
		}
		assert.strictEqual(gitHubReleaseUpdate(feed, { ...release, assets: [{ ...asset, digest: undefined }] }, '1.0.0', 'win32-x64', manifest)?.sha256hash, digest);
		assert.throws(() => gitHubReleaseUpdate(feed, release, '1.0.0', 'win32-arm64'));
		assert.throws(() => gitHubReleaseUpdate(feed, release, '1.0.0', 'win32-x64-archive'));
		assert.throws(() => gitHubReleaseUpdate(feed, release, '1.0.0', 'win32-x64-user'));
	});

	test('signed manifest must bind schema, product, repository, tag and version', () => {
		for (const changed of [{ schemaVersion: 2 }, { product: 'Other' }, { repository: 'other/repo' }, { tag: 'v2.0' }, { version: '2.1.0' }, { assets: {} }]) {
			assert.throws(() => gitHubReleaseUpdate(feed, release, '1.0.0', 'win32-x64', { ...manifest, ...changed }));
		}
	});

	test('compiled public key matches its pin and rejects test-key signatures', () => {
		const der = Buffer.from(RELEASE_PUBLIC_KEY_SPKI_BASE64, 'base64');
		assert.strictEqual(createHash('sha256').update(der).digest('hex'), RELEASE_PUBLIC_KEY_SHA256);
		assert.strictEqual(createPublicKey({ key: der, type: 'spki', format: 'der' }).asymmetricKeyType, 'ed25519');
		const { privateKey } = generateKeyPairSync('ed25519');
		const raw = Buffer.from(JSON.stringify(manifest));
		assert.throws(() => verifyGitHubReleaseManifest(raw, sign(null, raw, privateKey)), /verification failed/);
	});

	test('official unsigned releases fail closed before installer download', async () => {
		let requests = 0;
		const service = { request: async () => { requests++; return context(200, JSON.stringify(release)); } } as unknown as IRequestService;
		await assert.rejects(requestGitHubUpdate(service, feed, 'fixture-token', '1.0.0', 'win32-x64', CancellationToken.None), /signed manifest/);
		assert.strictEqual(requests, 1);
	});

	test('redirect allowlist rejects credentials, insecure protocols and unrelated hosts', () => {
		assert.ok(isGitHubAssetRedirect('https://release-assets.githubusercontent.com/asset?signature=opaque'));
		for (const url of ['http://release-assets.githubusercontent.com/asset', 'https://release-assets.githubusercontent.com.evil.test/asset', 'https://user:secret@objects.githubusercontent.com/asset', 'https://objects.githubusercontent.com:8443/asset', 'file:///asset']) {
			assert.strictEqual(isGitHubAssetRedirect(url), false);
		}
	});

	test('private API credentials never follow the CDN redirect', async () => {
		const requests: IRequestOptions[] = [];
		const service = { request: async (options: IRequestOptions) => {
			requests.push(options);
			return requests.length === 1 ? context(302, '', { location: 'https://release-assets.githubusercontent.com/file?signature=opaque' }) : context(200, 'package');
		} } as unknown as IRequestService;
		await requestGitHubAsset(service, feed, asset.url, 'fixture-token', CancellationToken.None);
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(requests[0].headers?.Authorization, 'Bearer fixture-token');
		assert.strictEqual(requests[1].headers, undefined);
		assert.ok(requests.every(request => request.followRedirects === 0 && request.sensitive));
	});

	test('unapproved redirects stop before issuing a second request', async () => {
		let calls = 0;
		const service = { request: async () => { calls++; return context(302, '', { location: 'https://evil.test/steal' }); } } as unknown as IRequestService;
		await assert.rejects(requestGitHubAsset(service, feed, asset.url, 'fixture-token', CancellationToken.None), /approved HTTPS/);
		assert.strictEqual(calls, 1);
	});

	test('public updates work without authentication and never forward headers to CDN', async () => {
		const requests: IRequestOptions[] = [];
		const service = { request: async (options: IRequestOptions) => {
			requests.push(options);
			return requests.length === 1 ? context(200, JSON.stringify(release)) : context(200, 'package');
		} } as unknown as IRequestService;
		assert.strictEqual(await requestGitHubUpdate(service, feed, undefined, '2.0.0', 'win32-x64', CancellationToken.None), null);
		await requestGitHubAsset(service, feed, asset.url, undefined, CancellationToken.None);
		assert.strictEqual(requests.length, 2);
		assert.ok(requests.every(request => request.headers?.Authorization === undefined));
	});

	test('invalid authentication and foreign API asset URLs fail before networking', async () => {
		const service = { request: async () => { throw new Error('network must not run'); } } as unknown as IRequestService;
		await assert.rejects(requestGitHubAsset(service, feed, 'https://api.github.com/repos/other/repo/releases/assets/11', 'fixture-token', CancellationToken.None), /Invalid private/);
		await assert.rejects(requestGitHubAsset(service, feed, asset.url, 'bad\r\nheader', CancellationToken.None), /Sign in to GitHub/);
	});

	test('private access errors are actionable and cancellations remain cancellations', async () => {
		for (const status of [401, 403, 404]) {
			const service = { request: async () => context(status) } as unknown as IRequestService;
			await assert.rejects(requestGitHubUpdate(service, feed, 'fixture-token', '1.0.0', 'win32-x64', CancellationToken.None), /Sign in to GitHub for Updates/);
		}
		const cancelled = { request: async () => { throw new CancellationError(); } } as unknown as IRequestService;
		await assert.rejects(requestGitHubAsset(cancelled, feed, asset.url, 'fixture-token', CancellationToken.None), error => error instanceof CancellationError);
	});
});
