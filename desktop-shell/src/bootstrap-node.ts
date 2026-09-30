/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { IProductConfiguration } from './vs/base/common/product.js';

const require = createRequire(import.meta.url);
const isWindows = process.platform === 'win32';

// Avoid 64 KiB pooled backing stores crossing Mojo's shared-memory threshold.
if (process.platform === 'linux') {
	Buffer.poolSize = 8 * 1024;
}

// increase number of stack frames(from 10, https://github.com/v8/v8/wiki/Stack-Trace-API)
Error.stackTraceLimit = 100;

if (!process.env['VSCODE_HANDLES_SIGPIPE']) {
	// Workaround for Electron not installing a handler to ignore SIGPIPE
	// (https://github.com/electron/electron/issues/13254)
	let didLogAboutSIGPIPE = false;
	process.on('SIGPIPE', () => {
		// See https://github.com/microsoft/vscode-remote-release/issues/6543
		// In certain situations, the console itself can be in a broken pipe state
		// so logging SIGPIPE to the console will cause an infinite async loop
		if (!didLogAboutSIGPIPE) {
			didLogAboutSIGPIPE = true;
			console.error(new Error(`Unexpected SIGPIPE`));
		}
	});
}

// Setup current working directory in all our node & electron processes
// - Windows: call `process.chdir()` to always set application folder as cwd
// -  all OS: store the `process.cwd()` inside `VSCODE_CWD` for consistent lookups
function setupCurrentWorkingDirectory(): void {
	try {

		// Store the `process.cwd()` inside `VSCODE_CWD`
		// for consistent lookups, but make sure to only
		// do this once unless defined already from e.g.
		// a parent process.
		if (typeof process.env['VSCODE_CWD'] !== 'string') {
			process.env['VSCODE_CWD'] = process.cwd();
		}

		// Windows: always set application folder as current working dir
		if (process.platform === 'win32') {
			process.chdir(path.dirname(process.execPath));
		}
	} catch (err) {
		console.error(err);
	}
}

setupCurrentWorkingDirectory();

/**
 * Add ASAR support to Node's CommonJS module resolution.
 *
 * Production builds bundle our `node_modules` into a `node_modules.asar`
 * archive that sits next to the (now mostly empty) `node_modules` folder.
 * Node does not look into `.asar` archives on its own, so we splice the
 * archive into the lookup paths right before the real `node_modules` folder.
 *
 * The archive keeps the same top-level layout as `node_modules`
 * (`node_modules.asar/<module>`), so bare `require('<module>')` calls resolve
 * exactly like they did before ASAR was introduced. This keeps extensions and
 * tooling that reach into `${appRoot}/node_modules.asar/<module>` working.
 *
 * Note: only applies to the packaged app running on Electron (incl.
 * `ELECTRON_RUN_AS_NODE` forks), never when running out of sources.
 */
function enableASARSupport(): void {
	if (!process.env['ELECTRON_RUN_AS_NODE'] && !process.versions['electron']) {
		return; // only on Electron / Electron-as-node
	}

	if (process.env['VSCODE_DEV']) {
		return; // no ASAR when running out of sources
	}

	// Normalize the drive letter to lower-case for comparison. On Windows the
	// path derived from `import.meta.dirname` (a file URL) can use a different
	// drive-letter case than the paths Node computes for a `require` parent, so
	// an exact string comparison would miss the insertion point (breaking e.g.
	// `require('mkdirp')` from a module inside the archive).
	const normalizeDriveLetter = (p: string): string => {
		if (isWindows && p.length >= 2 && p.charCodeAt(1) === 58 /* : */) {
			const code = p.charCodeAt(0);
			if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
				return p[0].toLowerCase() + p.slice(1);
			}
		}
		return p;
	};

	const NODE_MODULES_PATH = normalizeDriveLetter(path.join(import.meta.dirname, '../node_modules'));

	const Module = require('node:module') as typeof import('node:module') & {
		_resolveLookupPaths: (request: string, parent: unknown) => string[] | null;
	};

	const originalResolveLookupPaths = Module._resolveLookupPaths;
	Module._resolveLookupPaths = function (request: string, parent: unknown): string[] | null {
		const paths = originalResolveLookupPaths(request, parent);
		if (Array.isArray(paths)) {
			for (let i = 0, len = paths.length; i < len; i++) {
				if (normalizeDriveLetter(paths[i]) === NODE_MODULES_PATH) {
					// Derive the archive path from the matched entry so drive-letter
					// case and path separators are preserved exactly.
					paths.splice(i, 0, `${paths[i]}.asar`);
					break;
				}
			}
		}

		return paths;
	};
}

enableASARSupport();

/**
 * Add support for redirecting the loading of node modules
 *
 * Note: only applies when running out of sources.
 */
