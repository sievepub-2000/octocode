import * as path from "node:path"
import { mkdir, realpath, stat } from "node:fs/promises"

export type ToolHubKind = "mcp" | "skill" | "mode" | "vscode" | "environment"

export type ToolHubItem = {
	kind: ToolHubKind
	name: string
	description?: string
	server?: string
	source?: "global" | "project"
	access?: "read"
	/** MCP tools: argument names (required ones end in "*"), so a call does not have to guess them. */
	parameters?: string[]
}

export type ToolHubSearchFilter = { kind?: string; server?: string; limit?: number }

const SEARCH_LIMIT = 25

export type ToolHubMcpServer = {
	name: string
	config?: string
	source?: "global" | "project"
	tools?: readonly {
		name: string
		description?: string
		inputSchema?: { properties?: Record<string, unknown>; required?: readonly string[] }
		annotations?: { readOnlyHint?: boolean }
	}[]
}

export function isTrustedLocalMcpServer(server: ToolHubMcpServer, trustedRoots: readonly string[]): boolean {
	if (server.source !== "global" || !server.config) return false

	try {
		const config = JSON.parse(server.config) as { command?: unknown }
		if (typeof config.command !== "string") return false
		const commandPath = path.resolve(config.command)
		return trustedRoots.some((root) => {
			const relative = path.relative(path.resolve(root), commandPath)
			return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
		})
	} catch {
		return false
	}
}

export type ToolHubMcpHub = {
	getServers(): readonly ToolHubMcpServer[]
	callTool(
		server: string,
		tool: string,
		arguments_: Record<string, unknown> | undefined,
		source: "global" | "project" | undefined,
	): Promise<unknown>
}

export type ToolHubSkill = {
	name: string
	description?: string
	source: "global" | "project"
	mode?: string
	modeSlugs?: readonly string[]
}

export type ToolHubSkillsManager = {
	getAllSkills(): readonly ToolHubSkill[]
	getSkillContent(name: string, mode?: string, source?: "global" | "project"): Promise<unknown | null>
}

export type ToolHubMode = {
	slug: string
	name: string
	source?: "global" | "project"
}

export type ToolHubNativeTool = {
	name: string
	description?: string
}

export type ToolHubEnvironment = { id: string; label: string; purpose: string; installed: boolean }

export type ToolHubDependencies = {
	getMcpHub: () => ToolHubMcpHub | undefined
	getSkillsManager: () => ToolHubSkillsManager | undefined
	getModes: () => Promise<readonly ToolHubMode[]>
	getNativeTools: () => readonly ToolHubNativeTool[]
	invokeNativeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>
	/** Only local installation metadata or an explicit allowlist may mark an MCP server trusted. */
	isTrustedMcpServer?: (server: ToolHubMcpServer) => boolean
	/** Runtime environments (toolchains) the agent can discover and provision on demand. */
	getEnvironments?: () => Promise<readonly ToolHubEnvironment[]>
	provisionEnvironment?: (id: string) => Promise<unknown>
}

export type ToolHubStatus = Record<ToolHubKind, number>

export type ToolHubInvokeRequest =
	| {
			kind: "mcp"
			name: string
			server: string
			source?: "global" | "project"
			arguments?: Record<string, unknown>
	  }
	| { kind: "skill"; name: string; source: "global" | "project"; mode?: string }
	| { kind: "mode"; name: string }
	| { kind: "vscode"; name: string; arguments?: Record<string, unknown> }
	| { kind: "environment"; name: string }

export type ToolHubTask = {
	permissionProfile?: PermissionProfile
	readOnly?: boolean
	workingDirectory?: string
	workspaceRoot?: string
}

export type ToolHub = {
	search(query?: string, filter?: ToolHubSearchFilter): Promise<ToolHubItem[]>
	status(): Promise<ToolHubStatus>
	invoke(request: ToolHubInvokeRequest, task?: ToolHubTask): Promise<unknown>
}

async function hasProjectMarker(root: string): Promise<boolean> {
	for (const marker of [".git", ".svn", ".code-review-graph"]) {
		if (await stat(path.join(root, marker)).catch(() => undefined)) return true
	}
	return false
}

