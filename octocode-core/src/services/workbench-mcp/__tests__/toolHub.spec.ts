import { describe, expect, it, vi } from "vitest"
import * as toolHub from "../toolHub"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

describe("tool hub", () => {
	it("binds graph calls to the task directory and rejects workspace escapes", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "octocode-graph-root-"))
		try {
			const cwd = path.join(workspace, "session")
			await mkdir(cwd)
			const callTool = vi.fn().mockResolvedValue({ status: "ok" })
			const server = {
				name: "code-graph",
				source: "global" as const,
				config: JSON.stringify({ args: ["-m", "code_review_graph", "serve"] }),
				tools: [
					{
						name: "traverse_graph",
						inputSchema: { properties: { repo_root: {} } },
						annotations: { readOnlyHint: true },
					},
				],
			}
			const hub = toolHub.createToolHub({
				getMcpHub: () => ({ getServers: () => [server], callTool }),
				getSkillsManager: () => undefined,
				getModes: async () => [],
				getNativeTools: () => [],
				invokeNativeTool: vi.fn(),
				isTrustedMcpServer: () => true,
			})
			const request = {
				kind: "mcp" as const,
				name: "traverse_graph",
				server: "code-graph",
				arguments: { query: "symbol" },
			}
			const task = { permissionProfile: "review" as const, workingDirectory: cwd, workspaceRoot: workspace }
			await expect(hub.invoke(request, task)).rejects.toThrow("creating one requires full permission")
			await mkdir(path.join(cwd, ".code-review-graph"))
			await hub.invoke(request, task)
			expect(callTool).toHaveBeenLastCalledWith(
				"code-graph",
				"traverse_graph",
				{ query: "symbol", repo_root: await realpath(cwd) },
				"global",
			)
			await expect(hub.invoke({ ...request, arguments: { repo_root: "../.." } }, task)).rejects.toThrow("outside")
			expect(callTool).toHaveBeenCalledTimes(1)
		} finally {
			await rm(workspace, { recursive: true, force: true })
		}
	})

	it("trusts only global MCP servers whose executable is under an explicit local root", () => {
		const trustedRoot = "D:/Program Files/OctoCode/environments"
		const trustedServer = {
			name: "renamed-server",
			source: "global" as const,
			config: JSON.stringify({ command: `${trustedRoot}/python/python.exe` }),
		}

		expect(toolHub.isTrustedLocalMcpServer(trustedServer, [trustedRoot])).toBe(true)
		expect(toolHub.isTrustedLocalMcpServer({ ...trustedServer, source: "project" }, [trustedRoot])).toBe(false)
		expect(
			toolHub.isTrustedLocalMcpServer(
				{ ...trustedServer, config: JSON.stringify({ command: "D:/tmp/python.exe" }) },
				[trustedRoot],
			),
		).toBe(false)
	})

	it("reads MCP services from the live getter on every case-insensitive search", async () => {
		let servers: toolHub.ToolHubMcpServer[] = [
			{ name: "git", source: "project", tools: [{ name: "log", description: "Read history" }] },
		]
		const createToolHub = (
			toolHub as { createToolHub?: (dependencies: unknown) => { search(query?: string): Promise<unknown> } }
		).createToolHub
		const hub = createToolHub?.({
			getMcpHub: () => ({ getServers: () => servers }),
			getSkillsManager: () => undefined,
			getModes: vi.fn().mockResolvedValue([]),
			getNativeTools: () => [],
			invokeNativeTool: vi.fn(),
		})

		expect(await hub?.search("GIT")).toEqual([
			{ kind: "mcp", name: "log", description: "Read history", server: "git", source: "project" },
		])

		servers = [
			...servers,
			{ name: "weather", source: "global" as const, tools: [{ name: "forecast", description: "Read forecast" }] },
		]

		expect(await hub?.search("FORECAST")).toEqual([
			{ kind: "mcp", name: "forecast", description: "Read forecast", server: "weather", source: "global" },
		])
	})

	it("reads skills from the live getter", async () => {
		let skills: toolHub.ToolHubSkill[] = [
			{ name: "deploy", description: "Deploy the active service", source: "global" },
		]
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => ({ getAllSkills: () => skills }),
			getModes: async () => [],
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies)

		expect(await hub.search("DEPLOY")).toEqual([
			{ kind: "skill", name: "deploy", description: "Deploy the active service", source: "global" },
		])

		skills = [{ name: "diagnose", description: "Diagnose the active service", source: "project" as const }]

		expect(await hub.search("diagnose")).toEqual([
			{ kind: "skill", name: "diagnose", description: "Diagnose the active service", source: "project" },
		])
	})

	it("reads default and custom AgentModes from the live getter", async () => {
		let modes: toolHub.ToolHubMode[] = [{ slug: "review", name: "Code Review", source: "global" }]
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => undefined,
			getModes: async () => modes,
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies)

		expect(await hub.search("CODE REVIEW")).toEqual([
			{ kind: "mode", name: "review", description: "Code Review", source: "global" },
		])

		modes = [{ slug: "plan", name: "Plan", source: "project" as const }]

		expect(await hub.search("plan")).toEqual([
			{ kind: "mode", name: "plan", description: "Plan", source: "project" },
		])
	})

	it("reads native VS Code tools from the live getter", async () => {
		let tools: toolHub.ToolHubNativeTool[] = [{ name: "vscode.open", description: "Open a VS Code file" }]
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => tools,
		} as unknown as toolHub.ToolHubDependencies)

		expect(await hub.search("VSCODE.OPEN")).toEqual([
			{ kind: "vscode", name: "vscode.open", description: "Open a VS Code file" },
		])

		tools = [{ name: "vscode.find", description: "Find a VS Code symbol" }]

		expect(await hub.search("find")).toEqual([
			{ kind: "vscode", name: "vscode.find", description: "Find a VS Code symbol" },
		])
	})

	it("reports current registry counts without rebuilding the hub", async () => {
		let servers: toolHub.ToolHubMcpServer[] = [{ name: "git", tools: [{ name: "log" }] }]
		const hub = toolHub.createToolHub({
			getMcpHub: () => ({ getServers: () => servers }),
			getSkillsManager: () => ({ getAllSkills: () => [] }),
			getModes: async () => [],
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies) as { status?: () => Promise<unknown> }

		expect(await hub.status?.()).toEqual({ mcp: 1, skill: 0, mode: 0, vscode: 0, environment: 0 })

		servers = []

		expect(await hub.status?.()).toEqual({ mcp: 0, skill: 0, mode: 0, vscode: 0, environment: 0 })
	})

	it("invokes an exact MCP tool through its authoritative hub", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] })
		const hub = toolHub.createToolHub({
			getMcpHub: () => ({
				getServers: () => [{ name: "git", source: "project" as const, tools: [{ name: "log" }] }],
				callTool,
			}),
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies) as unknown as {
			invoke?: (request: unknown, task?: unknown) => Promise<unknown>
		}

		expect(
			await hub.invoke?.(
				{ kind: "mcp", name: "log", server: "git", source: "project", arguments: { limit: 2 } },
				{ permissionProfile: "full" },
			),
		).toEqual({
			content: [{ type: "text", text: "ok" }],
		})
		expect(callTool).toHaveBeenCalledWith("git", "log", { limit: 2 }, "project")
	})

	it("reads an exact skill through its authoritative manager", async () => {
		const getSkillContent = vi.fn().mockResolvedValue({ name: "deploy", instructions: "Deploy safely" })
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => ({
				getAllSkills: () => [{ name: "deploy", source: "global" as const }],
				getSkillContent,
			}),
			getModes: async () => [],
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies) as unknown as {
			invoke?: (request: unknown, task?: unknown) => Promise<unknown>
		}

		expect(await hub.invoke?.({ kind: "skill", name: "deploy", source: "global" })).toEqual({
			name: "deploy",
			instructions: "Deploy safely",
		})
		expect(getSkillContent).toHaveBeenCalledWith("deploy", undefined, "global")
	})

	it("rejects a missing skill without fabricating content", async () => {
		const getSkillContent = vi.fn()
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => ({ getAllSkills: () => [], getSkillContent }),
			getModes: async () => [],
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies)

		await expect(hub.invoke({ kind: "skill", name: "missing", source: "global" })).rejects.toThrow(
			"Unknown skill: global:generic:missing",
		)
		expect(getSkillContent).not.toHaveBeenCalled()
	})

	it("rejects AgentModes as non-executable metadata", async () => {
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => undefined,
			getModes: async () => [{ slug: "review", name: "Code Review" }],
			getNativeTools: () => [],
		} as unknown as toolHub.ToolHubDependencies)

		await expect(hub.invoke({ kind: "mode", name: "review" } as never)).rejects.toThrow(
			"AgentModes cannot be invoked",
		)
	})

	it("invokes an exact native VS Code tool", async () => {
		const invokeNativeTool = vi.fn().mockResolvedValue({ content: [{ type: "text", value: "opened" }] })
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [{ name: "vscode.open", description: "Open a file" }],
			invokeNativeTool,
		} as unknown as toolHub.ToolHubDependencies) as unknown as {
			invoke?: (request: unknown, task?: unknown) => Promise<unknown>
		}

		expect(
			await hub.invoke?.(
				{ kind: "vscode", name: "vscode.open", arguments: { path: "README.md" } },
				{ permissionProfile: "full" },
			),
		).toEqual({
			content: [{ type: "text", value: "opened" }],
		})
		expect(invokeNativeTool).toHaveBeenCalledWith("vscode.open", { path: "README.md" })
	})

	it("uses the active task permission profile before external tool invocation", async () => {
		const callTool = vi.fn()
		const invokeNativeTool = vi.fn()
		const hub = toolHub.createToolHub({
			getMcpHub: () => ({ getServers: () => [{ name: "git", tools: [{ name: "commit" }] }], callTool }),
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [{ name: "vscode.runCommand" }],
			invokeNativeTool,
		}) as unknown as { invoke(request: unknown, task: { permissionProfile: "full" | "review" }): Promise<unknown> }

		await expect(
			hub.invoke({ kind: "mcp", name: "commit", server: "git" }, { permissionProfile: "review" }),
		).rejects.toThrow("OctoCode permission profile does not allow tools.invoke")
		await expect(
			hub.invoke({ kind: "vscode", name: "vscode.runCommand" }, { permissionProfile: "review" }),
		).rejects.toThrow("OctoCode permission profile does not allow tools.invoke")
		expect(callTool).not.toHaveBeenCalled()
		expect(invokeNativeTool).not.toHaveBeenCalled()
	})

	it("allows annotated read-only MCP tools for review and directory, but reserves unknown tools for full", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [] })
		const hub = toolHub.createToolHub({
			getMcpHub: () => ({
				getServers: () => [
					{
						name: "code-graph",
						tools: [{ name: "search", annotations: { readOnlyHint: true } }, { name: "rename" }],
					},
				],
				callTool,
			}),
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [],
			invokeNativeTool: vi.fn(),
			isTrustedMcpServer: (server: toolHub.ToolHubMcpServer) => server.name === "code-graph",
		})

		await expect(hub.search("search")).resolves.toEqual([
			{ kind: "mcp", name: "search", server: "code-graph", access: "read" },
		])
		await expect(
			hub.invoke({ kind: "mcp", name: "search", server: "code-graph" }, { permissionProfile: "review" }),
		).resolves.toEqual({ content: [] })
		await expect(
			hub.invoke({ kind: "mcp", name: "search", server: "code-graph" }, { permissionProfile: "directory" }),
		).resolves.toEqual({ content: [] })
		await expect(
			hub.invoke({ kind: "mcp", name: "rename", server: "code-graph" }, { permissionProfile: "directory" }),
		).rejects.toThrow("OctoCode permission profile does not allow tools.invoke")
		await expect(
			hub.invoke(
				{ kind: "mcp", name: "search", server: "code-graph" },
				{ permissionProfile: "full", readOnly: true },
			),
		).resolves.toEqual({ content: [] })
		await expect(
			hub.invoke(
				{ kind: "mcp", name: "rename", server: "code-graph" },
				{ permissionProfile: "full", readOnly: true },
			),
		).rejects.toThrow("OctoCode permission profile does not allow tools.invoke")
		await expect(
			hub.invoke({ kind: "mcp", name: "rename", server: "code-graph" }, { permissionProfile: "full" }),
		).resolves.toEqual({ content: [] })
	})

	it("does not trust a readOnlyHint from an untrusted MCP server", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [] })
		const hub = toolHub.createToolHub({
			getMcpHub: () => ({
				getServers: () => [
					{ name: "external", tools: [{ name: "read", annotations: { readOnlyHint: true } }] },
				],
				callTool,
			}),
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [],
			invokeNativeTool: vi.fn(),
		})

		await expect(
			hub.invoke({ kind: "mcp", name: "read", server: "external" }, { permissionProfile: "review" }),
		).rejects.toThrow("OctoCode permission profile does not allow tools.invoke")
		expect(callTool).not.toHaveBeenCalled()
	})

	it("resolves skills by source, mode, and name", async () => {
		const getSkillContent = vi.fn().mockResolvedValue({ instructions: "project" })
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => ({
				getAllSkills: () => [
					{ name: "review", source: "global" as const },
					{ name: "review", source: "project" as const, mode: "code" },
				],
				getSkillContent,
			}),
			getModes: async () => [],
			getNativeTools: () => [],
			invokeNativeTool: vi.fn(),
		})

		await expect(
			hub.invoke({ kind: "skill", name: "review", source: "project", mode: "code" } as never),
		).resolves.toEqual({ instructions: "project" })
		expect(getSkillContent).toHaveBeenCalledWith("review", "code", "project")
	})
})

