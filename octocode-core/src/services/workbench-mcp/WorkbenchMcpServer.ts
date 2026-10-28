import { randomBytes, timingSafeEqual } from "node:crypto"
import * as path from "node:path"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { z } from "zod/v4"
import * as vscode from "vscode"
import type { PermissionProfile } from "@roo-code/types"
import { CODE_INTELLIGENCE_ACTIONS, dispatchCodeIntelligence } from "./codeIntelligence"
import { DAP_ACTIONS, DapBus, type DapRequest } from "./dapBus"
import { type ToolHub, type ToolHubInvokeRequest } from "./toolHub"
import { requireWorkbenchPermission, type WorkbenchPermissionOperation } from "./toolPermissions"
import { blockedBrowserUrl, readEvalManifest } from "./evalManifest"
import { ARTIFACT_VIEW_COLUMN } from "../../integrations/misc/artifactSlot"

export type WorkbenchMcpEndpoint = { url: string; token: string }
type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>
type BrowserToolInvoker = (name: string, input: Record<string, unknown>) => Promise<unknown>
export type AskUserResult = { answer: string }
type AskUser = (task: ActiveTask, question: string, options?: string[]) => Promise<AskUserResult>
type RequestApproval = (task: ActiveTask, title: string, details: unknown) => Promise<boolean>
class WorkbenchApprovalError extends Error {}
export type ActiveTask = {
	taskId: string
	sessionId: string
	permissionProfile?: PermissionProfile
	readOnly?: boolean
	workingDirectory?: string
	workspaceRoot?: string
}
type McpRequest = IncomingMessage & { body?: unknown }
type McpResponse = ServerResponse & {
	status(code: number): McpResponse
	json(value: unknown): void
}

export class WorkbenchMcpServer implements vscode.Disposable {
	private endpoint?: Omit<WorkbenchMcpEndpoint, "token">
	private starting?: Promise<Omit<WorkbenchMcpEndpoint, "token">>
	private server?: Server
	private hostCall?: HostCall
	private readonly taskTokens = new Map<string, ActiveTask>()
	private dapBus?: DapBus
	private toolHub?: ToolHub
	private askUser?: AskUser
	private requestApproval?: RequestApproval
	private disposed = false

	constructor(
		private readonly output: vscode.OutputChannel,
		private readonly showArtifact?: (file: string, line: number, column: number) => Promise<void>,
		dapBus?: DapBus,
		private readonly invokeBrowserTool?: BrowserToolInvoker,
	) {
		this.dapBus = dapBus
	}

	setHostCall(call: HostCall): void {
		this.hostCall = call
	}

	async startTask(task: ActiveTask): Promise<WorkbenchMcpEndpoint> {
		if (this.disposed) throw new Error("Workbench MCP server is disposed")
		const endpoint = await this.start()
		if (this.disposed) throw new Error("Workbench MCP server is disposed")
		const token = randomBytes(32).toString("hex")
		this.taskTokens.set(token, task)
		return { ...endpoint, token }
	}

	releaseTask(taskId: string): void {
		for (const [token, task] of this.taskTokens) if (task.taskId === taskId) this.taskTokens.delete(token)
	}

	resolveTask(header: string | undefined): ActiveTask | undefined {
		for (const [token, task] of this.taskTokens) if (isAuthorized(header, token)) return task
		return undefined
	}

	setToolHub(toolHub: ToolHub): void {
		this.toolHub = toolHub
	}

	setAskUser(askUser: AskUser): void {
		this.askUser = askUser
	}

	setRequestApproval(requestApproval: RequestApproval): void {
		this.requestApproval = requestApproval
	}

	private async start(): Promise<Omit<WorkbenchMcpEndpoint, "token">> {
		if (this.endpoint) return this.endpoint
		this.starting ??= this.startServer()
		try {
			return await this.starting
		} finally {
			this.starting = undefined
		}
	}