function parameterNames(schema?: { properties?: Record<string, unknown>; required?: readonly string[] }): {
	parameters?: string[]
} {
	const names = Object.keys(schema?.properties ?? {})
	if (names.length === 0) return {}
	const required = new Set(schema?.required ?? [])
	return { parameters: names.map((name) => (required.has(name) ? `${name}*` : name)) }
}

/**
 * Filter by kind/server, then match the query word by word. Items containing
 * every word come first; otherwise items are ranked by how many words they
 * contain. A kind filter with no match lists that whole kind, so "what
 * environments exist?" never comes back empty. Matching the query as one
 * substring made most multi-word searches return nothing.
 */
export function rankTools(
	items: ToolHubItem[],
	query: string | undefined,
	filter: ToolHubSearchFilter = {},
): ToolHubItem[] {
	const scoped = items.filter(
		(tool) => (!filter.kind || tool.kind === filter.kind) && (!filter.server || tool.server === filter.server),
	)
	const limit = filter.limit ?? SEARCH_LIMIT
	const words = (query ?? "")
		.toLowerCase()
		.split(/[\s,;|/]+/)
		.filter(Boolean)
	if (words.length === 0) return scoped.slice(0, limit)
	const scored = scoped
		.map((tool) => {
			const text = `${tool.name} ${tool.description ?? ""} ${tool.server ?? ""}`.toLowerCase()
			return { tool, hits: words.filter((word) => text.includes(word)).length }
		})
		.filter(({ hits }) => hits > 0)
	const all = scored.filter(({ hits }) => hits === words.length)
	const ranked = all.length > 0 ? all : scored.sort((a, b) => b.hits - a.hits)
	if (ranked.length === 0) return filter.kind || filter.server ? scoped.slice(0, limit) : []
	return ranked.slice(0, limit).map(({ tool }) => tool)
}

