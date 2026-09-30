import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { missingBundledMcpDependencies } from "../bundledMcpDependencies"

it("requires both the interpreter and optional module without installing anything", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "octocode-mcp-dependencies-"))
	try {
		expect(await missingBundledMcpDependencies("llm-wiki", root)).toHaveLength(2)
		const node = path.join(root, process.platform === "win32" ? "node/node.exe" : "node/bin/node")
		await mkdir(path.dirname(node), { recursive: true })
		await writeFile(node, "fixture")
		const entry = "tools/mcp/llmwiki/node_modules/@llmwiki/core/dist/mcp/bin.js"
		expect(await missingBundledMcpDependencies("llm-wiki", root)).toEqual([entry])
		await mkdir(path.dirname(path.join(root, entry)), { recursive: true })
		await writeFile(path.join(root, entry), "fixture")
		expect(await missingBundledMcpDependencies("llm-wiki", root)).toEqual([])
		await expect(missingBundledMcpDependencies("obscura", root)).rejects.toThrow("Unknown bundled MCP")
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