	private async startServer(): Promise<Omit<WorkbenchMcpEndpoint, "token">> {
		const app = createMcpExpressApp({ host: "127.0.0.1" })
		app.use((request: McpRequest, response: McpResponse, next: () => void) => {
			if (this.resolveTask(request.headers.authorization)) next()
			else response.status(401).end()
		})
		app.post("/mcp", async (request: McpRequest, response: McpResponse) => {
			const startedAt = Date.now()
			const audit = mcpAuditFields(request.body)
			const task = this.resolveTask(request.headers.authorization)
			let mcp: McpServer | undefined
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
			try {
				const authorizedTask = await approveWorkbenchRequest(
					task,
					request.body,
					this.requestApproval,
					() => !!task && this.resolveTask(request.headers.authorization) === task && !response.destroyed,
				)
				mcp = createServer(
					this.showArtifact,
					this.invokeBrowserTool,
					(this.dapBus ??= new DapBus()),
					this.hostCall,
					() => (this.resolveTask(request.headers.authorization) === task ? authorizedTask : undefined),
					this.toolHub,
					this.askUser,
				)
				await mcp.connect(transport)
				await transport.handleRequest(request, response, request.body)
				await recordMcpAudit(this.hostCall, task, "info", "MCP request completed", {
					...audit,
					duration_ms: Date.now() - startedAt,
				})
			} catch (error) {
				this.output.appendLine(`[Workbench MCP] ${error instanceof Error ? error.message : String(error)}`)
				await recordMcpAudit(this.hostCall, task, "error", "MCP request failed", {
					...audit,
					duration_ms: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				})
				if (!response.headersSent) {
					const id = (request.body as { id?: unknown } | undefined)?.id
					if (
						!mcp &&
						error instanceof WorkbenchApprovalError &&
						audit.rpc_method === "tools/call" &&
						(typeof id === "string" || typeof id === "number")
					) {
						response.status(200).json({
							jsonrpc: "2.0",
							id,
							result: {
								isError: true,
								content: [
									{ type: "text", text: "OctoCode approval denied or task is no longer active" },
								],
							},
						})
					} else response.status(500).json({ error: "Workbench MCP request failed" })
				}
			} finally {
				await transport.close()
				await mcp?.close()
			}
		})
		this.server = await new Promise<Server>((resolve, reject) => {
			const server = app.listen(0, "127.0.0.1", () => resolve(server))
			server.once("error", reject)
		})
		if (this.disposed) {
			this.server.close()
			this.server = undefined
			throw new Error("Workbench MCP server is disposed")
		}
		const address = this.server.address()
		if (!address || typeof address === "string") throw new Error("Workbench MCP did not bind a TCP port")
		this.endpoint = { url: `http://127.0.0.1:${address.port}/mcp` }
		return this.endpoint
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.server?.close()
		this.server = undefined
		this.endpoint = undefined
		this.starting = undefined
		this.taskTokens.clear()
		this.dapBus?.dispose()
	}
}

export async function approveWorkbenchRequest(
	task: ActiveTask | undefined,
	body: unknown,
	approve: RequestApproval | undefined,
	isActive: () => boolean,
): Promise<ActiveTask> {
	if (!task || !isActive()) throw new WorkbenchApprovalError("Authenticated task is no longer active")
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("Workbench MCP requires a single JSON-RPC request object")
	}
	const request = body as { method?: unknown; params?: { name?: unknown } }
	if (task.permissionProfile !== "review" || task.readOnly || request.method !== "tools/call") return task
	const name = request.params?.name
	if (typeof name !== "string" || !approve || !(await approve(task, name, request.params))) {
		throw new WorkbenchApprovalError("OctoCode tool approval denied")
	}
	if (!isActive()) throw new WorkbenchApprovalError("Authenticated task is no longer active")
	// An ephemeral execution capability for this HTTP invocation, never a persisted profile change.
	// Approval happens before tool deadlines start, so an expired invocation cannot execute later.
	return { ...task, permissionProfile: "full" }
}