export function createToolHub({
	getMcpHub,
	getSkillsManager,
	getModes,
	getNativeTools,
	invokeNativeTool,
	isTrustedMcpServer,
	getEnvironments,
	provisionEnvironment,
}: ToolHubDependencies): ToolHub {
	const catalog = async (): Promise<ToolHubItem[]> => {
		const mcp = (getMcpHub()?.getServers() ?? []).flatMap((server) =>
			(server.tools ?? []).map((tool) => ({
				kind: "mcp" as const,
				name: tool.name,
				description: tool.description,
				server: server.name,
				source: server.source,
				...(tool.annotations?.readOnlyHint && isTrustedMcpServer?.(server) ? { access: "read" as const } : {}),
				...parameterNames(tool.inputSchema),
			})),
		)
		const skills = (getSkillsManager()?.getAllSkills() ?? []).map((skill) => ({
			kind: "skill" as const,
			name: skill.name,
			description: skill.description,
			source: skill.source,
			...(skill.mode !== undefined ? { mode: skill.mode } : {}),
		}))
		const modes = (await getModes()).map((mode) => ({
			kind: "mode" as const,
			name: mode.slug,
			description: mode.name,
			source: mode.source,
		}))
		const nativeTools = getNativeTools().map((tool) => ({
			kind: "vscode" as const,
			name: tool.name,
			description: tool.description,
		}))
		const environments = ((await getEnvironments?.()) ?? []).map((env) => ({
			kind: "environment" as const,
			name: env.id,
			description: `${env.label} (${env.installed ? "installed" : "not installed; invoke to install"}): ${env.purpose}`,
		}))
		return [...mcp, ...skills, ...modes, ...nativeTools, ...environments]
	}
	const search = async (query?: string, filter: ToolHubSearchFilter = {}): Promise<ToolHubItem[]> =>
		rankTools(await catalog(), query, filter)
	return {
		search,
		async status(): Promise<ToolHubStatus> {
			return (await catalog()).reduce<ToolHubStatus>(
				(status, tool) => ({ ...status, [tool.kind]: status[tool.kind] + 1 }),
				{ mcp: 0, skill: 0, mode: 0, vscode: 0, environment: 0 },
			)
		},
		async invoke(request: ToolHubInvokeRequest, task?: ToolHubTask): Promise<unknown> {
			if (request.kind === "vscode") {
				if (task?.permissionProfile !== "full" || task?.readOnly) {
					throw new Error("OctoCode permission profile does not allow tools.invoke")
				}
				if (!getNativeTools().some((tool) => tool.name === request.name)) {
					throw new Error(`Unknown VS Code tool: ${request.name}`)
				}
				return invokeNativeTool(request.name, request.arguments ?? {})
			}
			if (request.kind === "environment") {
				if (task?.permissionProfile !== "full" || task?.readOnly) {
					throw new Error("OctoCode permission profile does not allow installing environments")
				}
				const known = (await getEnvironments?.()) ?? []
				if (!provisionEnvironment || !known.some((env) => env.id === request.name)) {
					throw new Error(`Unknown environment: ${request.name}`)
				}
				return provisionEnvironment(request.name)
			}
			if (request.kind === "mode") {
				if (!(await getModes()).some((mode) => mode.slug === request.name)) {
					throw new Error(`Unknown AgentMode: ${request.name}`)
				}
				throw new Error("AgentModes cannot be invoked")
			}
			if (request.kind === "skill") {
				const skillsManager = getSkillsManager()
				const matches =
					skillsManager
						?.getAllSkills()
						.filter(
							(skill) =>
								skill.name === request.name &&
								skill.source === request.source &&
								(request.mode === undefined
									? skill.mode === undefined && !(skill.modeSlugs?.length ?? 0)
									: skill.mode === request.mode || skill.modeSlugs?.includes(request.mode)),
						) ?? []
				if (matches.length === 0)
					throw new Error(`Unknown skill: ${request.source}:${request.mode ?? "generic"}:${request.name}`)
				if (matches.length > 1)
					throw new Error(`Ambiguous skill: ${request.source}:${request.mode ?? "generic"}:${request.name}`)
				const skill = await skillsManager!.getSkillContent(request.name, request.mode, request.source)
				if (!skill) throw new Error(`Unknown skill: ${request.name}`)
				return skill
			}
			const mcpHub = getMcpHub()
			const server = mcpHub
				?.getServers()
				.find(
					(candidate) =>
						candidate.name === request.server && (!request.source || candidate.source === request.source),
				)
			const tool = server?.tools?.find((candidate) => candidate.name === request.name)
			if (!mcpHub || !server || !tool) {
				// Name the server that does have the tool: agents often pass the hub's own name as server.
				const owners = (mcpHub?.getServers() ?? [])
					.filter((candidate) => candidate.tools?.some((t) => t.name === request.name))
					.map((candidate) => candidate.name)
				throw new Error(
					`Unknown MCP tool: ${request.server}/${request.name}.` +
						(owners.length > 0
							? ` "${request.name}" is on server ${owners.map((o) => `"${o}"`).join(", ")}; call it with that server.`
							: ` Use action "search" with kind "mcp" to list servers and tools.`),
				)
			}
			if (
				(task?.permissionProfile !== "full" || task?.readOnly) &&
				!(tool.annotations?.readOnlyHint && isTrustedMcpServer?.(server))
			) {
				throw new Error("OctoCode permission profile does not allow tools.invoke")
			}
			let args = request.arguments
			if (task?.workingDirectory && tool.inputSchema?.properties && "repo_root" in tool.inputSchema.properties) {
				const configured = server.config ? (JSON.parse(server.config) as { args?: unknown[] }) : undefined
				if (isTrustedMcpServer?.(server) && configured?.args?.includes("code_review_graph")) {
					const requested = args?.repo_root
					if (requested !== undefined && requested !== null && typeof requested !== "string")
						throw new Error("repo_root must be a directory path")
					const root = await realpath(
						path.resolve(
							task.workingDirectory,
							typeof requested === "string" && requested ? requested : ".",
						),
					)
					const workspace = await realpath(task.workspaceRoot ?? task.workingDirectory)
					const relative = path.relative(workspace, root)
					if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
						throw new Error("Code graph root is outside the task workspace")
					// code-review-graph refuses a root without .git/.svn/.code-review-graph. The root is
					// already confined to the workspace, so mark it instead of making the agent `git init`.
					if (!(await hasProjectMarker(root))) {
						if (task.permissionProfile !== "full" || task.readOnly)
							throw new Error(
								"Code graph root has no project marker; creating one requires full permission",
							)
						await mkdir(path.join(root, ".code-review-graph"), { recursive: true })
					}
					args = { ...args, repo_root: root }
				}
			}
			return mcpHub.callTool(server.name, request.name, args, request.source ?? server.source)
		},
	}
}
import type { PermissionProfile } from "@roo-code/types"
