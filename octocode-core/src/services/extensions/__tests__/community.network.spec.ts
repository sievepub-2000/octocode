import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { searchCommunity, installCommunitySkill, prepareCommunityMcp } from "../community"

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
	it("installs a real GitHub skill into the shared root and reads it back", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "octocode-market-live-"))
		const previous = process.env.OCTOCODE_ENVIRONMENTS
		process.env.OCTOCODE_ENVIRONMENTS = root
		try {
			const skills = await searchCommunity("skill", "find-skills")
			const found = skills.find((entry) => entry.id === "community:vercel-labs/skills/find-skills")
			expect(found).toBeDefined()
			await installCommunitySkill(found!.id.slice("community:".length))
			expect(await readFile(path.join(root, "tools/skills/find-skills/SKILL.md"), "utf8")).toContain("name:")
			await rm(path.join(root, "tools/skills/find-skills"), { recursive: true })
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
			const servers = await searchCommunity("mcp", "filesystem")
			const server = servers.find((entry) => entry.actions.includes("install"))
			expect(server).toBeDefined()
			const result = await prepareCommunityMcp(server!.id.slice("community:".length))
			const config = JSON.parse(result.item.content as string) as { args: string[] }
			expect(config.args[0].startsWith(path.join(root, "tools/mcp"))).toBe(true)
			expect((await readFile(config.args[0])).byteLength).toBeGreaterThan(0)
			await rm(result.directory, { recursive: true })
			expect(await readdir(path.join(root, "tools/mcp"))).toEqual([])
		} finally {
			await rm(nodeLink, { force: true })
			if (previous === undefined) delete process.env.OCTOCODE_ENVIRONMENTS
			else process.env.OCTOCODE_ENVIRONMENTS = previous
			await rm(root, { recursive: true, force: true })
		}
	}, 240_000)
})
