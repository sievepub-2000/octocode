/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds one per-target tarball of the Foundry Local native runtime (the
 * prebuilt N-API addons + the Foundry Local / onnxruntime / onnxruntime-genai
 * shared libraries). Callable as both a Node library (`buildOne(...)`) and a thin
 * CLI (bottom of this file).
 *
 * The library form is what `produce.ts` calls during the per-platform
 * "Dictation runtime: build + upload" pipeline step; the CLI form is for local
 * one-off builds.
 *
 * The addon is copied from the pinned `foundry-local-sdk` package's `prebuilds/`
 * (which ships every target), and the core libraries are fetched from NuGet for
 * the requested target's RID via `fetchCoreLibraries` (NOT the SDK's host-locked
 * installer), so ANY build host can produce ANY target's tarball. This is what
 * lets VS Code's ARM64 desktop builds — which run on x64 pools — publish their
 * `linux-arm64`/`win32-arm64` runtimes.
 *
 * The produced tarball's internal layout mirrors the runtime cache layout so the
 * runtime extraction is a plain untar:
 *
 *   prebuilds/<target>/<addons and shared libraries>
 *   prebuilds/<target>/licenses/<upstream license and notice files>
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { getRuntimeVersion, getSdkRoot, parseFlags, SDK_PACKAGE_NAME, sha256OfFile, SUPPORTED_TARGETS } from './common.ts';
import { fetchCoreLibraries } from './nuget.ts';

const SCRIPT = 'package.ts';

export interface IBuildResult {
	readonly tgzPath: string;
	readonly sha256: string;
	readonly version: string;
	readonly sizeBytes: number;
}

export interface IBuildArgs {
	readonly target: string;
	readonly outDir: string;
}

/**
 * Build one runtime tarball for `args.target`. Copies the prebuilt addon from
 * the installed SDK, fetches the matching core libraries via the SDK's NuGet
 * installer, and tars both into a single gzipped tarball. Returns the produced
 * `.tgz` path and its sha256.
 */