export function devInjectNodeModuleLookupPath(injectPath: string): void {
	if (!process.env['VSCODE_DEV']) {
		return; // only applies running out of sources
	}

	if (!injectPath) {
		throw new Error('Missing injectPath');
	}

	// register a loader hook
	const Module = require('node:module');
	Module.register('./bootstrap-import.js', { parentURL: import.meta.url, data: injectPath });
}

export function removeGlobalNodeJsModuleLookupPaths(): void {
	if (typeof process?.versions?.electron === 'string') {
		return; // Electron disables global search paths in https://github.com/electron/electron/blob/3186c2f0efa92d275dc3d57b5a14a60ed3846b0e/shell/common/node_bindings.cc#L653
	}

	const Module = require('module');
	const globalPaths = Module.globalPaths;

	const originalResolveLookupPaths = Module._resolveLookupPaths;

	Module._resolveLookupPaths = function (moduleName: string, parent: unknown): string[] {
		const paths = originalResolveLookupPaths(moduleName, parent);
		if (Array.isArray(paths)) {
			let commonSuffixLength = 0;
			while (commonSuffixLength < paths.length && paths[paths.length - 1 - commonSuffixLength] === globalPaths[globalPaths.length - 1 - commonSuffixLength]) {
				commonSuffixLength++;
			}

			return paths.slice(0, paths.length - commonSuffixLength);
		}

		return paths;
	};

	const originalNodeModulePaths = Module._nodeModulePaths;
	Module._nodeModulePaths = function (from: string): string[] {
		let paths: string[] = originalNodeModulePaths(from);
		if (!isWindows) {
			return paths;
		}

		// On Windows, remove drive(s) and users' home directory from search paths,
		// UNLESS 'from' is explicitly set to one of those.
		const isDrive = (p: string) => p.length >= 3 && p.endsWith(':\\');

		if (!isDrive(from)) {
			paths = paths.filter(p => !isDrive(path.dirname(p)));
		}

		if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
			const userDir = path.dirname(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH));

			const isUsersDir = (p: string) => path.relative(p, userDir).length === 0;

			// Check if 'from' is the same as 'userDir'
			if (!isUsersDir(from)) {
				paths = paths.filter(p => !isUsersDir(path.dirname(p)));
			}
		}

		return paths;
	};
}

/**
 * Helper to enable portable mode.
 */
export function configurePortable(product: Partial<IProductConfiguration>): { portableDataPath: string; isPortable: boolean } {
	const appRoot = path.dirname(import.meta.dirname);

	function getApplicationPath(): string {
		if (process.env['VSCODE_DEV']) {
			return appRoot;
		}

		if (process.platform === 'darwin') {
			return path.dirname(path.dirname(path.dirname(appRoot)));
		}

		// appRoot = ..\Microsoft VS Code Insiders\<version>\resources\app
		if (process.platform === 'win32' && product.win32VersionedUpdate) {
			return path.dirname(path.dirname(path.dirname(appRoot)));
		}

		return path.dirname(path.dirname(appRoot));
	}

	function getPortableDataPath(): string {
		if (process.env['VSCODE_PORTABLE']) {
			return process.env['VSCODE_PORTABLE'];
		}

		if (process.platform === 'win32' || process.platform === 'linux') {
			return path.join(getApplicationPath(), 'data');
		}

		const portableDataName = product.portable || `${product.applicationName}-portable-data`;
		return path.join(path.dirname(getApplicationPath()), portableDataName);
	}

	const portableDataPath = getPortableDataPath();
	const isPortable = fs.existsSync(portableDataPath);
	const portableTempPath = path.join(portableDataPath, 'tmp');
	const isTempPortable = isPortable && fs.existsSync(portableTempPath);

	if (isPortable) {
		process.env['VSCODE_PORTABLE'] = portableDataPath;
		configureOctoCodeEnvironment(getApplicationPath(), portableDataPath);
	} else {
		delete process.env['VSCODE_PORTABLE'];
	}

	if (isTempPortable) {
		if (process.platform === 'win32') {
			process.env['TMP'] = portableTempPath;
			process.env['TEMP'] = portableTempPath;
		} else {
			process.env['TMPDIR'] = portableTempPath;
		}
	}

	return {
		portableDataPath,
		isPortable
	};
}

export function getOctoCodeRuntimePathEntries(platform: NodeJS.Platform): string[] {
	return platform === 'win32'
		? ['scripts', 'node', 'powershell', 'go/bin', 'jdk/bin', 'dotnet', 'pandoc', 'ffmpeg/bin', 'python', 'python/Scripts', 'uv', 'rust/cargo/bin', 'protobuf/bin', 'android/platform-tools', 'android/cmdline-tools/latest/bin']
		: ['scripts', 'node/bin', 'powershell', 'go/bin', 'jdk/bin', 'dotnet', 'pandoc', 'ffmpeg/bin', 'python/bin', 'uv', 'rust/cargo/bin', 'protobuf/bin', 'android/platform-tools', 'android/cmdline-tools/latest/bin'];
}