export function isAuthorized(header: string | undefined, token: string): boolean {
	if (!header || !/^Bearer [^\s]+$/.test(header)) return false
	const supplied = Buffer.from(header.slice(7))
	const expected = Buffer.from(token)
	return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function mcpAuditFields(value: unknown): { rpc_method?: string; tool_name?: string } {
	if (Array.isArray(value)) return { rpc_method: "batch-rejected" }
	if (!value || typeof value !== "object") return {}
	const body = value as { method?: unknown; params?: { name?: unknown } }
	return {
		...(typeof body.method === "string" ? { rpc_method: body.method } : {}),
		...(typeof body.params?.name === "string" ? { tool_name: body.params.name } : {}),
	}
}

async function recordMcpAudit(
	hostCall: HostCall | undefined,
	task: ActiveTask | undefined,
	level: "info" | "error",
	message: string,
	fields: Record<string, unknown>,
): Promise<void> {
	if (!hostCall) return
	await hostCall("log.create", {
		category: "system",
		level,
		subsystem: "mcp",
		message,
		fields,
		session_id: task?.sessionId,
	}).catch(() => undefined)
}

function createServer(
	showArtifact?: (file: string, line: number, column: number) => Promise<void>,
	invokeBrowserTool?: BrowserToolInvoker,
	dapBus?: DapBus,
	hostCall?: HostCall,
	activeTask?: () => ActiveTask | undefined,
	toolHub?: ToolHub,
	askUser?: AskUser,
): McpServer {
	if (!dapBus) throw new Error("Workbench MCP requires the shared DAP bus")
	const server = new McpServer({ name: "octocode-workbench", version: "1.0.0" })
	if (toolHub) {
		server.registerTool(
			"tools",
			{
				description:
					"Search, inspect, or invoke what extends the agent: MCP tools, skills, modes, VS Code tools, and runtime environments (invoking an environment installs it). search takes optional query words plus kind/server filters; with a kind and no query it lists that kind. MCP results list their argument names (* = required). MCP servers include web search and page fetching (scrapling). status without name returns counts per kind; status with name (and kind) returns that item, e.g. whether an environment is installed.",
				inputSchema: {
					action: z.enum(["search", "invoke", "status"]),
					query: z.string().optional(),
					kind: z.string().optional(),
					name: z.string().optional(),
					server: z.string().optional(),
					source: z.enum(["global", "project"]).optional(),
					mode: z.string().optional(),
					arguments: jsonObjectArgument.optional(),
				},
			},
			async (request) =>
				textResult(
					await withDeadline(
						`tools ${request.action}`,
						toolHubDeadline(request),
						dispatchToolHub(toolHub, activeTask?.(), request),
					),
				),
		)
	}
	if (askUser) {
		server.registerTool(
			"ask_user",
			{
				description: "Request clarification from the user and stop with structured needs-input state.",
				inputSchema: {
					question: z.string().trim().min(1).max(4_000),
					options: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
				},
			},
			async ({ question, options }) => {
				const task = activeTask?.()
				if (!task) throw new Error("Authenticated task is required to ask the user")
				return textResult(await askUser(task, question, options))
			},
		)
	}
	server.registerTool(
		"debug_session",
		{
			description: DEBUG_SESSION_DESCRIPTION,
			inputSchema: {
				kind: z.enum(["dap", "bus"]),
				action: z.string().min(1),
				sessionId: z.string().optional(),
				configuration: jsonObjectArgument.optional(),
				arguments: jsonObjectArgument.optional(),
				command: z.string().optional(),
			},
		},
		async (request) =>
			textResult(
				await withDeadline(
					"debug_session",
					TOOL_DEADLINES_MS.debug,
					dispatchDapRequest(dapBus, request as DapRequest, activeTask?.()),
				),
			),
	)
	if (hostCall) {
		server.registerTool(
			"octocode",
			{
				description:
					"Discover or invoke the single authenticated OctoCode runtime API. Internal lifecycle methods remain Host-owned.",
				inputSchema: {
					action: z.enum(["capabilities", "invoke"]),
					method: z.string().min(1).optional(),
					payload: z.record(z.string(), z.unknown()).optional().default({}),
				},
			},
			async ({ action, method, payload }) =>
				textResult(
					await withDeadline(
						"octocode_api",
						TOOL_DEADLINES_MS.api,
						dispatchOctocodeApi(action, method, payload, hostCall, activeTask?.()),
					),
				),
		)
		server.registerTool(
			"supervisor_checkpoint",
			{
				description:
					"Persist a read-only stage review verdict, evidence, retry count, and pending work for autonomous recovery.",
				inputSchema: { payload: z.record(z.string(), z.unknown()) },
			},
			async ({ payload }) => {
				const task = activeTask?.()
				requireWorkbenchPermission("write", task)
				return textResult(
					await hostCall("supervisor.checkpoint", {
						...payload,
						...(task
							? { id: payload.id ?? task.taskId, session_id: payload.session_id ?? task.sessionId }
							: {}),
					}),
				)
			},
		)
	}
	server.registerTool(
		"code_intelligence",
		{
			description:
				"Use the single VS Code code-intelligence adapter for diagnostics, navigation, symbols, refactors, and capabilities.",
			inputSchema: {
				action: z.enum(CODE_INTELLIGENCE_ACTIONS),
				path: z.string().optional(),
				line: z.number().int().positive().optional(),
				column: z.number().int().positive().optional(),
				query: z.string().optional(),
				newName: z.string().optional(),
				newPath: z.string().optional(),
				command: z.string().optional(),
				arguments: z.array(z.unknown()).optional(),
			},
		},
		async (request) =>
			textResult(
				await withDeadline(
					"code_intelligence",
					TOOL_DEADLINES_MS.codeIntelligence,
					dispatchCodeIntelligence(request, activeTask?.()),
				),
			),
	)
	server.registerTool(
		"open_file",
		{
			description: "Open a file in the VS Code workbench at an optional line and column.",
			inputSchema: {
				path: z.string().min(1),
				line: z.number().int().positive().optional(),
				column: z.number().int().positive().optional(),
			},
		},
		async ({ path: file, line = 1, column = 1 }) => {
			const task = activeTask?.()
			requireWorkbenchPermission("read", task)
			const uri = resolveUri(file, task)
			await openWorkbenchFile(uri, line, column, showArtifact)
			return textResult({ opened: uri.fsPath, line, column })
		},
	)
	if (showArtifact) {
		server.registerTool(
			"show_artifact",
			{
				description: "Show a generated file in the upper-right workbench artifact viewer.",
				inputSchema: { path: z.string().min(1) },
			},
			async ({ path: file }) => {
				const task = activeTask?.()
				requireWorkbenchPermission("read", task)
				const uri = resolveUri(file, task)
				await showArtifact(uri.fsPath, 1, 1)
				return textResult({ shown: uri.fsPath })
			},
		)
	}
	if (invokeBrowserTool) {
		server.registerTool(
			"browser",
			{
				description:
					"Open, inspect, navigate, interact with, screenshot, or validate the integrated VS Code browser through its native Playwright tool set.",
				inputSchema: {
					action: z.enum(BROWSER_ACTIONS),
					payload: z.record(z.string(), z.unknown()).optional().default({}),
				},
			},
			async ({ action, payload }) =>
				textResult(
					await withDeadline(
						`browser ${action}`,
						TOOL_DEADLINES_MS.browser,
						dispatchWorkbenchBrowser(action, payload, invokeBrowserTool, activeTask?.()),
					),
				),
		)
	}
	return server
}

export async function dispatchToolHub(
	hub: ToolHub,
	task: ActiveTask | undefined,
	request: {
		action: "search" | "invoke" | "status"
		query?: string
		kind?: string
		name?: string
		server?: string
		source?: "global" | "project"
		mode?: string
		arguments?: Record<string, unknown>
	},
): Promise<unknown> {
	if (request.action !== "search" && request.action !== "invoke" && request.action !== "status") {
		throw new Error(`Unknown tools action: ${request.action}`)
	}
	if (request.action === "search") return hub.search(request.query, { kind: request.kind, server: request.server })
	if (request.action === "status") {
		if (!request.name) return hub.status()
		// One item: its catalog entry (an environment's description says whether it is installed).
		const matches = await hub.search(request.name, { kind: request.kind, server: request.server })
		const exact = matches.filter((item) => item.name === request.name)
		return exact.length > 0 ? exact : { found: false, name: request.name, kind: request.kind ?? null }
	}
	if (!task) throw new Error("Authenticated task is required to invoke tools")
	// An MCP tool is identified by its server; do not fail a call that says which.
	const kind = request.kind ?? (request.server ? "mcp" : undefined)
	if (!kind || !request.name)
		throw new Error(
			'invoke needs "name" and "kind" (mcp with "server", skill with "source", mode, vscode, or environment); use action "search" to find them',
		)
	let target: ToolHubInvokeRequest
	switch (kind) {
		case "mcp":
			if (!request.server) throw new Error("MCP server is required")
			target = {
				kind: "mcp",
				name: request.name,
				server: request.server,
				source: request.source,
				arguments: request.arguments,
			}
			break
		case "skill":
			if (!request.source) throw new Error("Skill source is required")
			target = { kind: "skill", name: request.name, source: request.source, mode: request.mode }
			break
		case "mode":
			target = { kind: "mode", name: request.name }
			break
		case "vscode":
			target = { kind: "vscode", name: request.name, arguments: request.arguments }
			break
		case "environment":
			target = { kind: "environment", name: request.name }
			break
		default:
			throw new Error(`Unknown tool kind: ${request.kind}`)
	}
	return hub.invoke(target, task)
}

export async function dispatchDapRequest(
	dapBus: Pick<DapBus, "dispatch">,
	request: DapRequest,
	task: ActiveTask | undefined,
): Promise<Record<string, unknown>> {
	const operation: WorkbenchPermissionOperation =
		request.kind === "bus" && request.action === "sessions" ? "read" : "execute"
	requireWorkbenchPermission(operation, task)
	return dapBus.dispatch(request)
}

type HostCapability = { name: string; access: "read" | "write" | "execute"; surface: "runtime" | "internal" }
type HostCapabilities = { protocol_version: number; methods: HostCapability[] }

export async function dispatchOctocodeApi(
	action: "capabilities" | "invoke",
	method: string | undefined,
	payload: Record<string, unknown>,
	hostCall: HostCall,
	task: ActiveTask | undefined,
): Promise<unknown> {
	const capabilities = await hostCall("capabilities.list", {})
	if (action === "capabilities") return capabilities
	if (!method) throw new Error("OctoCode method is required")
	const registry = parseHostCapabilities(capabilities)
	const capability = registry.methods.find((entry) => entry.name === method)
	if (!capability) throw new Error(`Unknown OctoCode method: ${method}`)
	if (capability.surface === "internal") throw new Error(`OctoCode method is internal: ${method}`)
	if (!task) throw new Error("OctoCode task identity is not active")
	if (capability.access !== "read" && (task.permissionProfile !== "full" || task.readOnly)) {
		throw new Error(`OctoCode permission profile does not allow ${method}`)
	}
	return hostCall(method, bindAgentHostParams(method, payload, task))
}

function parseHostCapabilities(value: unknown): HostCapabilities {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Host capability registry")
	const registry = value as Partial<HostCapabilities>
	if (registry.protocol_version !== 1 || !Array.isArray(registry.methods)) {
		throw new Error("Unsupported Host capability registry")
	}
	return registry as HostCapabilities
}

function bindAgentHostParams(
	method: string,
	payload: Record<string, unknown>,
	task: ActiveTask,
): Record<string, unknown> {
	if (method === "world_model.propose") {
		return {
			...payload,
			actor: "model",
			actor_ref: `task:${task.taskId}`,
			scope: "session",
			scope_key: task.sessionId,
			source_kind: "model",
			source_ref: `task:${task.taskId}`,
		}
	}
	if (method === "world_model.retract") {
		return {
			...payload,
			actor: "model",
			source_kind: "model",
			source_ref: `task:${task.taskId}`,
		}
	}
	return payload
}

export async function openWorkbenchBrowser(url: string): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.browser.open", { url, viewColumn: ARTIFACT_VIEW_COLUMN })
}

