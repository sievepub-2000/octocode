import type {
	ExtensionEntry,
	ExtensionKind,
	ExtensionRequest,
	ExtensionResult,
	MarketplaceItem,
	McpServer,
	ModeConfig,
} from "@roo-code/types"

import type { EnvironmentDescriptor } from "../environments/manifest"
import { getSystemToolDirectory } from "../environments/tools"

export type GallerySearchPage = {
	extensions: { id: string; name: string; description?: string; downloads?: number }[]
	nextCursor?: string
}

/**
 * The single facade over the managers that own each extension kind.
 *
 * It holds no state and duplicates no logic: every operation is delegated to the
 * manager that already implements it (McpHub, MarketplaceManager, SkillsManager,
 * CustomModesManager, EnvironmentProvisioner). Its job is the shared contract —
 * one entry shape, one action set — so the UI, the agent and the daemon all see
 * the same thing.
 */
export type ExtensionRegistryDependencies = {
	mcp?: {
		getAllServers(): McpServer[]
		toggleServerDisabled(name: string, disabled: boolean, source?: "global" | "project"): Promise<void>
		deleteServer(name: string, source?: "global" | "project"): Promise<void>
	}
	marketplace?: {
		getCurrentItems(): Promise<MarketplaceItem[]>
		installMarketplaceItem(item: MarketplaceItem, options?: { target?: "global" | "project" }): Promise<unknown>
	}
	skills?: {
		getAllSkills(): { name: string; description?: string; source: "global" | "project"; mode?: string }[]
		deleteSkill(name: string, source: "global" | "project", mode?: string): Promise<void>
		installBundledSkills(name?: string): Promise<string[]>
		bundledSkillNames(): Promise<string[]>
	}
	modes?: {
		getCustomModes(): Promise<ModeConfig[]>
		deleteCustomMode(slug: string, source?: "global" | "project"): Promise<void>
	}
	vscodeExtensions?: {
		/** Installed, non-built-in VS Code extensions. */
		installed(): { id: string; name: string; description?: string }[]
		search(query: string, cursor?: string): Promise<GallerySearchPage>
		install(id: string): Promise<void>
		uninstall(id: string): Promise<void>
	}
	environments?: {
		manifest: readonly EnvironmentDescriptor[]
		isInstalled(id: string): Promise<boolean>
		ensure(id: string): Promise<unknown>
		remove(id: string): Promise<void>
	}
	community?: {
		search(kind: "skill" | "mcp", query: string): Promise<ExtensionEntry[]>
		searchPage?(kind: "skill" | "mcp", query: string, cursor?: string): Promise<ExtensionResult>
		install(kind: "skill" | "mcp", id: string): Promise<void>
	}
}

export class ExtensionRegistry {
	constructor(private readonly deps: ExtensionRegistryDependencies) {}

	async list(kind?: ExtensionKind, query?: string): Promise<ExtensionEntry[]> {
		const kinds: ExtensionKind[] = kind ? [kind] : ["mcp", "skill", "mode", "environment", "extension"]
		const lists = await Promise.all(kinds.map((k) => this.listKind(k, query)))
		return lists.flat()
	}

