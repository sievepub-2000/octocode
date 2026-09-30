import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		watch: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/vitest.config.ts",
				"**/__mocks__/**",
			],
		},
	},
	resolve: {
		alias: {
			vscode: fileURLToPath(new URL("./src/__mocks__/vscode.ts", import.meta.url)),
		},
	},
})