export const BROWSER_ACTIONS = [
	"open",
	"list",
	"read",
	"screenshot",
	"navigate",
	"click",
	"drag",
	"hover",
	"type",
	"run",
	"dialog",
] as const
export type BrowserAction = (typeof BROWSER_ACTIONS)[number]

const BROWSER_TOOL_IDS: Record<BrowserAction, string> = {
	open: "open_browser_page",
	list: "list_browser_pages",
	read: "read_page",
	screenshot: "screenshot_page",
	navigate: "navigate_page",
	click: "click_element",
	drag: "drag_element",
	hover: "hover_element",
	type: "type_in_page",
	run: "run_playwright_code",
	dialog: "handle_dialog",
}

const BROWSER_OPERATIONS: Record<BrowserAction, WorkbenchPermissionOperation> = {
	open: "browser",
	list: "browser",
	read: "browser",
	screenshot: "browser",
	navigate: "browser",
	click: "write",
	drag: "write",
	hover: "browser",
	type: "write",
	run: "write",
	dialog: "write",
}

export const browserToolId = (action: BrowserAction): string => BROWSER_TOOL_IDS[action]

export const dispatchWorkbenchBrowser = (
	action: BrowserAction,
	payload: Record<string, unknown>,
	invoke: BrowserToolInvoker,
	task: ActiveTask | undefined,
): Promise<unknown> => {
	requireWorkbenchPermission(BROWSER_OPERATIONS[action], task)
	const blocked = blockedBrowserUrl(readEvalManifest(task?.workspaceRoot), payload.url)
	if (blocked) return Promise.reject(new Error(blocked))
	return invoke(browserToolId(action), payload)
}

