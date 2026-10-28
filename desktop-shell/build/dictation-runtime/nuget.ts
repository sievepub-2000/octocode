/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fetches the Foundry Local native dependency libraries (
 * onnxruntime + onnxruntime-genai) from NuGet for an EXPLICIT RID, so a single
 * build agent can assemble a tarball for any target regardless of its own
 * `process.platform`/`process.arch`.
 *
 * This is a deliberate re-implementation of the download/extract loop in
 * `foundry-local-sdk`'s `script/install-utils.cjs`, whose `runInstall` derives
 * the RID from the RUNNING host (`os.platform()`/`os.arch()`) at module load and
 * exposes no override. VS Code's ARM64 desktop builds run on x64 pools, so the
 * host-locked installer can never produce the `linux-arm64`/`win32-arm64`
 * tarballs; extracting `runtimes/<rid>/native/*` from the same `.nupkg` files
 * for an explicit RID is host-independent and fixes that.
 *
 * The standard artifacts selected by `package.ts` are verified against the
 * official NuGet catalog before native libraries and legal files are copied.
 */

import { createRequire } from 'module';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { gunzipSync } from 'zlib';
import { getSdkRoot } from './common.ts';

const SCRIPT = 'nuget.ts';

/**
 * `adm-zip`, resolved through `foundry-local-sdk`'s own dependency tree (it is a
 * dependency of the SDK), so we don't add a new build dependency just to unzip
 * `.nupkg` archives.
 */
function loadAdmZip(): any {
	const fromSdk = createRequire(path.join(getSdkRoot(), 'package.json'));
	return fromSdk('adm-zip');
}

/**
 * SDK 2's pinned standard artifacts are published on the public NuGet feed.
 * Keep the catalog and package on that authoritative feed for hash verification.
 */
const FEEDS: readonly string[] = [
	'https://api.nuget.org/v3/index.json',
];

/** The NuGet Runtime IDentifier for each supported runtime target. */
const RID_BY_TARGET: Readonly<Record<string, string>> = {
	'win32-x64': 'win-x64',
	'win32-arm64': 'win-arm64',
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
	'darwin-arm64': 'osx-arm64',
};

/** The shared-library file extension for a target's OS. */
function libExt(target: string): string {
	return target.startsWith('win32-') ? '.dll' : target.startsWith('darwin-') ? '.dylib' : '.so';
}

export interface INugetArtifact {
	readonly name: string;
	readonly version: string;
	/** Restrict extraction when a package also carries another artifact's libraries. */
	readonly includeNative?: readonly string[];
}

/**
 * Download each `artifact` `.nupkg` for `target`'s RID and extract its native
 * shared libraries into `binDir`. Throws if a package can't be fetched from any
 * feed; callers verify the resulting library set separately.
 */