describe("tool hub runtime environments", () => {
	it("lets the agent discover environments and install one only with full permission", async () => {
		const provision = vi.fn(async (id: string) => ({ id, installed: true }))
		const hub = toolHub.createToolHub({
			getMcpHub: () => undefined,
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [],
			invokeNativeTool: vi.fn(),
			getEnvironments: async () => [
				{ id: "rust", label: "Rust", purpose: "Building Rust crates.", installed: false },
			],
			provisionEnvironment: provision,
		})
		expect(await hub.search("rust")).toEqual([
			{
				kind: "environment",
				name: "rust",
				description: "Rust (not installed; invoke to install): Building Rust crates.",
			},
		])
		expect((await hub.status()).environment).toBe(1)
		await expect(
			hub.invoke({ kind: "environment", name: "rust" }, { permissionProfile: "directory" }),
		).rejects.toThrow("does not allow installing environments")
		await expect(hub.invoke({ kind: "environment", name: "nope" }, { permissionProfile: "full" })).rejects.toThrow(
			"Unknown environment",
		)
		await expect(hub.invoke({ kind: "environment", name: "rust" }, { permissionProfile: "full" })).resolves.toEqual(
			{
				id: "rust",
				installed: true,
			},
		)
		expect(provision).toHaveBeenCalledExactlyOnceWith("rust")
	})
})