export async function openWorkbenchFile(
	uri: vscode.Uri,
	line: number,
	column: number,
	showArtifact?: (file: string, line: number, column: number) => Promise<void>,
): Promise<void> {
	if (showArtifact) return showArtifact(uri.fsPath, line, column)
	await vscode.commands.executeCommand("vscode.open", uri, {
		preview: false,
		selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1),
		viewColumn: ARTIFACT_VIEW_COLUMN,
	})
}

function resolveUri(file: string, task: ActiveTask | undefined): vscode.Uri {
	if (!file.trim()) throw new Error("File path is required")
	if (path.isAbsolute(file)) return vscode.Uri.file(file)
	const root = task?.workingDirectory ?? task?.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!root || !path.isAbsolute(root))
		throw new Error("An absolute workspace root is required for relative file paths")
	return vscode.Uri.file(path.resolve(root, file))
}

/**
 * Longest a workbench tool may take before the agent gets an error instead of
 * waiting. A browser call once sat behind a modal dialog for 1.5 hours and the
 * run just hung; with a deadline the agent hears why and can take another route.
 */
export const TOOL_DEADLINES_MS = {
	browser: 2 * 60_000,
	codeIntelligence: 90_000,
	debug: 3 * 60_000, // a launch may first install the debugger extension
	api: 2 * 60_000,
	hubQuery: 60_000,
	hubInvoke: 10 * 60_000, // MCP tools such as a full code-graph build
	environment: 25 * 60_000, // download + extract a toolchain
}