export async function fetchCoreLibraries(target: string, artifacts: readonly INugetArtifact[], binDir: string): Promise<void> {
	const rid = RID_BY_TARGET[target];
	if (!rid) {
		throw new Error(`[${SCRIPT}] No NuGet RID mapping for target '${target}'.`);
	}
	const ext = libExt(target);
	const AdmZip = loadAdmZip();

	fs.mkdirSync(binDir, { recursive: true });
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-nuget-'));
	const serviceIndexCache = new Map<string, unknown>();
	try {
		console.log(`[${SCRIPT}] Fetching native libraries for RID ${rid} (target ${target})...`);
		for (const artifact of artifacts) {
			await installPackage(artifact, rid, ext, tempDir, binDir, AdmZip, serviceIndexCache);
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

async function installPackage(
	artifact: INugetArtifact,
	rid: string,
	ext: string,
	tempDir: string,
	binDir: string,
	AdmZip: any,
	serviceIndexCache: Map<string, unknown>,
): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < FEEDS.length; i++) {
		const feedUrl = FEEDS[i];
		const feedHost = new URL(feedUrl).host;
		try {
			const baseAddress = await getBaseAddress(feedUrl, serviceIndexCache);
			const nameLower = artifact.name.toLowerCase();
			const verLower = artifact.version.toLowerCase();
			const downloadUrl = `${baseAddress}${nameLower}/${verLower}/${nameLower}.${verLower}.nupkg`;
			const leaf = JSON.parse(await downloadToString(`https://api.nuget.org/v3/registration5-gz-semver2/${nameLower}/${verLower}.json`)) as { catalogEntry: string };
			const catalog = JSON.parse(await downloadToString(leaf.catalogEntry)) as { id: string; version: string; packageHashAlgorithm: string; packageHash: string; packageSize: number };
			if (catalog.id.toLowerCase() !== nameLower || catalog.version.toLowerCase() !== verLower || catalog.packageHashAlgorithm.toUpperCase() !== 'SHA512') {
				throw new Error(`Unexpected NuGet catalog identity or hash algorithm for ${artifact.name}.`);
			}

			const nupkgPath = path.join(tempDir, `${artifact.name}.${artifact.version}.nupkg`);
			console.log(`[${SCRIPT}]   Downloading ${artifact.name} ${artifact.version} from ${feedHost}...`);
			await retryDownload(async () => {
				await downloadToFile(downloadUrl, nupkgPath);
				await verifyNugetArchive(nupkgPath, catalog.packageHash, catalog.packageSize);
			});

			const zip = new AdmZip(nupkgPath);
			const entries = nativeEntriesForRid(zip, rid, ext).filter((entry: any) => !artifact.includeNative || artifact.includeNative.includes(entry.name));
			if (entries.length === 0) {
				throw new Error(`No native libraries for RID ${rid} in ${artifact.name}.`);
			}
			for (const entry of entries) {
				zip.extractEntryTo(entry, binDir, false, true);
				console.log(`[${SCRIPT}]     Extracted ${entry.name}`);
			}
			const licenseDir = path.join(binDir, 'licenses', `${nameLower}-${verLower}`);
			const legal = zip.getEntries().filter((entry: any) => !entry.isDirectory && /(?:license|notice|copying)/i.test(path.posix.basename(String(entry.entryName).replace(/\\/g, '/'))));
			if (!legal.length) {
				throw new Error(`No license or notice files in ${artifact.name}.`);
			}
			for (const entry of legal) {
				// Preserve subdirectories so equally named third-party licenses cannot overwrite one another.
				const relative = String(entry.entryName).replace(/\\/g, '/');
				const destination = path.resolve(licenseDir, relative);
				if (!destination.startsWith(path.resolve(licenseDir) + path.sep)) {
					throw new Error(`Invalid license path in ${artifact.name}.`);
				}
				fs.mkdirSync(path.dirname(destination), { recursive: true });
				fs.writeFileSync(destination, entry.getData());
			}
			return;
		} catch (err) {
			lastError = err;
			const reason = err instanceof Error ? err.message : String(err);
			if (i < FEEDS.length - 1) {
				console.warn(`[${SCRIPT}]   ${artifact.name} ${artifact.version}: download from ${feedHost} failed (${reason}); trying next feed...`);
			}
		}
	}
	const feeds = FEEDS.map(f => new URL(f).host).join(', ');
	throw new Error(`[${SCRIPT}] Failed to download ${artifact.name} ${artifact.version} from any feed (${feeds}): ${lastError instanceof Error ? lastError.message : lastError}`);
}

/**
 * The native shared-library entries in `zip` for `rid`: files ending in `ext`
 * that live under `runtimes/<rid>/native/` or directly under `runtimes/<rid>/`.
 */
function nativeEntriesForRid(zip: any, rid: string, ext: string): any[] {
	const nativePrefix = `runtimes/${rid}/native/`.toLowerCase();
	const runtimePrefix = `runtimes/${rid}/`.toLowerCase();
	return zip.getEntries().filter((e: any) => {
		const p = String(e.entryName).replace(/\\/g, '/').toLowerCase();
		if (!p.endsWith(ext.toLowerCase())) {
			return false;
		}
		if (p.startsWith(nativePrefix)) {
			return true;
		}
		if (p.startsWith(runtimePrefix)) {
			const rest = p.slice(runtimePrefix.length);
			return rest.length > 0 && !rest.includes('/');
		}
		return false;
	});
}

/** Resolve a NuGet feed's `PackageBaseAddress/3.0.0` service endpoint. */
async function getBaseAddress(feedUrl: string, cache: Map<string, unknown>): Promise<string> {
	if (!cache.has(feedUrl)) {
		cache.set(feedUrl, JSON.parse(await downloadToString(feedUrl)));
	}
	const index = cache.get(feedUrl) as { resources?: { '@type'?: string; '@id'?: string }[] };
	const res = (index.resources ?? []).find(r => typeof r['@type'] === 'string' && r['@type']!.startsWith('PackageBaseAddress/3.0.0'));
	if (!res?.['@id']) {
		throw new Error(`[${SCRIPT}] Could not find PackageBaseAddress/3.0.0 in NuGet feed ${feedUrl}.`);
	}
	return res['@id']!.endsWith('/') ? res['@id']! : `${res['@id']}/`;
}

/** GET `url` following redirects, resolving with the response body as a string. */
function downloadToString(url: string): Promise<string> {
	return retryDownload(() => followRedirects(url, async res => {
		const chunks: Buffer[] = [];
		for await (const chunk of res) {
			chunks.push(Buffer.from(chunk));
		}
		const bytes = Buffer.concat(chunks);
		return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
	}));
}

/** GET `url` following redirects, streaming the response body into `dest`. */
function downloadToFile(url: string, dest: string): Promise<void> {
	return followRedirects(url, res => pipeline(res, fs.createWriteStream(dest)));
}

/** Check the complete archive against the immutable official catalog before extraction. */
export async function verifyNugetArchive(file: string, sha512: string, size: number): Promise<void> {
	if (!Number.isSafeInteger(size) || size <= 0 || fs.statSync(file).size !== size) {
		throw new Error('NuGet archive size does not match the official catalog.');
	}
	const hash = createHash('sha512');
	for await (const chunk of fs.createReadStream(file)) {
		hash.update(chunk);
	}
	if (hash.digest('base64') !== sha512) {
		throw new Error('NuGet archive SHA512 does not match the official catalog.');
	}
}

async function retryDownload<T>(action: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await action();
		} catch (error) {
			if (attempt === 3) {
				throw error;
			}
			console.log(`[${SCRIPT}] Download attempt ${attempt} failed; retrying: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** Issue a GET, following up to 5 redirects, then hand the 200 response to `onOk`. */
function followRedirects<T>(url: string, onOk: (res: import('http').IncomingMessage) => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const request = (currentUrl: string, redirectsLeft: number): void => {
			const requestHandle = https.get(currentUrl, res => {
				res.setTimeout(60_000, () => res.destroy(new Error(`Download response stalled: ${currentUrl}`)));
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume();
					if (redirectsLeft <= 0) {
						reject(new Error(`Too many redirects downloading ${url}.`));
						return;
					}
					request(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
					return;
				}
				if (status !== 200) {
					res.resume();
					reject(new Error(`Download failed with status ${status}: ${currentUrl}`));
					return;
				}
				onOk(res).then(resolve, reject);
			}).on('error', reject);
			requestHandle.setTimeout(60_000, () => requestHandle.destroy(new Error(`Download stalled: ${currentUrl}`)));
		};
		request(url, 5);
	});
}
