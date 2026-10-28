import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
	installCommunitySkill,
	searchCommunity,
	searchCommunityPage,
	searchMcpPackages,
	prepareCommunityMcp,
} from "../community"

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe("system community catalog", () => {
	it("loads the GitHub manifest once and searches and paginates without fabricated popularity", async () => {
		const skills = Array.from({ length: 45 }, (_, index) => ({
			id: `demo-${index}`,
			name: `demo-${index}`,
			path: `skills/demo-${index}`,
			description: index === 24 ? "Unique PDF workflow" : "Test skill",
			category: "testing",
		}))
		const fetch = vi.fn(async () => new Response(JSON.stringify(skills)))
		vi.stubGlobal("fetch", fetch)
		const { searchCommunityPage } = await import("../community")
		const page = await searchCommunityPage("skill", "")
		expect(fetch).toHaveBeenCalledWith(
			"https://raw.githubusercontent.com/sickn33/agentic-awesome-skills/main/skills_index.json",
			expect.any(Object),
		)
		expect(page.entries).toHaveLength(20)
		expect(page.nextCursor).toBe("20")
		expect(page.entries[0]).toMatchObject({
			id: "community:sickn33/agentic-awesome-skills/demo-0",
			actions: ["install"],
		})
		expect(page.entries.every((entry) => entry.rank === undefined)).toBe(true)
		const next = await searchCommunityPage("skill", "", page.nextCursor)
		expect(next.entries[0].id).not.toBe(page.entries[0].id)
		expect((await searchCommunityPage("skill", "PDF")).entries.map((entry) => entry.name)).toEqual(["demo-24"])
		expect(fetch).toHaveBeenCalledTimes(1)
		await expect(searchCommunityPage("skill", "", "-1")).rejects.toThrow("Invalid")
	})
	it("keeps the dated GitHub snapshot visible when the network is unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))
		const { searchCommunityPage } = await import("../community")
		const page = await searchCommunityPage("skill", "")
		expect(page.entries).toHaveLength(20)
		expect(page.entries.every((entry) => entry.detail?.includes("随包快照"))).toBe(true)
		expect(page.entries.every((entry) => entry.id.startsWith("community:sickn33/agentic-awesome-skills/"))).toBe(
			true,
		)
	})
	it("never exposes escaping or mismatched manifest paths as installable skills", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify([
							{
								id: "good",
								name: "good",
								path: "skills/group/good",
								description: "Valid",
								category: "testing",
							},
							{
								id: "escape",
								name: "escape",
								path: "skills/../../escape",
								description: "Bad",
								category: "testing",
							},
							{
								id: "mismatch",
								name: "mismatch",
								path: "skills/other",
								description: "Bad",
								category: "testing",
							},
						]),
					),
			),
		)
		const { searchCommunityPage } = await import("../community")
		expect((await searchCommunityPage("skill", "")).entries.map((entry) => entry.name)).toEqual(["good"])
	})
	it("shows a labeled snapshot promptly while a slow live catalog continues loading", async () => {
		vi.useFakeTimers()
		let finish: (response: Response) => void = () => {
			throw new Error("fetch not started")
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						finish = resolve
					}),
			),
		)
		try {
			const { searchCommunityPage } = await import("../community")
			const pending = searchCommunityPage("skill", "")
			await vi.advanceTimersByTimeAsync(500)
			expect((await pending).entries[0].detail).toContain("随包快照")
			finish(
				new Response(
					JSON.stringify([
						{ id: "live", name: "live", path: "skills/live", description: "Loaded", category: "testing" },
					]),
				),
			)
			const live = await searchCommunityPage("skill", "")
			expect(live.entries.map((entry) => entry.name)).toEqual(["live"])
			expect(live.entries[0].detail).toContain("Agentic Awesome Skills")
		} finally {
			vi.useRealTimers()
		}
	})
	it("pins an AAS skill subtree and preserves upstream license attribution", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "octocode-aas-"))
		const previous = process.env.OCTOCODE_ENVIRONMENTS
		process.env.OCTOCODE_ENVIRONMENTS = root
		const sha = "b".repeat(40)
		const requests: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				requests.push(url)
				if (url.endsWith("skills_index.json"))
					return new Response(
						JSON.stringify([
							{
								id: "demo",
								name: "demo",
								path: "skills/group/demo",
								description: "Demo",
								category: "testing",
							},
						]),
					)
				if (url.includes("/commits/")) return new Response(JSON.stringify({ sha }))
				if (url.includes("/git/trees/"))
					return new Response(
						JSON.stringify({
							truncated: false,
							tree: [{ path: "SKILL.md", type: "blob", mode: "100644", size: 50 }],
						}),
					)
				if (url.endsWith("/LICENSE") || url.endsWith("/LICENSE-CONTENT"))
					return new Response("Upstream license")
				return new Response("---\nname: demo\ndescription: Demo\n---\nSkill")
			}),
		)
		try {
			const { installCommunitySkill } = await import("../community")
			await installCommunitySkill("sickn33/agentic-awesome-skills/demo")
			expect(requests).toContain(
				`https://api.github.com/repos/sickn33/agentic-awesome-skills/git/trees/${encodeURIComponent(`${sha}:skills/group/demo`)}?recursive=1`,
			)
			expect(requests).toContain(
				`https://raw.githubusercontent.com/sickn33/agentic-awesome-skills/${sha}/skills/group/demo/SKILL.md`,
			)
			expect(await readFile(path.join(root, "tools/skills/demo/.octocode-LICENSE-CONTENT"), "utf8")).toBe(
				"Upstream license",
			)
		} finally {
			if (previous === undefined) delete process.env.OCTOCODE_ENVIRONMENTS
			else process.env.OCTOCODE_ENVIRONMENTS = previous
			await rm(root, { recursive: true, force: true })
		}
	})
	it("uses the public npm popularity catalog with exact cursor offsets and package identities", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						total: 41,
						objects: [
							{
								package: { name: "@modelcontextprotocol/server-filesystem", version: "1.0.0" },
								score: { final: 95 },
							},
						],
					}),
				),
		)
		vi.stubGlobal("fetch", fetch)
		const page = await searchMcpPackages("files", "20")
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining("from=20&quality=0&popularity=1&maintenance=0"),
			expect.any(Object),
		)
		expect(page).toMatchObject({
			nextCursor: "40",
			entries: [{ id: "community:npm:@modelcontextprotocol/server-filesystem", rank: 95, actions: ["install"] }],
		})
		await expect(searchMcpPackages("", "../bad")).rejects.toThrow("Invalid")
	})
	it("offers remote MCP installation and keeps required credentials disabled until configured", async () => {
		const server = {
			name: "io.test/remote",
			version: "1.0.0",
			description: "remote",
			remotes: [
				{
					type: "streamable-http",
					url: "https://example.com/mcp",
					headers: [{ name: "Authorization", isSecret: true, isRequired: true }],
				},
			],
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (url: string) =>
					new Response(
						JSON.stringify(
							url.includes("/versions/")
								? { server }
								: { servers: [{ server }], metadata: { nextCursor: "next" } },
						),
					),
			),
		)
		expect((await searchCommunityPage("mcp", "remote")).entries[0].actions).toEqual(["install"])
		const prepared = await prepareCommunityMcp("io.test/remote")
		expect(JSON.parse(prepared.item.content as string)).toEqual({
			type: "streamable-http",
			url: "https://example.com/mcp",
			headers: {},
			disabled: true,
		})
		expect(prepared.directory).toBeUndefined()
	})
	it("validates the registry and leaves unsupported distributions un-installable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							servers: [
								{
									server: {
										name: "io.test/docker",
										description: "Docker",
										version: "1.0.0",
										packages: [
											{
												registryType: "oci",
												identifier: "test/image",
												transport: { type: "stdio" },
											},
										],
									},
								},
							],
						}),
					),
			),
		)
		const result = await searchCommunity("mcp", "docker")
		expect(result[0]).toMatchObject({ scope: "global", actions: [] })
	})
	it("pins skill bytes to a commit and refuses traversal without touching files", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "octocode-tools-"))
		const previous = process.env.OCTOCODE_ENVIRONMENTS
		process.env.OCTOCODE_ENVIRONMENTS = root
		const sha = "a".repeat(40)
		const document = "---\nname: demo\ndescription: A test skill\n---\nskill!"
		const requests: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				requests.push(url)
				if (url.includes("/commits/")) return new Response(JSON.stringify({ sha }))
				if (url.includes("/git/trees/"))
					return new Response(
						JSON.stringify({
							truncated: false,
							tree: [{ path: "skills/demo/SKILL.md", type: "blob", mode: "100644", size: 6 }],
						}),
					)
				return new Response(document)
			}),
		)
		try {
			await mkdir(path.join(root, "workspace"))
			await installCommunitySkill("owner/repo/demo")
			expect(await readFile(path.join(root, "tools/skills/demo/SKILL.md"), "utf8")).toBe(document)
			expect(requests.some((url) => url.includes(`/repo/${sha}/skills/demo/SKILL.md`))).toBe(true)
			await expect(installCommunitySkill("owner/repo/../../escape")).rejects.toThrow("Invalid")
			await expect(installCommunitySkill("owner/repo/demo")).rejects.toThrow()
			expect(await readFile(path.join(root, "tools/skills/demo/SKILL.md"), "utf8")).toBe(document)
		} finally {
			if (previous === undefined) delete process.env.OCTOCODE_ENVIRONMENTS
			else process.env.OCTOCODE_ENVIRONMENTS = previous
			await rm(root, { recursive: true, force: true })
		}
	})
})
