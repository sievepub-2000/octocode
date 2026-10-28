/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { gt, parse } from '../../../base/common/semver/semver.js';
import { IUpdate } from './update.js';

export interface GitHubReleaseFeed {
	readonly url: string;
	readonly repository: string;
}

export class GitHubUpdateError extends Error { }

export function getGitHubReleaseFeed(value: string | undefined): GitHubReleaseFeed | undefined {
	if (!value) {
		return undefined;
	}
	const match = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)\/releases\/latest$/.exec(value);
	return match ? { url: value, repository: match[1] } : undefined;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new GitHubUpdateError('Invalid GitHub release metadata');
	}
	return value as Record<string, unknown>;
}

export function gitHubReleaseVersion(value: unknown): string | null {
	const release = object(value);
	if (release.draft === true || release.prerelease === true) {
		return null;
	}
	const tag = typeof release.tag_name === 'string' && release.tag_name === release.tag_name.trim() ? release.tag_name : undefined;
	const version = tag ? parse(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ? `${tag}.0` : tag) : null;
	if (!version || version.prerelease.length || typeof release.id !== 'number' || !Number.isSafeInteger(release.id) || release.id <= 0) {
		throw new GitHubUpdateError('GitHub release requires a stable product version and release identity');
	}
	return version.version;
}

// The caller must verify the detached signature before supplying the manifest.
export function gitHubReleaseUpdate(feed: GitHubReleaseFeed, value: unknown, currentVersion: string, platform: string, verifiedManifest?: unknown): IUpdate | null {
	const release = object(value);
	const version = gitHubReleaseVersion(release);
	if (!parse(currentVersion)) {
		throw new GitHubUpdateError('Invalid current product version');
	}
	if (!version || !gt(version, currentVersion)) {
		return null;
	}
	if (platform !== 'win32-x64' && platform !== 'win32-x64-user') {
		throw new GitHubUpdateError('This GitHub channel requires an installed Windows x64 product');
	}
	const manifest = object(verifiedManifest);
	if (manifest.schemaVersion !== 1 || manifest.product !== 'OctoCode' || manifest.repository !== feed.repository || manifest.tag !== release.tag_name || manifest.version !== version) {
		throw new GitHubUpdateError('Signed release manifest does not match this repository and release');
	}
	const signedAsset = object(object(manifest.assets)[platform.endsWith('-user') ? 'windows-x64-user' : 'windows-x64-system']);
	const name = platform.endsWith('-user') ? 'OctoCodeUserSetup.exe' : 'OctoCodeSetup.exe';
	if (signedAsset.name !== name || typeof signedAsset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(signedAsset.sha256)
		|| typeof signedAsset.size !== 'number' || !Number.isSafeInteger(signedAsset.size) || signedAsset.size <= 0) {
		throw new GitHubUpdateError('Signed release installer metadata is invalid');
	}
	if (!Array.isArray(release.assets)) {
		throw new GitHubUpdateError('GitHub release has no installer assets');
	}
	const assets = release.assets.map(object).filter(asset => asset.name === name);
	if (assets.length !== 1) {
		throw new GitHubUpdateError('GitHub release must contain exactly one matching Windows installer');
	}
	const asset = assets[0];
	const digest = typeof asset.digest === 'string' ? /^sha256:([a-fA-F0-9]{64})$/.exec(asset.digest) : null;
	if (asset.state !== 'uploaded' || typeof asset.id !== 'number' || !Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.size !== signedAsset.size
		|| (asset.digest !== undefined && asset.digest !== null && (!digest || digest[1].toLowerCase() !== signedAsset.sha256))
		|| asset.url !== `https://api.github.com/repos/${feed.repository}/releases/assets/${asset.id}`) {
		throw new GitHubUpdateError('GitHub installer does not match the signed asset identity, size and digest');
	}
	return { version: `github-${release.id}-${version}`, productVersion: version, url: asset.url as string, sha256hash: signedAsset.sha256, size: signedAsset.size };
}

export function isGitHubAssetUrl(feed: GitHubReleaseFeed, value: string): boolean {
	const prefix = `https://api.github.com/repos/${feed.repository}/releases/assets/`;
	return value.startsWith(prefix) && /^[1-9]\d*$/.test(value.slice(prefix.length));
}

export function isGitHubAssetRedirect(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
			&& ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
	} catch {
		return false;
	}
}