export async function buildOne(args: IBuildArgs): Promise<IBuildResult> {
	if (!SUPPORTED_TARGETS.has(args.target)) {
		throw new Error(`[${SCRIPT}] Unknown target '${args.target}'. Supported: ${[...SUPPORTED_TARGETS].join(', ')}.`);
	}

	const version = getRuntimeVersion();
	const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-runtime-pkg-'));
	try {
		console.log(`[${SCRIPT}] Building ${SDK_PACKAGE_NAME}@${version} native runtime for ${args.target} in ${stagingDir}`);

		await stageAddon(stagingDir, args.target);
		await stageCoreLibraries(stagingDir, args.target);

		fs.mkdirSync(args.outDir, { recursive: true });
		const tgzPath = path.join(args.outDir, `${args.target}.tgz`);
		await buildTarball(stagingDir, tgzPath);

		const sha256 = await sha256OfFile(tgzPath);
		const sizeBytes = fs.statSync(tgzPath).size;

		console.log(`[${SCRIPT}] Wrote ${tgzPath} (${sizeBytes} bytes, sha256=${sha256})`);
		return { tgzPath, sha256, version, sizeBytes };
	} finally {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
}

/**
 * Copy the prebuilt N-API addon for `target` out of the installed
 * `foundry-local-sdk` package (`prebuilds/<target>/`)
 * into the staging tree.
 */
export async function stageAddon(stagingDir: string, target: string, sdkRoot = getSdkRoot()): Promise<void> {
	const source = path.join(sdkRoot, 'prebuilds', target);
	for (const name of ['foundry_local_node.node', 'foundry_local_preload.node']) {
		if (!fs.existsSync(path.join(source, name))) {
			throw new Error(`[${SCRIPT}] SDK 2 addon ${name} missing for ${target}.`);
		}
	}
	const destination = path.join(stagingDir, 'prebuilds', target);
	fs.cpSync(source, destination, { recursive: true, dereference: false });
	const licenseDir = path.join(destination, 'licenses', SDK_PACKAGE_NAME);
	fs.mkdirSync(licenseDir, { recursive: true });
	fs.copyFileSync(path.join(sdkRoot, 'LICENSE'), path.join(licenseDir, 'LICENSE'));
}

/**
 * Fetch the Foundry Local core libraries for `target` into the staging tree from
 * NuGet, for that target's explicit RID (see `fetchCoreLibraries`). Replicates
 * SDK 2's standard ORT and GenAI artifact selection. Host-independent —
 * `target` need not match the build host.
 */
async function stageCoreLibraries(stagingDir: string, target: string): Promise<void> {
	const deps = JSON.parse(fs.readFileSync(path.join(getSdkRoot(), 'deps_versions.json'), 'utf8')) as {
		onnxruntime: { version: string };
		'onnxruntime-genai': { version: string };
		'windows-ai-machinelearning': { version: string };
	};

	const artifacts = [
		{ name: 'Microsoft.ML.OnnxRuntime', version: deps.onnxruntime.version },
		{ name: 'Microsoft.ML.OnnxRuntimeGenAI.Foundry', version: deps['onnxruntime-genai'].version },
		...(target.startsWith('win32-') ? [{
			name: 'Microsoft.Windows.AI.MachineLearning',
			version: deps['windows-ai-machinelearning'].version,
			// Preserve the SDK's matching WinML legal files without replacing the
			// separately pinned ONNX Runtime with WinML's bundled ORT version.
			includeNative: ['Microsoft.Windows.AI.MachineLearning.dll'],
		}] : []),
	];

	const coreDir = path.join(stagingDir, 'prebuilds', target);
	await fetchCoreLibraries(target, artifacts, coreDir);
	if (!target.startsWith('win32-')) {
		const mac = target.startsWith('darwin-');
		const unversioned = path.join(coreDir, mac ? 'libonnxruntime.dylib' : 'libonnxruntime.so');
		const versioned = path.join(coreDir, mac ? `libonnxruntime.${deps.onnxruntime.version.split('.')[0]}.dylib` : 'libonnxruntime.so.1');
		if (fs.existsSync(unversioned) && !fs.existsSync(versioned)) {
			fs.renameSync(unversioned, versioned);
		}
		if (mac && !fs.existsSync(unversioned)) {
			fs.symlinkSync(path.basename(versioned), unversioned, 'file');
		}
	}

	for (const name of requiredCoreLibraryNames(target)) {
		if (!fs.existsSync(path.join(coreDir, name))) {
			throw new Error(`[${SCRIPT}] Core library '${name}' missing after install for ${target} — refusing to build an incomplete tarball.`);
		}
	}
}

/** The core library filenames required for `target`. Mirrors the runtime gate. */
function requiredCoreLibraryNames(target: string): string[] {
	const isWin = target.startsWith('win32-');
	const isMac = target.startsWith('darwin-');
	const ext = isWin ? '.dll' : isMac ? '.dylib' : '.so';
	const prefix = isWin ? '' : 'lib';
	return [
		`${prefix}foundry_local${ext}`,
		isWin ? 'onnxruntime.dll' : isMac ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1',
		`${prefix}onnxruntime-genai${ext}`,
		...(isWin ? ['Microsoft.Windows.AI.MachineLearning.dll'] : isMac ? ['libonnxruntime.dylib'] : []),
	];
}

/**
 * Build the gzipped tar via node-tar so the output is consistent regardless of
 * which host's system tar would otherwise be used. `portable`/`mtime` strip
 * host-specific metadata for reproducible bytes across re-runs on the same host.
 */
async function buildTarball(stagingDir: string, outTgz: string): Promise<void> {
	await tar.c(
		{
			file: outTgz,
			cwd: stagingDir,
			gzip: { level: 9 },
			portable: true,
			mtime: new Date(0),
		},
		['prebuilds'],
	);
}

// #region CLI entry point

function isCliInvocation(): boolean {
	return import.meta.filename === process.argv[1];
}

function parseCliArgs(): IBuildArgs {
	const flags = parseFlags(process.argv.slice(2));
	const target = flags.get('target');
	if (!target) {
		throw new Error('--target=<platform-arch> is required (e.g. --target=darwin-arm64)');
	}
	const outDir = flags.get('out') ?? path.resolve(process.cwd(), 'out');
	return { target, outDir };
}

if (isCliInvocation()) {
	buildOne(parseCliArgs()).catch(err => {
		console.error(err);
		process.exit(1);
	});
}

// #endregion
