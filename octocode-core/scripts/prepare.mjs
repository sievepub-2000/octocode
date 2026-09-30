import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

if (existsSync(".git")) {
	const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "husky"], {
		stdio: "inherit",
		shell: process.platform === "win32",
	})
	process.exit(result.status ?? 1)
}