function configureOctoCodeEnvironment(applicationPath: string, dataPath: string): void {
	const environments = path.join(applicationPath, 'environments');
	// Not filtered by existence: toolchains are installed on demand while the app
	// runs, and an entry that only appears later must already be on PATH for the
	// agent's next shell (a missing directory on PATH is harmless).
	const runtimePaths = getOctoCodeRuntimePathEntries(process.platform)
		.map(relativePath => path.join(environments, relativePath));
	runtimePaths.push(
		path.join(dataPath, 'npm-global'),
		path.join(dataPath, 'pnpm'),
		path.join(dataPath, 'python-user', isWindows ? 'Scripts' : 'bin'),
		path.join(dataPath, 'go', 'bin')
	);
	const pathKey = isWindows ? Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path' : 'PATH';
	process.env[pathKey] = [...new Set([...runtimePaths, ...(process.env[pathKey] || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);

	Object.assign(process.env, {
		OCTOCODE_HOME: applicationPath,
		OCTOCODE_DATA: dataPath,
		OCTOCODE_ENVIRONMENTS: environments,
		OCTOCODE_NODE: path.join(environments, 'node', isWindows ? 'node.exe' : 'bin/node'),
		OCTOCODE_PYTHON_BASE: path.join(environments, 'python', isWindows ? 'python.exe' : 'bin/python3'),
		OCTOCODE_WORKSPACE: path.join(applicationPath, 'workspace'),
		DOTNET_CLI_HOME: path.join(dataPath, 'dotnet'),
		DOTNET_NOLOGO: '1',
		DOTNET_CLI_TELEMETRY_OPTOUT: '1',
		DOTNET_GENERATE_ASPNET_CERTIFICATE: '0',
		DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: '0',
		DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1',
		DOTNET_SDK_VULNERABILITY_CHECK_DISABLE: '1',
		GOPATH: path.join(dataPath, 'go'),
		GOCACHE: path.join(dataPath, 'cache', 'go-build'),
		GOTELEMETRYDIR: path.join(dataPath, 'go', 'telemetry'),
		ANDROID_USER_HOME: path.join(environments, 'android', 'user-home'),
		ANDROID_SDK_HOME: path.join(environments, 'android', 'user-home'),
		ANDROID_EMULATOR_HOME: path.join(environments, 'android', 'user-home'),
		ANDROID_AVD_HOME: path.join(environments, 'android', 'user-home', 'avd'),
		GRADLE_USER_HOME: path.join(dataPath, 'gradle'),
		NUGET_PACKAGES: path.join(dataPath, 'nuget'),
		NPM_CONFIG_CACHE: path.join(dataPath, 'cache', 'npm'),
		NPM_CONFIG_PREFIX: path.join(dataPath, 'npm-global'),
		COREPACK_HOME: path.join(dataPath, 'corepack'),
		PNPM_HOME: path.join(dataPath, 'pnpm'),
		PIP_CACHE_DIR: path.join(dataPath, 'cache', 'pip'),
		PYTHONUSERBASE: path.join(dataPath, 'python-user'),
		PYTHONPYCACHEPREFIX: path.join(dataPath, 'cache', 'python-bytecode'),
		UV_CACHE_DIR: path.join(dataPath, 'cache', 'uv')
	});
	// Optional SDK roots must not shadow a working inherited SDK with an absent one.
	for (const [key, relative] of Object.entries({ JAVA_HOME: 'jdk', DOTNET_ROOT: 'dotnet', GOROOT: 'go', CARGO_HOME: 'rust/cargo', RUSTUP_HOME: 'rust/rustup', ANDROID_HOME: 'android', ANDROID_SDK_ROOT: 'android' })) {
		const candidate = path.join(environments, relative);
		const installed = relative.startsWith('rust/') ? fs.existsSync(path.join(environments, 'rust', 'cargo', 'bin', 'rustup.exe')) && fs.existsSync(path.join(environments, 'rust', 'rustup', 'settings.toml')) : fs.existsSync(candidate);
		if (installed) {
			process.env[key] = candidate;
		} else if (process.env[key] === candidate) {
			delete process.env[key];
		}
	}
	// npm resolves its prefix eagerly and fails with ENOENT when the directory is
	// missing, which broke every `npx` in agent terminals on a fresh install.
	for (const directory of [path.join(dataPath, 'npm-global'), path.join(dataPath, 'pnpm'), path.join(dataPath, 'cache', 'npm')]) {
		try {
			fs.mkdirSync(directory, { recursive: true });
		} catch {
			// Read-only data directory: the tools report their own error later.
		}
	}
}
