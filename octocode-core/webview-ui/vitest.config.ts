import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"
import { readFileSync } from "node:fs"
import { resolveVerbosity } from "../src/utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()
const isCI = process.env.CI === "true"
const isWindows = process.platform === "win32"

// The stylesheet, read here and injected as a constant.
//
// Tests run under jsdom, where Vite resolves `node:fs` to nothing and stubs CSS
// imports (`?raw` included) to an empty string, so a spec cannot reach the real
// stylesheet on its own -- the one that tried failed to load and silently took
// its assertions out of the run. Reading it at config time, in Node, where the
// file plainly exists, sidesteps both. Test config only; never ships.
const indexCss = readFileSync(path.resolve(__dirname, "src/index.css"), "utf8")

export default defineConfig({
	plugins: [react()],
	define: { __INDEX_CSS__: JSON.stringify(indexCss) },
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		environment: "jsdom",
		// Node's native storage masks jsdom's isolated per-window storage in test
		// workers. Node 24 names the flag `--no-experimental-webstorage`; the plain
		// `--no-webstorage` form is rejected by the runtime and kills the worker
		// forks before any test runs.
		execArgv: ["--no-experimental-webstorage"],
		include: ["src/**/*.spec.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
		onConsoleLog,
		maxWorkers: isCI || isWindows ? 1 : undefined,
		testTimeout: isCI ? 15000 : 5000,
		server: {
			deps: {
				inline: ["@radix-ui/react-slot"],
			},
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/*.visual.ts",
				"**/*.visual.tsx",
				"**/vitest.setup.ts",
				"**/vitest.config.ts",
				"**/vite.config.ts",
				"**/__mocks__/**",
			],
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@src": path.resolve(__dirname, "./src"),
			"@roo": path.resolve(__dirname, "../src/shared"),
			// Mock the vscode module for tests since it's not available outside
			// VS Code extension context.
			vscode: path.resolve(__dirname, "./src/__mocks__/vscode.ts"),
		},
	},
})