	async handle(request: ExtensionRequest): Promise<ExtensionResult> {
		try {
			if (request.action !== "list") await this.apply(request)
			if (request.kind === "extension") {
				const page = await this.listVscodeExtensions(
					request.page === "installed"
						? undefined
						: request.page === "market"
							? (request.query ?? "")
							: request.query,
					request.cursor,
				)
				page.entries = page.entries.filter((entry) => request.page !== "installed" || entry.installed)
				page.entries.sort(
					(a, b) => Number(b.installed) - Number(a.installed) || (b.rank ?? -1) - (a.rank ?? -1),
				)
				return { ...page, requestId: request.requestId }
			}
			let entries = await this.list(
				request.kind,
				request.page === "installed"
					? undefined
					: request.page === "market"
						? (request.query ?? "")
						: request.query,
			)
			if (
				request.page === "market" &&
				(request.kind === "skill" || request.kind === "mcp") &&
				this.deps.community
			) {
				const page = this.deps.community.searchPage
					? await this.deps.community.searchPage(request.kind, request.query ?? "", request.cursor)
					: { entries: await this.deps.community.search(request.kind, request.query ?? "") }
				const installed = new Set(
					entries.filter((entry) => entry.installed).flatMap((entry) => [entry.name, entry.id]),
				)
				entries = [
					...entries,
					...page.entries.filter(
						(entry) => !installed.has(entry.name) && !installed.has(entry.id.replace(/^community:/, "")),
					),
				]
				entries.sort((a, b) => Number(b.installed) - Number(a.installed) || (b.rank ?? -1) - (a.rank ?? -1))
				return { entries, requestId: request.requestId, nextCursor: page.nextCursor }
			}
			if (request.page === "installed") entries = entries.filter((entry) => entry.installed)
			return { entries, requestId: request.requestId }
		} catch (error) {
			return {
				entries: await this.list(request.kind).catch(() => []),
				requestId: request.requestId,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	private async listKind(kind: ExtensionKind, query?: string): Promise<ExtensionEntry[]> {
		switch (kind) {
			case "extension":
				return (await this.listVscodeExtensions(query)).entries
			case "mcp":
				return this.listMcp()
			case "skill":
				return this.listSkills()
			case "mode":
				return this.listModes()
			case "environment":
				return this.listEnvironments()
		}
	}

	private async listMcp(): Promise<ExtensionEntry[]> {
		const servers = this.deps.mcp?.getAllServers() ?? []
		const installed = servers.map<ExtensionEntry>((server) => ({
			kind: "mcp",
			id: server.name,
			name: server.name,
			scope: server.source ?? "global",
			installed: true,
			enabled: !server.disabled,
			builtIn: false,
			actions: [server.disabled ? "enable" : "disable", "uninstall"],
			detail: server.disabled ? undefined : server.status,
		}))
		const names = new Set(servers.map((server) => server.name))
		const catalog = (await this.catalog("mcp"))
			.filter((item) => !names.has(item.id))
			.map<ExtensionEntry>((item) => ({
				kind: "mcp",
				id: item.id,
				name: item.name,
				description: item.description,
				scope: "global",
				installed: false,
				builtIn: false,
				actions: ["install"],
			}))
		return [...installed, ...catalog]
	}

	private async listSkills(): Promise<ExtensionEntry[]> {
		const skills = this.deps.skills?.getAllSkills() ?? []
		const bundled = new Set((await this.deps.skills?.bundledSkillNames()) ?? [])
		const installed = skills.map<ExtensionEntry>((skill) => ({
			kind: "skill",
			id: skill.mode ? `${skill.mode}/${skill.name}` : skill.name,
			name: skill.name,
			description: skill.description,
			scope: skill.source,
			installed: true,
			builtIn: bundled.has(skill.name),
			actions: getSystemToolDirectory("skills") && skill.source === "project" ? [] : ["uninstall"],
			detail:
				getSystemToolDirectory("skills") && skill.source === "project"
					? "Project skill: manage in its project directory"
					: undefined,
		}))
		const present = new Set(skills.map((skill) => skill.name))
		const missing = [...bundled]
			.filter((name) => !present.has(name))
			.map<ExtensionEntry>((name) => ({
				kind: "skill",
				id: name,
				name,
				scope: getSystemToolDirectory("skills") ? "global" : "project",
				installed: false,
				builtIn: true,
				actions: ["install"],
			}))
		const roles = (await this.listModes()).map<ExtensionEntry>((role) => ({
			...role,
			kind: "skill",
			id: `mode:${role.id}`,
			detail: "Agent role",
		}))
		return [...installed, ...missing, ...roles]
	}

	private async listModes(): Promise<ExtensionEntry[]> {
		const modes = (await this.deps.modes?.getCustomModes()) ?? []
		const installed = modes.map<ExtensionEntry>((mode) => ({
			kind: "mode",
			id: mode.slug,
			name: mode.name,
			description: mode.description,
			scope: mode.source ?? "global",
			installed: true,
			builtIn: false,
			actions: ["uninstall"],
		}))
		const slugs = new Set(modes.map((mode) => mode.slug))
		const catalog = (await this.catalog("mode"))
			.filter((item) => !slugs.has(item.id))
			.map<ExtensionEntry>((item) => ({
				kind: "mode",
				id: item.id,
				name: item.name,
				description: item.description,
				scope: "global",
				installed: false,
				builtIn: false,
				actions: ["install"],
			}))
		return [...installed, ...catalog]
	}

	private async listEnvironments(): Promise<ExtensionEntry[]> {
		const environments = this.deps.environments
		if (!environments) return []
		return Promise.all(
			environments.manifest.map(async (env) => {
				const installed = await environments.isInstalled(env.id)
				// Shipped environments carry product dependencies (Python hosts the
				// bundled MCP servers); removing one breaks them, so only on-demand
				// toolchains can be uninstalled.
				const core = env.tier === "core" || env.shipped
				return {
					kind: "environment",
					id: env.id,
					name: env.label,
					description: env.purpose,
					scope: "system",
					installed,
					builtIn: core,
					actions: core ? [] : installed ? ["uninstall"] : ["install"],
					detail: installed ? undefined : `~${env.approxSizeMb} MB`,
				} satisfies ExtensionEntry
			}),
		)
	}

	private async listVscodeExtensions(query?: string, cursor?: string): Promise<ExtensionResult> {
		const source = this.deps.vscodeExtensions
		if (!source) return { entries: [] }
		const installed = source.installed()
		const ids = new Set(installed.map((extension) => extension.id.toLowerCase()))
		const page = query !== undefined ? await source.search(query.trim(), cursor) : undefined
		const found = page?.extensions ?? []
		return {
			nextCursor: page?.nextCursor,
			entries: [
				...installed.map<ExtensionEntry>((extension) => ({
					kind: "extension",
					id: extension.id,
					name: extension.name,
					description: extension.description,
					scope: "global",
					installed: true,
					builtIn: false,
					actions: ["uninstall"],
				})),
				...found
					.filter((extension) => !ids.has(extension.id.toLowerCase()))
					.map<ExtensionEntry>((extension) => ({
						kind: "extension",
						id: extension.id,
						name: extension.name,
						description: extension.description,
						rank: extension.downloads,
						scope: "global",
						installed: false,
						builtIn: false,
						actions: ["install"],
						detail:
							extension.downloads !== undefined
								? `${extension.downloads.toLocaleString()} downloads`
								: undefined,
					})),
			],
		}
	}

	private async catalog(type: "mcp" | "mode"): Promise<MarketplaceItem[]> {
		return ((await this.deps.marketplace?.getCurrentItems()) ?? []).filter((item) => item.type === type)
	}

	private async apply(request: Exclude<ExtensionRequest, { action: "list" }>): Promise<void> {
		const { action, kind, id, scope: requestedScope } = request
		if (kind === "skill" && id.startsWith("mode:")) {
			return this.apply({ ...request, kind: "mode", id: id.slice("mode:".length) })
		}
		const scope =
			requestedScope ??
			((kind === "skill" || kind === "mcp") && getSystemToolDirectory(kind === "skill" ? "skills" : "mcp")
				? "global"
				: undefined)
		if (action === "install" && id.startsWith("community:") && (kind === "skill" || kind === "mcp")) {
			if (requestedScope === "project")
				throw new Error(
					"Community components use the global system tools directory; project installation is unavailable.",
				)
			if (!this.deps.community) throw new Error("Community marketplace is unavailable")
			return this.deps.community.install(kind, id.slice("community:".length))
		}
		const unsupported = () => new Error(`${action} is not available for ${kind} "${id}"`)
		switch (kind) {
			case "mcp": {
				const mcp = this.deps.mcp
				if (action === "install") {
					const item = (await this.catalog("mcp")).find((candidate) => candidate.id === id)
					if (!item || !this.deps.marketplace) throw new Error(`Unknown MCP server in the catalog: ${id}`)
					await this.deps.marketplace.installMarketplaceItem(item, { target: scope ?? "global" })
					return
				}
				if (!mcp) throw unsupported()
				if (action === "uninstall") return mcp.deleteServer(id, scope)
				return mcp.toggleServerDisabled(id, action === "disable", scope)
			}
			case "skill": {
				const skills = this.deps.skills
				if (!skills) throw unsupported()
				if (action === "install") {
					if (requestedScope === "project" && getSystemToolDirectory("skills"))
						throw new Error(
							"Bundled skills use the global system tools directory; project installation is unavailable.",
						)
					if (!(await skills.bundledSkillNames()).includes(id))
						throw new Error(`Unknown bundled skill: ${id}`)
					await skills.installBundledSkills(id)
					return
				}
				if (action !== "uninstall") throw unsupported()
				if (requestedScope === "project" && getSystemToolDirectory("skills"))
					throw new Error("Project skills must be managed in their project directory in shared tools mode.")
				const [mode, name] = id.includes("/") ? id.split("/", 2) : [undefined, id]
				const match = skills
					.getAllSkills()
					.find((skill) => skill.name === name && skill.mode === mode && (!scope || skill.source === scope))
				if (!match) throw new Error(`Unknown skill: ${id}`)
				return skills.deleteSkill(match.name, match.source, match.mode)
			}
			case "mode": {
				if (action === "install") {
					const item = (await this.catalog("mode")).find((candidate) => candidate.id === id)
					if (!item || !this.deps.marketplace) throw new Error(`Unknown mode in the catalog: ${id}`)
					await this.deps.marketplace.installMarketplaceItem(item, { target: scope ?? "global" })
					return
				}
				if (action !== "uninstall" || !this.deps.modes) throw unsupported()
				return this.deps.modes.deleteCustomMode(id, scope)
			}
			case "extension": {
				const source = this.deps.vscodeExtensions
				if (!source) throw unsupported()
				if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i.test(id) || id.toLowerCase() === "octocode.octocode")
					throw unsupported()
				if (action === "install") return source.install(id)
				if (
					action === "uninstall" &&
					source.installed().some((entry) => entry.id.toLowerCase() === id.toLowerCase())
				)
					return source.uninstall(id)
				throw unsupported()
			}
			case "environment": {
				const environments = this.deps.environments
				const env = environments?.manifest.find((candidate) => candidate.id === id)
				if (!environments || !env) throw new Error(`Unknown environment: ${id}`)
				if (env.tier === "core" || env.shipped) throw new Error(`${env.label} is part of the base installation`)
				if (action === "install") {
					await environments.ensure(id)
					return
				}
				if (action === "uninstall") return environments.remove(id)
				throw unsupported()
			}
		}
	}
}
