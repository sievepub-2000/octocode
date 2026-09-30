import * as vscode from "vscode"
import * as http from "node:http"
import * as path from "node:path"
import nock from "nock"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	type ActiveTask,
	type WorkbenchMcpEndpoint,
	WorkbenchMcpServer,
	browserToolId,
	dispatchWorkbenchBrowser,
	dispatchDapRequest,
	dispatchToolHub,
	dispatchOctocodeApi,
	mcpAuditFields,
	isAuthorized,
	openWorkbenchBrowser,
	openWorkbenchFile,
	TOOL_DEADLINES_MS,
	toolHubDeadline,
	jsonObjectArgument,
	withDeadline,
} from "../WorkbenchMcpServer"

beforeEach(() => vi.restoreAllMocks())

describe("Workbench MCP authentication", () => {
	it.each(["review", "directory", "full"] as const)(
		"enforces %s permissions over HTTP",
		async (permissionProfile) => {
			const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
			const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			const hostCall = vi.fn(async (method: string) =>
				method === "capabilities.list"
					? { protocol_version: 1, methods: [{ name: "setting.set", access: "write", surface: "runtime" }] }
					: { updated: true },
			)
			const server = new WorkbenchMcpServer(
				{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
				undefined,
				{ dispose: vi.fn() } as unknown as import("../dapBus").DapBus,
			)
			server.setHostCall(hostCall)
			const client = new Client({ name: "permission-audit", version: "1" })
			nock.enableNetConnect("127.0.0.1")
			try {
				const endpoint = await server.startTask({ taskId: "audit", sessionId: "audit", permissionProfile })
				expect(
					(await fetch(endpoint.url, { method: "POST", headers: { authorization: "Bearer invalid" } }))
						.status,
				).toBe(401)
				await client.connect(
					new StreamableHTTPClientTransport(new URL(endpoint.url), {
						requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
					}),
				)
				if (permissionProfile === "full") {
					const capabilities = await client.callTool({
						name: "octocode",
						arguments: { action: "capabilities" },
					})
					expect(capabilities.isError).not.toBe(true)
				}
				const result = await client.callTool({
					name: "octocode",
					arguments: { action: "invoke", method: "setting.set", payload: { key: "audit", value: 1 } },
				})
				expect(Boolean(result.isError)).toBe(permissionProfile !== "full")
				expect(hostCall.mock.calls.some(([method]) => method === "setting.set")).toBe(
					permissionProfile === "full",
				)
			} finally {
				await client.close()
				server.dispose()
				nock.disableNetConnect()
			}
		},
	)

	it("accepts only the exact bearer token", () => {
		expect(isAuthorized("Bearer secret", "secret")).toBe(true)
		expect(isAuthorized("Bearer other", "secret")).toBe(false)
		expect(isAuthorized(undefined, "secret")).toBe(false)
	})

	it("keeps a full profile while blocking writes for a read-only turn", async () => {
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
		const hostCall = vi.fn(async (method: string) =>
			method === "capabilities.list"
				? { protocol_version: 1, methods: [{ name: "setting.set", access: "write", surface: "runtime" }] }
				: { updated: true },
		)
		const server = new WorkbenchMcpServer({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, undefined, {
			dispose: vi.fn(),
		} as unknown as import("../dapBus").DapBus)
		server.setHostCall(hostCall)
		const client = new Client({ name: "read-only-audit", version: "1" })
		nock.enableNetConnect("127.0.0.1")
		try {
			const endpoint = await server.startTask({
				taskId: "read-only",
				sessionId: "session",
				permissionProfile: "full",
				readOnly: true,
			})
			await client.connect(
				new StreamableHTTPClientTransport(new URL(endpoint.url), {
					requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
				}),
			)
			const write = await client.callTool({
				name: "octocode",
				arguments: { action: "invoke", method: "setting.set", payload: { key: "audit", value: 1 } },
			})
			const checkpoint = await client.callTool({ name: "supervisor_checkpoint", arguments: { payload: {} } })
			expect(write.isError).toBe(true)
			expect(checkpoint.isError).toBe(true)
			expect(
				hostCall.mock.calls.some(([method]) => method === "setting.set" || method === "supervisor.checkpoint"),
			).toBe(false)
		} finally {
			await client.close()
			server.dispose()
			nock.disableNetConnect()
		}
	})
})

describe("Workbench tool hub validation", () => {
	it("rejects invalid actions, kinds, and incomplete MCP targets concisely", async () => {
		const hub = {
			search: vi.fn(),
			status: vi.fn(),
			invoke: vi.fn(),
		}
		const task = { taskId: "task", sessionId: "session", permissionProfile: "review" as const }
		await expect(
			dispatchToolHub(hub, task, { action: "invalid", kind: "mcp", name: "log", server: "git" } as never),
		).rejects.toThrow("Unknown tools action: invalid")
		await expect(dispatchToolHub(hub, task, { action: "invoke", kind: "invalid", name: "x" })).rejects.toThrow(
			"Unknown tool kind: invalid",
		)
		await expect(dispatchToolHub(hub, task, { action: "invoke", kind: "mcp", name: "log" })).rejects.toThrow(
			"MCP server is required",
		)
		await expect(dispatchToolHub(hub, task, { action: "invoke", kind: "skill", name: "review" })).rejects.toThrow(
			"Skill source is required",
		)
	})

	it("passes the authenticated task through to tools.invoke", async () => {
		const invoke = vi.fn()
		const task = { taskId: "task", sessionId: "session", permissionProfile: "full" as const }
		await dispatchToolHub({ search: vi.fn(), status: vi.fn(), invoke }, task, {
			action: "invoke",
			kind: "vscode",
			name: "vscode.open",
		})
		expect(invoke).toHaveBeenCalledWith({ kind: "vscode", name: "vscode.open", arguments: undefined }, task)
	})

	it("infers an MCP call from its server and explains what an invoke needs", async () => {
		const invoke = vi.fn()
		const task = { taskId: "task", sessionId: "session", permissionProfile: "full" as const }
		const hub = { search: vi.fn(), status: vi.fn(), invoke }
		await dispatchToolHub(hub, task, {
			action: "invoke",
			name: "search",
			server: "scrapling",
			arguments: { query: "q" },
		})
		expect(invoke).toHaveBeenCalledWith(
			{ kind: "mcp", name: "search", server: "scrapling", source: undefined, arguments: { query: "q" } },
			task,
		)
		await expect(dispatchToolHub(hub, task, { action: "invoke", name: "search" })).rejects.toThrow(
			'use action "search" to find them',
		)
	})
})

describe("Workbench MCP task ownership", () => {
	it("resolves relative artifacts from the active task directory", async () => {
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
		const showArtifact = vi.fn().mockResolvedValue(undefined)
		const server = new WorkbenchMcpServer(
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			showArtifact,
			{ dispose: vi.fn() } as unknown as import("../dapBus").DapBus,
		)
		const client = new Client({ name: "artifact-root-audit", version: "1" })
		const workingDirectory = path.resolve("artifact-root")
		nock.enableNetConnect("127.0.0.1")
		try {
			const endpoint = await server.startTask({
				taskId: "task",
				sessionId: "session",
				permissionProfile: "full",
				workingDirectory,
			})
			await client.connect(
				new StreamableHTTPClientTransport(new URL(endpoint.url), {
					requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
				}),
			)
			const result = await client.callTool({ name: "show_artifact", arguments: { path: "artifact.txt" } })
			expect(result.isError).not.toBe(true)
			expect(showArtifact).toHaveBeenCalledWith(path.join(workingDirectory, "artifact.txt"), 1, 1)
		} finally {
			await client.close()
			server.dispose()
			nock.disableNetConnect()
		}
	})

	it("starts one loopback listener for concurrent cold task starts", async () => {
		const listen = vi.spyOn(http.Server.prototype, "listen")
		const server = new WorkbenchMcpServer({ appendLine: vi.fn() } as unknown as vscode.OutputChannel)
		try {
			const [endpointA, endpointB] = await Promise.all([
				server.startTask({ taskId: "task-a", sessionId: "session-a" }),
				server.startTask({ taskId: "task-b", sessionId: "session-b" }),
			])

			expect(listen).toHaveBeenCalledOnce()
			expect(endpointA.url).toBe(endpointB.url)
			expect(endpointA.token).not.toBe(endpointB.token)
			expect(server.resolveTask(`Bearer ${endpointA.token}`)).toMatchObject({ taskId: "task-a" })
			expect(server.resolveTask(`Bearer ${endpointB.token}`)).toMatchObject({ taskId: "task-b" })
		} finally {
			server.dispose()
			listen.mockRestore()
		}
	})

	it("rejects new tasks after disposal instead of returning a closed endpoint", async () => {
		const server = new WorkbenchMcpServer({ appendLine: vi.fn() } as unknown as vscode.OutputChannel)
		const endpoint = await server.startTask({ taskId: "task", sessionId: "session" })
		server.dispose()
		expect(server.resolveTask(`Bearer ${endpoint.token}`)).toBeUndefined()
		await expect(server.startTask({ taskId: "next", sessionId: "next" })).rejects.toThrow("disposed")
	})

	it("keeps task A bound to its token after task B starts and releases only A", async () => {
		const server = new WorkbenchMcpServer({ appendLine: vi.fn() } as unknown as vscode.OutputChannel)
		const ownership = server as unknown as {
			startTask?: (task: ActiveTask) => Promise<WorkbenchMcpEndpoint>
			resolveTask?: (header: string | undefined) => ActiveTask | undefined
			releaseTask?: (taskId: string) => void
		}
		expect(ownership.startTask).toEqual(expect.any(Function))
		expect(ownership.resolveTask).toEqual(expect.any(Function))
		expect(ownership.releaseTask).toEqual(expect.any(Function))
		try {
			const taskA = { taskId: "task-a", sessionId: "session-a", permissionProfile: "full" as const }
			const taskB = { taskId: "task-b", sessionId: "session-b", permissionProfile: "review" as const }
			const endpointA = await ownership.startTask!.call(server, taskA)
			const endpointB = await ownership.startTask!.call(server, taskB)

			expect(endpointB).toMatchObject({ url: endpointA.url })
			expect(endpointB.token).not.toBe(endpointA.token)
			expect(ownership.resolveTask!("Bearer " + endpointA.token)).toEqual(taskA)
			expect(ownership.resolveTask!("Bearer " + endpointB.token)).toEqual(taskB)

			ownership.releaseTask!(taskA.taskId)
			expect(ownership.resolveTask!("Bearer " + endpointA.token)).toBeUndefined()
			expect(ownership.resolveTask!("Bearer " + endpointB.token)).toEqual(taskB)
		} finally {
			server.dispose()
		}
	})
})

describe("OctoCode MCP control plane", () => {
	const registry = {
		protocol_version: 1,
		methods: [
			{ name: "health", access: "read", surface: "runtime" },
			{ name: "log.list", access: "read", surface: "runtime" },
			{ name: "world_model.propose", access: "write", surface: "runtime" },
			{ name: "agent.run", access: "execute", surface: "internal" },
		],
	}

	it("discovers capabilities from the authoritative Host registry", async () => {
		const hostCall = vi.fn().mockResolvedValue(registry)
		await expect(dispatchOctocodeApi("capabilities", undefined, {}, hostCall, undefined)).resolves.toEqual(registry)
		expect(hostCall).toHaveBeenCalledExactlyOnceWith("capabilities.list", {})
	})

	it("invokes only registered public methods allowed by the active permission profile", async () => {
		const hostCall = vi.fn(async (method: string) => (method === "capabilities.list" ? registry : { ok: method }))
		await expect(
			dispatchOctocodeApi("invoke", "log.list", { category: "system" }, hostCall, {
				taskId: "task-1",
				sessionId: "session-1",
				permissionProfile: "review",
			}),
		).resolves.toEqual({ ok: "log.list" })
		await expect(
			dispatchOctocodeApi("invoke", "world_model.propose", {}, hostCall, {
				taskId: "task-1",
				sessionId: "session-1",
				permissionProfile: "review",
			}),
		).rejects.toThrow("permission")
		await expect(
			dispatchOctocodeApi("invoke", "agent.run", {}, hostCall, {
				taskId: "task-1",
				sessionId: "session-1",
				permissionProfile: "full",
			}),
		).rejects.toThrow("internal")
	})

	it("binds model-authored world claims to the active task identity", async () => {
		const hostCall = vi.fn(async (method: string, params: Record<string, unknown>) =>
			method === "capabilities.list" ? registry : params,
		)
		await expect(
			dispatchOctocodeApi(
				"invoke",
				"world_model.propose",
				{ scope: "session", actor: "user", source_kind: "user", source_ref: "forged" },
				hostCall,
				{ taskId: "task-1", sessionId: "session-1", permissionProfile: "full" },
			),
		).resolves.toMatchObject({
			actor: "model",
			actor_ref: "task:task-1",
			scope: "session",
			scope_key: "session-1",
			source_kind: "model",
			source_ref: "task:task-1",
		})
	})
})

describe("MCP audit logging", () => {
	it("records only the RPC method and tool name, never tool arguments", () => {
		expect(
			mcpAuditFields({
				jsonrpc: "2.0",
				method: "tools/call",
				params: { name: "octocode", arguments: { api_key: "secret" } },
			}),
		).toEqual({ rpc_method: "tools/call", tool_name: "octocode" })
		expect(mcpAuditFields([{ jsonrpc: "2.0", method: "tools/call" }])).toEqual({
			rpc_method: "batch-rejected",
		})
	})
})

it("does not expose the unused compaction barrier", async () => {
	const server = new WorkbenchMcpServer({ appendLine: vi.fn() } as unknown as vscode.OutputChannel)
	nock.enableNetConnect("127.0.0.1")
	try {
		const task = await server.startTask({ taskId: "task", sessionId: "session" })
		const response = await fetch(task.url.replace(/\/mcp$/, "/compaction-barrier"), {
			method: "POST",
			headers: { authorization: `Bearer ${task.token}` },
		})
		expect(response.status).toBe(404)
	} finally {
		server.dispose()
		nock.disableNetConnect()
	}
})

describe("Workbench MCP web research", () => {
	it("accepts a browser list call without an unused payload", async () => {
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
		const invoke = vi.fn().mockResolvedValue({ pages: [] })
		const server = new WorkbenchMcpServer(
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			undefined,
			{ dispose: vi.fn() } as unknown as import("../dapBus").DapBus,
			invoke,
		)
		const client = new Client({ name: "browser-schema-audit", version: "1" })
		nock.enableNetConnect("127.0.0.1")
		try {
			const endpoint = await server.startTask({ taskId: "task", sessionId: "session", permissionProfile: "full" })
			await client.connect(
				new StreamableHTTPClientTransport(new URL(endpoint.url), {
					requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
				}),
			)
			const result = await client.callTool({ name: "browser", arguments: { action: "list" } })
			expect(result.isError).not.toBe(true)
			expect(invoke).toHaveBeenCalledWith("list_browser_pages", {})
		} finally {
			await client.close()
			server.dispose()
			nock.disableNetConnect()
		}
	})

	it("routes every browser action to the native VS Code BrowserView tool set", async () => {
		expect(browserToolId("open")).toBe("open_browser_page")
		expect(browserToolId("read")).toBe("read_page")
		expect(browserToolId("screenshot")).toBe("screenshot_page")
		expect(browserToolId("navigate")).toBe("navigate_page")
		expect(browserToolId("click")).toBe("click_element")
		expect(browserToolId("drag")).toBe("drag_element")
		expect(browserToolId("hover")).toBe("hover_element")
		expect(browserToolId("type")).toBe("type_in_page")
		expect(browserToolId("run")).toBe("run_playwright_code")
		expect(browserToolId("dialog")).toBe("handle_dialog")
		expect(browserToolId("list")).toBe("list_browser_pages")

		const invoke = vi.fn().mockResolvedValue({ content: "ok" })
		await expect(
			dispatchWorkbenchBrowser("navigate", { pageId: "p", type: "reload" }, invoke, {
				taskId: "task",
				sessionId: "session",
				permissionProfile: "directory",
			}),
		).resolves.toEqual({
			content: "ok",
		})
		expect(invoke).toHaveBeenCalledExactlyOnceWith("navigate_page", { pageId: "p", type: "reload" })
		for (const action of ["click", "drag", "type", "run", "dialog"] as const) {
			expect(() =>
				dispatchWorkbenchBrowser(action, {}, invoke, {
					taskId: "task",
					sessionId: "session",
					permissionProfile: "review",
				}),
			).toThrow("permission profile does not allow write")
		}
		expect(() =>
			dispatchWorkbenchBrowser("click", {}, invoke, {
				taskId: "task",
				sessionId: "session",
				permissionProfile: "full",
				readOnly: true,
			}),
		).toThrow("permission profile does not allow write")
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it("requires an active full-access task for DAP execution", async () => {
		const dispatch = vi.fn().mockResolvedValue({ success: true })
		await expect(
			dispatchDapRequest(
				{ dispatch },
				{ kind: "dap", action: "continue", sessionId: "debug-1" },
				{ taskId: "task", sessionId: "session", permissionProfile: "directory" },
			),
		).rejects.toThrow("permission profile does not allow execute")
		expect(dispatch).not.toHaveBeenCalled()
	})

	it("opens browser work in the upper-right editor group", async () => {
		const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		await openWorkbenchBrowser("https://example.com/")
		expect(execute).toHaveBeenCalledExactlyOnceWith("workbench.action.browser.open", {
			url: "https://example.com/",
			viewColumn: vscode.ViewColumn.Two,
		})
	})

	it("preserves line and column when routing a file to the artifact provider", async () => {
		const showArtifact = vi.fn().mockResolvedValue(undefined)
		await openWorkbenchFile(vscode.Uri.file("C:/workspace/file.ts"), 7, 9, showArtifact)
		expect(showArtifact).toHaveBeenCalledWith("C:/workspace/file.ts", 7, 9)
	})
})

describe("workbench tool deadlines", () => {
	it("turns a call that never settles into an explanatory error", async () => {
		vi.useFakeTimers()
		try {
			const pending = withDeadline("browser open", 2_000, new Promise<never>(() => {}))
			const assertion = expect(pending).rejects.toThrow(
				/browser open did not finish within 2 s.*blocked on a dialog/,
			)
			await vi.advanceTimersByTimeAsync(2_000)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})

	it("passes results and errors through untouched", async () => {
		await expect(withDeadline("x", 1_000, Promise.resolve(42))).resolves.toBe(42)
		await expect(withDeadline("x", 1_000, Promise.reject(new Error("boom")))).rejects.toThrow("boom")
	})

	it("gives toolchain installs and MCP invocations room, and queries little", () => {
		expect(toolHubDeadline({ action: "search" })).toBe(TOOL_DEADLINES_MS.hubQuery)
		expect(toolHubDeadline({ action: "invoke", kind: "mcp" })).toBe(TOOL_DEADLINES_MS.hubInvoke)
		expect(toolHubDeadline({ action: "invoke", kind: "environment" })).toBe(TOOL_DEADLINES_MS.environment)
	})
})

describe("tools status for one item", () => {
	it("returns the item's entry instead of the catalog totals", async () => {
		const rust = { kind: "environment" as const, name: "rust", description: "Rust toolchain (installed): build" }
		const hub = {
			search: vi.fn(async () => [rust, { ...rust, name: "rust-analyzer" }]),
			status: vi.fn(async () => ({ mcp: 1, skill: 0, mode: 0, vscode: 0, environment: 14 })),
			invoke: vi.fn(),
		}
		await expect(
			dispatchToolHub(hub, undefined, { action: "status", kind: "environment", name: "rust" }),
		).resolves.toEqual([rust])
		expect(hub.search).toHaveBeenCalledWith("rust", { kind: "environment", server: undefined })
		await expect(dispatchToolHub(hub, undefined, { action: "status", name: "nope" })).resolves.toMatchObject({
			found: false,
		})
		await expect(dispatchToolHub(hub, undefined, { action: "status" })).resolves.toMatchObject({ environment: 14 })
	})
})

describe("object arguments sent as JSON text", () => {
	it("accepts an object or the JSON text of one, and still rejects anything else", () => {
		expect(jsonObjectArgument.parse({ type: "python" })).toEqual({ type: "python" })
		expect(jsonObjectArgument.parse('{"type":"python","request":"launch"}')).toEqual({
			type: "python",
			request: "launch",
		})
		expect(() => jsonObjectArgument.parse("not json")).toThrow()
		expect(() => jsonObjectArgument.parse("[1,2]")).toThrow()
	})
})
describe("per-invocation review approvals", () => {
	it("rejects JSON-RPC batches before they can bypass single-call approval", async () => {
		const { approveWorkbenchRequest } = await import("../WorkbenchMcpServer")
		const task = { taskId: "task", sessionId: "session", permissionProfile: "review" as const }
		const approve = vi.fn().mockResolvedValue(true)
		await expect(
			approveWorkbenchRequest(task, [{ method: "tools/call", params: { name: "tools" } }], approve, () => true),
		).rejects.toThrow("single JSON-RPC request")
		expect(approve).not.toHaveBeenCalled()
	})
	it("authorizes only the reviewed invocation without changing the task profile", async () => {
		const { approveWorkbenchRequest } = await import("../WorkbenchMcpServer")
		const task = { taskId: "task", sessionId: "session", permissionProfile: "review" as const }
		const request = {
			method: "tools/call",
			params: { name: "tools", arguments: { action: "invoke", name: "write" } },
		}
		const approve = vi.fn().mockResolvedValue(true)
		const authorized = await approveWorkbenchRequest(task, request, approve, () => true)
		expect(authorized.permissionProfile).toBe("full")
		expect(task.permissionProfile).toBe("review")
		expect(approve).toHaveBeenCalledWith(task, "tools", request.params)
		await expect(
			approveWorkbenchRequest(
				task,
				request,
				async () => false,
				() => true,
			),
		).rejects.toThrow("denied")
	})

	it("fails closed when the lease is revoked while the user is deciding", async () => {
		const { approveWorkbenchRequest } = await import("../WorkbenchMcpServer")
		const task = { taskId: "task", sessionId: "session", permissionProfile: "review" as const }
		let active = true
		await expect(
			approveWorkbenchRequest(
				task,
				{ method: "tools/call", params: { name: "browser" } },
				async () => {
					active = false
					return true
				},
				() => active,
			),
		).rejects.toThrow("active")
	})

	it("does not promote a read-only turn or a directory task, even when approval is available", async () => {
		const { approveWorkbenchRequest } = await import("../WorkbenchMcpServer")
		const approve = vi.fn().mockResolvedValue(true)
		for (const task of [
			{ taskId: "task", sessionId: "s", permissionProfile: "review" as const, readOnly: true },
			{ taskId: "task", sessionId: "s", permissionProfile: "directory" as const },
		])
			expect(
				await approveWorkbenchRequest(
					task,
					{ method: "tools/call", params: { name: "tools" } },
					approve,
					() => true,
				),
			).toBe(task)
		expect(approve).not.toHaveBeenCalled()
	})
})
