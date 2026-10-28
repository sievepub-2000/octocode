import { describe, expect, it, vi } from "vitest"

import type { MarketplaceItem, McpServer } from "@roo-code/types"

import { environmentManifest } from "../../environments/manifest"
import { ExtensionRegistry, type ExtensionRegistryDependencies } from "../ExtensionRegistry"

function fixture() {
	const servers: McpServer[] = [
		{ name: "scrapling", config: "{}", status: "connected", source: "global" },
		{ name: "old", config: "{}", status: "disconnected", source: "project", disabled: true },
	]
	const catalog = [
		{ id: "scrapling", name: "Scrapling", description: "web", type: "mcp", url: "", content: "{}" },
		{ id: "llm-wiki", name: "LLM Wiki", description: "wiki", type: "mcp", url: "", content: "{}" },
		{ id: "auto-research", name: "Auto Research", description: "mode", type: "mode", content: "{}" },
	] as MarketplaceItem[]
	let skills = [{ name: "ponytail", description: "fast", source: "project" as const }]
	const installedEnvs = new Set(["node", "scripts", "python"])
	const deps = {
		mcp: {
			getAllServers: () => servers,
			toggleServerDisabled: vi.fn(async () => undefined),
			deleteServer: vi.fn(async () => undefined),
		},
		marketplace: { getCurrentItems: async () => catalog, installMarketplaceItem: vi.fn(async () => "ok") },
		skills: {
			getAllSkills: () => skills,
			deleteSkill: vi.fn(async (name: string) => {
				skills = skills.filter((skill) => skill.name !== name)
			}),
			installBundledSkills: vi.fn(async () => ["writing-plans"]),
			bundledSkillNames: async () => ["ponytail", "writing-plans"],
		},
		modes: { getCustomModes: async () => [], deleteCustomMode: vi.fn(async () => undefined) },
		environments: {
			manifest: environmentManifest,
			isInstalled: async (id: string) => installedEnvs.has(id),
			ensure: vi.fn(async (id: string) => installedEnvs.add(id)),
			remove: vi.fn(async (id: string) => void installedEnvs.delete(id)),
		},
		vscodeExtensions: {
			installed: () => [{ id: "ms-python.debugpy", name: "Python Debugger" }],
			search: vi.fn(async (query: string) => ({
				extensions: [
					{ id: "ms-python.debugpy", name: "Python Debugger" },
					{ id: `acme.${query}`, name: query, downloads: 1200 },
				],
			})),
			install: vi.fn(async () => undefined),
			uninstall: vi.fn(async () => undefined),
		},
	} satisfies ExtensionRegistryDependencies
	return { deps, registry: new ExtensionRegistry(deps) }
}

