import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
	searchCommunity,
	searchCommunityPage,
	searchMcpPackages,
	installCommunitySkill,
	prepareCommunityMcp,
} from "../community"

describe.skipIf(process.env.OCTOCODE_NET_TESTS !== "1")("community catalog live lifecycle", () => {
	beforeAll(async () => {
		const nock = (await import("nock")).default
		nock.cleanAll()
		nock.restore()
		nock.enableNetConnect()
	})
	afterAll(async () => {
		const nock = (await import("nock")).default
		if (!nock.isActive()) nock.activate()
		nock.disableNetConnect()
	})
	it("loads live GitHub Skills and ranked MCP pages with distinct next pages", async () => {
		let first = await searchCommunityPage("skill", "")
		const deadline = Date.now() + 95_000
		while (first.entries.some((entry) => entry.detail?.includes("随包快照")) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1000))
			first = await searchCommunityPage("skill", "")
		}
		expect(first.entries).toHaveLength(20)
		expect(first.nextCursor).toBe("20")
		const second = await searchCommunityPage("skill", "", first.nextCursor)
		expect(second.entries[0].id).not.toBe(first.entries[0].id)
		expect(first.entries.every((entry) => entry.detail?.includes("Agentic Awesome Skills"))).toBe(true)
		expect(first.entries.every((entry) => entry.rank === undefined)).toBe(true)
		const mcp = await searchMcpPackages("")
		expect(mcp.entries.length).toBeGreaterThan(0)
		expect(mcp.entries.length).toBeLessThanOrEqual(20)
		expect(mcp.nextCursor).toBe("20")
		expect((await searchMcpPackages("", mcp.nextCursor)).entries[0].id).not.toBe(mcp.entries[0].id)
	}, 120_000)
	it("installs a real GitHub skill into the shared root and reads it back", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "octocode-market-live-"))
		const previous = process.env.OCTOCODE_ENVIRONMENTS
		process.env.OCTOCODE_ENVIRONMENTS = root
		try {
			const skills = await searchCommunity("skill", "pdf-conversion-router")
			const found = skills.find(
				(entry) => entry.id === "community:sickn33/agentic-awesome-skills/pdf-conversion-router",
			)
			expect(found).toBeDefined()
			await installCommunitySkill(found!.id.slice("community:".length))
			expect(await readFile(path.join(root, "tools/skills/pdf-conversion-router/SKILL.md"), "utf8")).toContain(
				"name:",
			)
			const provenance = JSON.parse(
				await readFile(path.join(root, "tools/skills/pdf-conversion-router/.octocode-source.json"), "utf8"),
			)
			expect(provenance.repository).toBe("sickn33/agentic-awesome-skills")
			expect(provenance.revision).toMatch(/^[a-f0-9]{40}$/)
			await expect(installCommunitySkill(found!.id.slice("community:".length))).rejects.toThrow()
			await rm(path.join(root, "tools/skills/pdf-conversion-router"), { recursive: true })
			expect(await readdir(path.join(root, "tools/skills"))).toEqual([])
		} finally {
			if (previous === undefined) delete process.env.OCTOCODE_ENVIRONMENTS
			else process.env.OCTOCODE_ENVIRONMENTS = previous
			await rm(root, { recursive: true, force: true })
		}
	}, 180_000)
	it("resolves a real official MCP npm package and reads the installed executable", async () => {
		const actual = process.env.OCTOCODE_TEST_ENVIRONMENTS
		if (!actual) throw new Error("OCTOCODE_TEST_ENVIRONMENTS must point to the bundled runtime")
		const root = await mkdtemp(path.join(tmpdir(), "octocode-mcp-live-"))
		const previous = process.env.OCTOCODE_ENVIRONMENTS
		process.env.OCTOCODE_ENVIRONMENTS = root
		const nodeLink = path.join(root, "node")
		try {
			await symlink(path.join(actual, "node"), nodeLink, process.platform === "win32" ? "junction" : "dir")
			await mkdir(path.join(root, "tools/mcp"), { recursive: true })
			const servers = (await searchMcpPackages("@modelcontextprotocol/server-memory")).entries
			const server = servers.find((entry) => entry.id === "community:npm:@modelcontextprotocol/server-memory")
			expect(server).toBeDefined()
			const result = await prepareCommunityMcp(server!.id.slice("community:".length))
			const config = JSON.parse(result.item.content as string) as { command: string; args: string[] }
			expect(config.args[0].startsWith(path.join(root, "tools/mcp"))).toBe(true)
			expect((await readFile(config.args[0])).byteLength).toBeGreaterThan(0)
			const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
			const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
			const client = new Client({ name: "octocode-market-acceptance", version: "2.0" })
			try {
				await client.connect(
					new StdioClientTransport({ command: config.command, args: config.args, stderr: "pipe" }),
				)
				expect((await client.listTools()).tools.some((tool) => tool.name === "create_entities")).toBe(true)
			} finally {
				await client.close()
			}
			expect(result.directory).toBeDefined()
			await rm(result.directory!, { recursive: true })
			expect(await readdir(path.join(root, "tools/mcp"))).toEqual([])
		} finally {
			await rm(nodeLink, { force: true })
			if (previous === undefined) delete process.env.OCTOCODE_ENVIRONMENTS
			else process.env.OCTOCODE_ENVIRONMENTS = previous
			await rm(root, { recursive: true, force: true })
		}
	}, 240_000)
})