describe("rankTools", () => {
	const items = [
		{
			kind: "mcp" as const,
			name: "build_or_update_graph_tool",
			description: "Build the code graph",
			server: "code-review-graph",
		},
		{
			kind: "mcp" as const,
			name: "semantic_search_nodes_tool",
			description: "Search code entities, go to definition",
			server: "code-review-graph",
		},
		{
			kind: "environment" as const,
			name: "go",
			description: "Go (not installed; invoke to install): Go toolchain",
		},
		{ kind: "environment" as const, name: "python", description: "Python (installed): scripts" },
		{ kind: "vscode" as const, name: "run_in_terminal", description: "Run python or node commands" },
	]

	it("honours the kind filter", () => {
		expect(toolHub.rankTools(items, "go", { kind: "environment" }).map((t) => t.name)).toEqual(["go"])
	})

	it("matches words, not the whole query as one substring", () => {
		expect(toolHub.rankTools(items, "code graph build").map((t) => t.name)).toEqual(["build_or_update_graph_tool"])
		expect(toolHub.rankTools(items, "python rust java").map((t) => t.name)).toEqual(["python", "run_in_terminal"])
	})

	it("lists the whole kind when nothing in it matches", () => {
		expect(
			toolHub.rankTools(items, "toolchain runtime installed dotnet", { kind: "environment" }).map((t) => t.name),
		).toEqual(["go", "python"])
		expect(toolHub.rankTools(items, "nothing-here")).toEqual([])
	})
})

describe("unknown MCP tool", () => {
	it("names the server that actually has the tool", async () => {
		const hub = toolHub.createToolHub({
			getMcpHub: () => ({
				getServers: () => [{ name: "scrapling", source: "global" as const, tools: [{ name: "get" }] }],
				callTool: vi.fn(),
			}),
			getSkillsManager: () => undefined,
			getModes: async () => [],
			getNativeTools: () => [],
			invokeNativeTool: vi.fn(),
		})
		const task = { permissionProfile: "full" as const }
		await expect(
			hub.invoke({ kind: "mcp", name: "get", server: "octocode-workbench", arguments: {} }, task as never),
		).rejects.toThrow('"get" is on server "scrapling"')
		await expect(
			hub.invoke({ kind: "mcp", name: "nope", server: "x", arguments: {} }, task as never),
		).rejects.toThrow('action "search" with kind "mcp"')
	})
})
