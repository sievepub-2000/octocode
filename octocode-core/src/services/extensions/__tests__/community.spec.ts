import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { installCommunitySkill, searchCommunity } from "../community"

afterEach(() => vi.unstubAllGlobals())

describe("system community catalog", () => {
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
