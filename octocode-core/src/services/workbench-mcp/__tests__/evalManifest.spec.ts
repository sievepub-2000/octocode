import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { dispatchWorkbenchBrowser } from "../WorkbenchMcpServer"
import { blockedBrowserUrl, readEvalManifest } from "../evalManifest"

describe("evaluation manifest in the workbench browser", () => {
	const manifest = { blocked_url_prefixes: ["github.com/sympy/sympy", "exercism.org"] }

	it("blocks answer sources and leaves everything else alone", () => {
		expect(blockedBrowserUrl(manifest, "https://www.github.com/sympy/sympy/pull/123")).toContain(
			"evaluation manifest",
		)
		expect(blockedBrowserUrl(manifest, "https://exercism.org/tracks/rust")).toBeDefined()
		expect(blockedBrowserUrl(manifest, "https://en.wikipedia.org/wiki/SymPy")).toBeUndefined()
		expect(blockedBrowserUrl(undefined, "https://github.com/sympy/sympy")).toBeUndefined()
	})

	it("reads the manifest from the task workspace and refuses the navigation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-eval-"))
		fs.mkdirSync(path.join(root, ".octocode"))
		fs.writeFileSync(path.join(root, ".octocode", "eval-manifest.json"), JSON.stringify(manifest))
		expect(readEvalManifest(root)).toEqual(manifest)

		const invoke = vi.fn(async () => "opened")
		const task = { taskId: "t", sessionId: "s", permissionProfile: "full" as const, workspaceRoot: root }
		await expect(
			dispatchWorkbenchBrowser("open", { url: "https://github.com/sympy/sympy/commit/abc" }, invoke, task),
		).rejects.toThrow("evaluation manifest")
		expect(invoke).not.toHaveBeenCalled()
		await expect(dispatchWorkbenchBrowser("open", { url: "https://example.com" }, invoke, task)).resolves.toBe(
			"opened",
		)
		fs.rmSync(root, { recursive: true, force: true })
	})
})
