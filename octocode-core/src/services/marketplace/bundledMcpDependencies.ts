import { stat } from "node:fs/promises"
import * as path from "node:path"

/** Inspect local payload only. Default registration must never provision dependencies. */
export async function missingBundledMcpDependencies(
	id: string,
	root = process.env.OCTOCODE_ENVIRONMENTS,
): Promise<string[]> {
	if (!root) return ["OCTOCODE_ENVIRONMENTS is not configured"]
	const node = process.platform === "win32" ? "node/node.exe" : "node/bin/node"
	const dependencies: Record<string, string[]> = {
		"code-review-graph":
			process.platform === "win32"
				? ["python/python.exe", "tools/mcp/code-review-graph/code_review_graph"]
				: ["python/bin/python3", "python/bin/code-review-graph"],
		"llm-wiki": [node, "tools/mcp/llmwiki/node_modules/@llmwiki/core/dist/mcp/bin.js"],
		scrapling:
			process.platform === "win32"
				? ["python/python.exe", "python/Lib/site-packages/scrapling/", "tools/mcp/scrapling/server.py"]
				: ["python/bin/python3", "tools/mcp/scrapling/server.py"],
	}
	const required = dependencies[id]
	if (!required) throw new Error(`Unknown bundled MCP dependency set: ${id}`)
	const missing: string[] = []
	for (const relative of required) {
		try {
			const entry = await stat(path.join(root, relative))
			const directory = relative.endsWith("/code_review_graph") || relative.endsWith("/")
			if (directory ? !entry.isDirectory() : !entry.isFile()) missing.push(relative)
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				(error as NodeJS.ErrnoException).code !== "ENOTDIR"
			)
				throw error
			missing.push(relative)
		}
	}
	return missing
}
