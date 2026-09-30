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
			search: vi.fn(async (query: string) => [
				{ id: "ms-python.debugpy", name: "Python Debugger" },
				{ id: `acme.${query}`, name: query, downloads: 1200 },
			]),
			install: vi.fn(async () => undefined),
			uninstall: vi.fn(async () => undefined),
		},
	} satisfies ExtensionRegistryDependencies
	return { deps, registry: new ExtensionRegistry(deps) }
}

describe("ExtensionRegistry", () => {
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
