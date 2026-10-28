/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createPublicKey, verify } from 'crypto';
import { streamToBuffer, VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { IRequestContext } from '../../../base/parts/request/common/request.js';
import { asJson, IRequestService, readHeader } from '../../request/common/request.js';
import { GitHubReleaseFeed, GitHubUpdateError, gitHubReleaseUpdate, gitHubReleaseVersion, isGitHubAssetRedirect, isGitHubAssetUrl } from '../common/githubUpdate.js';
import { RELEASE_PUBLIC_KEY_SPKI_BASE64, RELEASE_PUBLIC_KEY_SHA256 } from '../common/releaseTrust.js';
import { gt } from '../../../base/common/semver/semver.js';
import { IUpdate } from '../common/update.js';

export function gitHubTokenHeaders(token: string | undefined): Record<string, string> {
	if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
		throw new GitHubUpdateError('Sign in to GitHub for Updates with an account that can read the private release repository.');
	}
	return { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OctoCode-Updater' };
}

function checkStatus(context: IRequestContext): void {
	const status = context.res.statusCode;
	if (status === 401 || status === 403 || status === 404) {
		throw new GitHubUpdateError(`GitHub release access failed (HTTP ${status}). Run “Sign in to GitHub for Updates” and use an account with repository access.`);
	}
	if (status !== 200) {
		throw new GitHubUpdateError(`GitHub update request failed (HTTP ${status ?? 'unknown'}).`);
	}
}

export async function requestGitHubUpdate(service: IRequestService, feed: GitHubReleaseFeed, accessToken: string | undefined, currentVersion: string, platform: string, token: CancellationToken): Promise<IUpdate | null> {
	const headers = { ...gitHubTokenHeaders(accessToken), Accept: 'application/vnd.github+json' };
	const context = await service.request({ url: feed.url, headers, followRedirects: 0, sensitive: true, timeout: 30_000, callSite: 'updateService.github.release' }, token);
	checkStatus(context);
	const release = await asJson<Record<string, unknown>>(context);
	if (!release) {
		throw new GitHubUpdateError('GitHub returned no release metadata');
	}
	const version = gitHubReleaseVersion(release);
	if (!version || !gt(version, currentVersion)) {
		return null;
	}
	const manifestAsset = releaseManifestAsset(feed, release, 'octocode-release.json', 1_048_576);
	const signatureAsset = releaseManifestAsset(feed, release, 'octocode-release.json.sig', 64);
	if (signatureAsset.size !== 64) {
		throw new GitHubUpdateError('Release manifest signature must contain exactly 64 bytes');
	}
	const raw = await readReleaseAsset(service, feed, manifestAsset.url, accessToken, token, 1_048_576);
	const signature = await readReleaseAsset(service, feed, signatureAsset.url, accessToken, token, 64);
	if (raw.byteLength !== manifestAsset.size || signature.byteLength !== signatureAsset.size) {
		throw new GitHubUpdateError('Release manifest asset size does not match GitHub metadata');
	}
	const update = gitHubReleaseUpdate(feed, release, currentVersion, platform, verifyGitHubReleaseManifest(raw.buffer, signature.buffer));
	return update && { ...update, releaseProof: { manifest: Buffer.from(raw.buffer).toString('base64'), signature: Buffer.from(signature.buffer).toString('base64') } };
}

function releaseManifestAsset(feed: GitHubReleaseFeed, release: Record<string, unknown>, name: string, maximum: number): { url: string; size: number } {
	const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset && typeof asset === 'object' && (asset as Record<string, unknown>).name === name) as Record<string, unknown>[] : [];
	const asset = assets[0];
	if (assets.length !== 1 || asset.state !== 'uploaded' || typeof asset.id !== 'number' || !Number.isSafeInteger(asset.id) || asset.id <= 0
		|| typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximum
		|| asset.url !== `https://api.github.com/repos/${feed.repository}/releases/assets/${asset.id}`) {
		throw new GitHubUpdateError('Release requires unique official signed manifest assets within size limits');
	}
	return { url: asset.url as string, size: asset.size };
}

async function readReleaseAsset(service: IRequestService, feed: GitHubReleaseFeed, url: string, accessToken: string | undefined, token: CancellationToken, maximum: number): Promise<VSBuffer> {
	const context = await requestGitHubAsset(service, feed, url, accessToken, token);
	return new Promise((resolve, reject) => {
		const chunks: VSBuffer[] = [];
		let length = 0;
		context.stream.on('error', reject);
		context.stream.on('end', () => resolve(VSBuffer.concat(chunks)));
		context.stream.on('data', chunk => {
			length += chunk.byteLength;
			if (length > maximum) {
				context.stream.destroy();
				reject(new GitHubUpdateError('Release manifest asset exceeds its size limit'));
				return;
			}
			chunks.push(chunk);
		});
	});
}

