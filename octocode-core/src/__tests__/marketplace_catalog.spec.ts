import * as fs from "fs"
import * as path from "path"
import * as yaml from "yaml"

describe("default MCP catalog", () => {
	const catalog = yaml.parse(fs.readFileSync(path.join(__dirname, "../assets/marketplace/mcps.yml"), "utf-8"))
	const item = (id: string) => catalog.items.find((entry: { id: string }) => entry.id === id)

	it("uses the bundled Code Review Graph stdio server", () => {
		const config = JSON.parse(item("code-review-graph").content[0].content)
		expect(config).toMatchObject({
			command: "${env:OCTOCODE_PYTHON_BASE}",
			args: ["-m", "code_review_graph", "serve", "--repo", "${env:OCTOCODE_WORKSPACE}"],
		})
	})

	it("registers LLM Wiki as an external MCP server", () => {
		const config = JSON.parse(item("llm-wiki").content[0].content)
		expect(config).toEqual({
			command: "${env:OCTOCODE_NODE}",
			args: [
				"${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/llmwiki/node_modules/@llmwiki/core/dist/mcp/bin.js",
				"${env:OCTOCODE_WORKSPACE}/.wiki",
			],
		})
	})

	it("contains only local command-based MCP servers", () => {
		expect(catalog.items.map(({ id }: { id: string }) => id)).toEqual([
			"code-review-graph",
			"llm-wiki",
			"scrapling",
		])
		for (const entry of catalog.items) {
			const config = JSON.parse(entry.content[0].content)
			expect(config.command).toEqual(expect.any(String))
			expect(config).not.toHaveProperty("url")
			expect(config.type).not.toBe("streamable-http")
			expect(config.type).not.toBe("sse")
		}
	})

	it("registers Scrapling from the bundled Python", () => {
		expect(JSON.parse(item("scrapling").content[0].content)).toEqual({
			command: "${env:OCTOCODE_PYTHON_BASE}",
			args: ["${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/scrapling/server.py"],
		})
	})
})