export function toolHubDeadline(request: { action: string; kind?: string }): number {
	if (request.action !== "invoke") return TOOL_DEADLINES_MS.hubQuery
	return request.kind === "environment" ? TOOL_DEADLINES_MS.environment : TOOL_DEADLINES_MS.hubInvoke
}

export async function withDeadline<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`${label} did not finish within ${Math.round(ms / 1000)} s. It may be blocked on a dialog or a slow service; ` +
							"do not repeat the same call right away. Try a different approach or report the blocker.",
					),
				),
			ms,
		)
	})
	try {
		return await Promise.race([work, expired])
	} finally {
		clearTimeout(timer)
	}
}

/** An object argument that also accepts the JSON text of an object (local models often send strings). */
export const jsonObjectArgument = z.preprocess(
	(value) => {
		if (typeof value !== "string") return value
		try {
			return JSON.parse(value)
		} catch {
			return value
		}
	},
	z.record(z.string(), z.unknown()),
)

const DEBUG_SESSION_DESCRIPTION = [
	"Debug programs through VS Code's debug adapters (Python, Node, and others; a missing Python debugger is installed on demand).",
	'Start: {"kind":"dap","action":"launch","configuration":{"type":"python","request":"launch","name":"run","program":"<absolute path>"},"arguments":{"breakpoints":[{"path":"<absolute path>","line":5}]}}',
	"launch sets the breakpoints before the program starts, returns data.sessionId and waits for the first stop (state, threadId).",
	'Then with kind "dap" and that sessionId: stack_trace {threadId}, scopes {frameId}, variables {variablesReference}, evaluate {expression, frameId}, continue / step_over / step_in / step_out, wait_for_stop {timeoutMs}, output, terminate.',
	`All dap actions: ${DAP_ACTIONS.join(", ")}. Bus action: {"kind":"bus","action":"sessions"} lists sessions.`,
].join(" ")

function textResult(value: unknown) {
	// JSON.stringify(undefined) is undefined, which is not valid MCP text content;
	// a provider that answers nothing (e.g. no symbol provider yet) must still
	// produce a well-formed result the agent can read.
	return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }] }
}
