import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@roo-code/build"
import { writeThirdPartyNotices } from "../scripts/third-party-notices.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function removeDirWithRetries(dirPath, retries = 5, retryDelayMs = 200) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fs.promises.rm(dirPath, { recursive: true, force: true })
			return
		} catch (error) {
			const isRetryable = error?.code === "ENOTEMPTY" || error?.code === "EBUSY" || error?.code === "EPERM"
			const isLastAttempt = attempt === retries

			if (!isRetryable || isLastAttempt) {
				throw error
			}

			await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * (attempt + 1)))
		}
	}
}

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	// Nothing in the shipped extension reads the maps (they were for cloud error
	// telemetry, which OctoCode does not ship); they only added ~16 MB to the VSIX.
	// Set OCTOCODE_SOURCEMAPS=1 to keep them for a debugging build.
	const sourcemap = !production || process.env.OCTOCODE_SOURCEMAPS === "1"

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		metafile: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
		define: {
			"process.env.PKG_RELEASE_CHANNEL": JSON.stringify(process.env.PKG_RELEASE_CHANNEL || "stable"),
			"process.env.POSTHOG_API_KEY": JSON.stringify(process.env.POSTHOG_API_KEY || ""),
		},
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		await removeDirWithRetries(distDir)
	}

	// The worker and broker contexts share the same distDir; their bundle inputs
	// must reach the same ThirdPartyNotices.txt or license evidence for packages
	// only they import would be silently missing from the VSIX. Every context
	// merges its metafile inputs into this shared set before rewriting the file.
	const sharedNoticesInputs = new Set()
	const makeThirdPartyNoticesPlugin = (extras) => ({
		name: "thirdPartyNotices",
		setup(build) {
			build.onEnd((result) => {
				if (result.errors.length || !result.metafile) return
				for (const file of Object.keys(result.metafile.inputs))
					sharedNoticesInputs.add(path.resolve(srcDir, file))
				// writeThirdPartyNotices is synchronous, so concurrent watch rebuilds
				// serialize naturally; a throw here fails the build on purpose.
				writeThirdPartyNotices([...sharedNoticesInputs], path.join(distDir, "ThirdPartyNotices.txt"), extras)
			})
		},
	})

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		makeThirdPartyNoticesPlugin(
			["tiktoken", "web-tree-sitter", "tree-sitter-wasms", "esbuild-wasm", "global-agent"].map((name) =>
				path.join(srcDir, "node_modules", name, "package.json"),
			),
		),
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["../webview-ui/audio", "webview-ui/audio"],
							["assets/marketplace", "dist/assets/marketplace"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		external: ["vscode", "esbuild", "global-agent", "@vscode/ripgrep"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["workers/countTokens.ts"],
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx, brokerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
		esbuild.context({
			...buildOptions,
			plugins,
			entryPoints: ["services/octocode-runtime/RuntimeBroker.ts"],
			outfile: "dist/runtime/hostBroker.js",
		}),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch(), brokerCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		// Run sequentially on rebuild to avoid Windows EBUSY races when both
		// onEnd hooks copy the same asset directories concurrently.
		await extensionCtx.rebuild()
		await workerCtx.rebuild()
		await brokerCtx.rebuild()
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose(), brokerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