export function verifyGitHubReleaseManifest(raw: Uint8Array, signature: Uint8Array): unknown {
	try {
		const der = Buffer.from(RELEASE_PUBLIC_KEY_SPKI_BASE64, 'base64');
		if (!raw.byteLength || raw.byteLength > 1_048_576 || signature.byteLength !== 64 || der.toString('base64') !== RELEASE_PUBLIC_KEY_SPKI_BASE64
			|| !/^[a-f0-9]{64}$/.test(RELEASE_PUBLIC_KEY_SHA256) || createHash('sha256').update(der).digest('hex') !== RELEASE_PUBLIC_KEY_SHA256) {
			throw new Error();
		}
		const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
		if (key.asymmetricKeyType !== 'ed25519' || !verify(null, raw, key, signature)) {
			throw new Error();
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
	} catch {
		throw new GitHubUpdateError('Release manifest signature or pinned public key verification failed');
	}
}

export function verifyGitHubUpdateProof(update: IUpdate, feed: GitHubReleaseFeed, platform: string): void {
	const proof = update.releaseProof;
	if (!proof || typeof proof.manifest !== 'string' || proof.manifest.length > 1_398_104 || typeof proof.signature !== 'string' || proof.signature.length !== 88) {
		throw new GitHubUpdateError('Cached update requires its signed release manifest');
	}
	const raw = Buffer.from(proof.manifest, 'base64');
	const signature = Buffer.from(proof.signature, 'base64');
	if (raw.toString('base64') !== proof.manifest || signature.toString('base64') !== proof.signature) {
		throw new GitHubUpdateError('Invalid cached release signature encoding');
	}
	const manifest = verifyGitHubReleaseManifest(raw, signature) as Record<string, unknown>;
	const version = /^github-([1-9]\d*)-(.+)$/.exec(update.version);
	const assetId = update.url && isGitHubAssetUrl(feed, update.url) ? Number(update.url.slice(update.url.lastIndexOf('/') + 1)) : NaN;
	const rebound = version && gitHubReleaseUpdate(feed, { id: Number(version[1]), tag_name: manifest.tag, assets: [{ id: assetId, name: platform.endsWith('-user') ? 'OctoCodeUserSetup.exe' : 'OctoCodeSetup.exe', state: 'uploaded', url: update.url, size: update.size }] }, '0.0.0', platform, manifest);
	if (!rebound || rebound.version !== update.version || rebound.productVersion !== update.productVersion || rebound.sha256hash !== update.sha256hash || rebound.size !== update.size) {
		throw new GitHubUpdateError('Cached update metadata does not match its signed release manifest');
	}
}

export async function requestGitHubAsset(service: IRequestService, feed: GitHubReleaseFeed, assetUrl: string, accessToken: string | undefined, token: CancellationToken): Promise<IRequestContext> {
	if (!isGitHubAssetUrl(feed, assetUrl)) {
		throw new GitHubUpdateError('Invalid private GitHub installer URL');
	}
	let url = assetUrl;
	for (let hop = 0; hop < 4; hop++) {
		// Authorization is sent only to the exact repository asset API endpoint.
		// Signed GitHub CDN URLs are credentials themselves and must not be logged.
		const headers = hop === 0 ? { ...gitHubTokenHeaders(accessToken), Accept: 'application/octet-stream' } : undefined;
		let context: IRequestContext;
		try {
			context = await service.request({ url, headers, followRedirects: 0, sensitive: true, timeout: 120_000, callSite: 'updateService.github.asset' }, token);
		} catch (error) {
			if (isCancellationError(error)) {
				throw error;
			}
			throw new GitHubUpdateError('GitHub installer download failed. Check your connection and try again.');
		}
		if (context.res.statusCode === 301 || context.res.statusCode === 302 || context.res.statusCode === 303 || context.res.statusCode === 307 || context.res.statusCode === 308) {
			const location = readHeader(context.res.headers, 'location');
			await streamToBuffer(context.stream);
			if (!location || !isGitHubAssetRedirect(location)) {
				throw new GitHubUpdateError('GitHub installer redirected outside its approved HTTPS asset hosts');
			}
			url = location;
			continue;
		}
		checkStatus(context);
		return context;
	}
	throw new GitHubUpdateError('Too many GitHub installer redirects');
}