describe("ExtensionRegistry", () => {
	it.each(["skill", "mcp"] as const)(
		"refuses community %s project requests before any global installation",
		async (kind) => {
			process.env.OCTOCODE_ENVIRONMENTS = "D:/isolated-registry-fixture"
			const { deps } = fixture()
			const install = vi.fn(async () => {})
			const registry = new ExtensionRegistry({ ...deps, community: { search: async () => [], install } })
			const result = await registry.handle({ action: "install", kind, id: "community:demo", scope: "project" })
			expect(result.error).toContain("project installation is unavailable")
			expect(install).not.toHaveBeenCalled()
			expect(deps.marketplace.installMarketplaceItem).not.toHaveBeenCalled()
		},
	)
	it("refuses a bundled skill project install when it would use the global system directory", async () => {
		process.env.OCTOCODE_ENVIRONMENTS = "D:/isolated-registry-fixture"
		const { deps, registry } = fixture()
		const result = await registry.handle({
			action: "install",
			kind: "skill",
			id: "writing-plans",
			scope: "project",
		})
		expect(result.error).toContain("project installation is unavailable")
		expect(deps.skills.installBundledSkills).not.toHaveBeenCalled()
	})
	it("passes the selected role scope to its owning manager", async () => {
		const { deps, registry } = fixture()
		await registry.handle({ action: "uninstall", kind: "skill", id: "mode:demo", scope: "project" })
		expect(deps.modes.deleteCustomMode).toHaveBeenCalledWith("demo", "project")
	})
	it("preserves an explicit project scope when a shared system tools root exists", async () => {
		process.env.OCTOCODE_ENVIRONMENTS = "D:/isolated-registry-fixture"
		const { deps, registry } = fixture()
		await registry.handle({ action: "uninstall", kind: "mcp", id: "old", scope: "project" })
		expect(deps.mcp.deleteServer).toHaveBeenCalledWith("old", "project")
		await registry.handle({ action: "uninstall", kind: "skill", id: "ponytail", scope: "project" })
		expect(deps.skills.deleteSkill).not.toHaveBeenCalled()
		expect((await registry.list("skill")).find((entry) => entry.id === "ponytail")?.actions).toEqual([])
	})
	it("forwards gallery cursors and keeps installed extensions ahead of download rankings", async () => {
		const { deps } = fixture()
		const search = vi.fn(async () => ({
			nextCursor: "40",
			extensions: [
				{ id: "ms-python.debugpy", name: "duplicate", downloads: 9999 },
				{ id: "acme.popular", name: "popular", downloads: 2000 },
				{ id: "acme.low", name: "low", downloads: 1 },
			],
		}))
		const registry = new ExtensionRegistry({ ...deps, vscodeExtensions: { ...deps.vscodeExtensions, search } })
		const page = await registry.handle({
			action: "list",
			kind: "extension",
			page: "market",
			query: "python",
			cursor: "20",
		})
		expect(search).toHaveBeenCalledWith("python", "20")
		expect(page.nextCursor).toBe("40")
		expect(page.entries.map((entry) => entry.id)).toEqual(["ms-python.debugpy", "acme.popular", "acme.low"])
	})
	it("does not offer an installed npm MCP package for installation again", async () => {
		const { deps } = fixture()
		const registry = new ExtensionRegistry({
			...deps,
			mcp: {
				...deps.mcp,
				getAllServers: () => [{ name: "npm:demo", config: "{}", status: "connected", source: "global" }],
			},
			community: {
				search: async () => [],
				install: async () => {},
				searchPage: async () => ({
					entries: [
						{
							kind: "mcp",
							id: "community:npm:demo",
							name: "demo",
							scope: "global",
							installed: false,
							builtIn: false,
							actions: ["install"],
						},
					],
				}),
			},
		})
		const page = await registry.handle({ action: "list", kind: "mcp", page: "market" })
		expect(page.entries.some((entry) => entry.id === "community:npm:demo")).toBe(false)
		expect(page.entries.find((entry) => entry.id === "npm:demo")?.installed).toBe(true)
	})
	it("places installed skills first, sorts actual popularity and groups agent roles as skills", async () => {
		const { deps } = fixture()
		const registry = new ExtensionRegistry({
			...deps,
			community: {
				search: async () => [],
				install: async () => {},
				searchPage: async () => ({
					nextCursor: "next",
					entries: [
						{
							kind: "skill",
							id: "low",
							name: "low",
							scope: "global",
							installed: false,
							builtIn: false,
							actions: ["install"],
							rank: 1,
						},
						{
							kind: "skill",
							id: "high",
							name: "high",
							scope: "global",
							installed: false,
							builtIn: false,
							actions: ["install"],
							rank: 99,
						},
					],
				}),
			},
		})
		const result = await registry.handle({ action: "list", kind: "skill", page: "market" })
		expect(result.entries[0].installed).toBe(true)
		expect(result.entries.filter((entry) => entry.rank !== undefined).map((entry) => entry.id)).toEqual([
			"high",
			"low",
		])
		expect(result.entries.find((entry) => entry.id === "mode:auto-research")).toMatchObject({
			kind: "skill",
			actions: ["install"],
		})
		expect(result.nextCursor).toBe("next")
		await registry.handle({ action: "install", kind: "skill", id: "mode:auto-research" })
		expect(deps.marketplace.installMarketplaceItem).toHaveBeenCalledWith(
			expect.objectContaining({ type: "mode" }),
			{ target: "global" },
		)
	})
	let savedEnvironments: string | undefined

	beforeEach(() => {
		// The system tool directory redirects skill actions to "global"; this
		// machine sets OCTOCODE_ENVIRONMENTS, so it is cleared to exercise the
		// portable per-source scoping these fixtures describe.
		savedEnvironments = process.env.OCTOCODE_ENVIRONMENTS
		delete process.env.OCTOCODE_ENVIRONMENTS
	})

	afterEach(() => {
		if (savedEnvironments !== undefined) process.env.OCTOCODE_ENVIRONMENTS = savedEnvironments
		else delete process.env.OCTOCODE_ENVIRONMENTS
	})

	it("keeps installed tools available offline and returns the request identity", async () => {
		const { deps } = fixture()
		const search = vi.fn(async () => {
			throw new Error("offline")
		})
		const registry = new ExtensionRegistry({ ...deps, community: { search, install: async () => undefined } })
		const result = await registry.handle({
			action: "list",
			kind: "mcp",
			page: "installed",
			query: "wiki",
			requestId: "installed-1",
		})
		expect(search).not.toHaveBeenCalled()
		expect(result.requestId).toBe("installed-1")
		expect(result.error).toBeUndefined()
		expect(result.entries.every((entry) => entry.installed)).toBe(true)
		const market = await registry.handle({ action: "list", kind: "mcp", page: "market", requestId: "market-2" })
		expect(market.error).toBe("offline")
		expect(market.entries.some((entry) => entry.id === "scrapling")).toBe(true)
	})
	it("lists installed servers with their switch and the catalog entries not yet installed", async () => {
		const { registry } = fixture()
		const mcp = await registry.list("mcp")
		expect(mcp.map((e) => [e.id, e.installed, e.actions])).toEqual([
			["scrapling", true, ["disable", "uninstall"]],
			["old", true, ["enable", "uninstall"]],
			["llm-wiki", false, ["install"]],
		])
	})

	it("routes every action to the manager that owns the kind", async () => {
		const { deps, registry } = fixture()
		await registry.handle({ action: "disable", kind: "mcp", id: "scrapling", scope: "global" })
		expect(deps.mcp.toggleServerDisabled).toHaveBeenCalledWith("scrapling", true, "global")
		await registry.handle({ action: "install", kind: "mcp", id: "llm-wiki" })
		expect(deps.marketplace.installMarketplaceItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: "llm-wiki" }),
			{ target: "global" },
		)
		const afterUninstall = await registry.handle({ action: "uninstall", kind: "skill", id: "ponytail" })
		expect(deps.skills.deleteSkill).toHaveBeenCalledWith("ponytail", "project", undefined)
		expect(afterUninstall.entries.find((e) => e.id === "ponytail")).toMatchObject({
			installed: false,
			actions: ["install"],
		})
		await registry.handle({ action: "install", kind: "environment", id: "go" })
		expect(deps.environments.ensure).toHaveBeenCalledWith("go")
	})

	it("reports refused actions instead of throwing, and never removes the core", async () => {
		const { deps, registry } = fixture()
		const result = await registry.handle({ action: "uninstall", kind: "environment", id: "node" })
		expect(result.error).toContain("base installation")
		expect(deps.environments.remove).not.toHaveBeenCalled()
		const node = result.entries.find((e) => e.id === "node")
		expect(node).toMatchObject({ builtIn: true, installed: true, actions: [] })
		// Python ships with the product and hosts the bundled MCP servers.
		expect(result.entries.find((e) => e.id === "python")).toMatchObject({ builtIn: true, actions: [] })
		expect((await registry.handle({ action: "uninstall", kind: "environment", id: "python" })).error).toContain(
			"base installation",
		)
		expect((await registry.handle({ action: "install", kind: "skill", id: "nope" })).error).toContain(
			"Unknown bundled skill",
		)
	})

	it("lists every kind in one call", async () => {
		const { registry } = fixture()
		const kinds = new Set((await registry.list()).map((e) => e.kind))
		expect([...kinds].sort()).toEqual(["environment", "extension", "mcp", "mode", "skill"])
	})

	it("lists VS Code extensions in place, searching the gallery only when asked", async () => {
		const { deps, registry } = fixture()
		expect((await registry.list("extension")).map((e) => [e.id, e.actions])).toEqual([
			["ms-python.debugpy", ["uninstall"]],
		])
		expect(deps.vscodeExtensions.search).not.toHaveBeenCalled()
		const found = await registry.handle({ action: "list", kind: "extension", query: "rust" })
		expect(found.entries.map((e) => [e.id, e.installed])).toEqual([
			["ms-python.debugpy", true],
			["acme.rust", false],
		])
		await registry.handle({ action: "install", kind: "extension", id: "acme.rust" })
		expect(deps.vscodeExtensions.install).toHaveBeenCalledWith("acme.rust")
		await registry.handle({ action: "uninstall", kind: "extension", id: "ms-python.debugpy" })
		expect(deps.vscodeExtensions.uninstall).toHaveBeenCalledWith("ms-python.debugpy")
	})
})
