import * as vscode from "vscode"

export const DAP_ACTIONS = [
	"launch",
	"attach",
	"set_breakpoint",
	"remove_breakpoint",
	"set_instruction_breakpoint",
	"remove_instruction_breakpoint",
	"data_breakpoint_info",
	"set_data_breakpoint",
	"remove_data_breakpoint",
	"continue",
	"step_over",
	"step_in",
	"step_out",
	"pause",
	"evaluate",
	"stack_trace",
	"threads",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"write_memory",
	"modules",
	"loaded_sources",
	"custom_request",
	"output",
	"wait_for_stop",
	"terminate",
] as const

export type DapAction = (typeof DAP_ACTIONS)[number]
export type DapRequest = {
	kind: "dap" | "bus"
	action: DapAction | "sessions"
	sessionId?: string
	configuration?: vscode.DebugConfiguration
	arguments?: Record<string, unknown>
	command?: string
}

type DebugApi = Pick<
	typeof vscode.debug,
	| "activeDebugSession"
	| "onDidStartDebugSession"
	| "onDidTerminateDebugSession"
	| "onDidReceiveDebugSessionCustomEvent"
	| "startDebugging"
	| "stopDebugging"
> &
	Partial<Pick<typeof vscode.debug, "registerDebugAdapterTrackerFactory" | "addBreakpoints">>

type DapBreakpoint = { path: string; line: number; condition?: string }

function parseBreakpoints(value: unknown): DapBreakpoint[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((item) => {
		const candidate = item as Partial<DapBreakpoint>
		return typeof candidate?.path === "string" && typeof candidate.line === "number" && candidate.line > 0
			? [{ path: candidate.path, line: candidate.line, condition: candidate.condition }]
			: []
	})
}

/** Open VSX extensions that provide a debug type the product does not ship. */
export const DEBUGGER_EXTENSIONS: Record<string, string> = {
	python: "ms-python.debugpy",
	debugpy: "ms-python.debugpy",
	java: "vscjava.vscode-java-debug",
	go: "golang.go",
	lldb: "vadimcn.vscode-lldb",
}

/**
 * Make sure a debug adapter for `type` is installed before launching it.
 *
 * Without this a missing adapter made VS Code pop its extension recommendation
 * (the Extensions view opening as an extra column) and the agent fell back to
 * hand-rolled tracing. Installing on demand keeps the product small and the
 * launch silent.
 */
export async function ensureDebuggerExtension(type: string | undefined): Promise<void> {
	if (!type) return
	const provides = () =>
		vscode.extensions.all.some((extension) =>
			((extension.packageJSON?.contributes?.debuggers ?? []) as { type?: string }[]).some(
				(debuggerContribution) => debuggerContribution.type === type,
			),
		)
	if (provides()) return
	const id = DEBUGGER_EXTENSIONS[type]
	if (!id) return
	// No publisher-trust dialog: it would stall an unattended run (the shell honours this option).
	await vscode.commands.executeCommand("workbench.extensions.installExtension", id, { skipPublisherTrust: true })
	for (let waited = 0; waited < 60_000 && !provides(); waited += 500) {
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	if (!provides())
		throw new Error(`Installed ${id} but no debugger for "${type}" appeared; reload the window and retry.`)
}

type TrackedSession = {
	session: vscode.DebugSession
	parentSessionId?: string
	stoppedThreadId?: number
	state: "running" | "stopped" | "terminated"
	stopReason?: string
	output: unknown[]
	waiters: (() => void)[]
}

const COMMANDS: Partial<Record<DapAction, string>> = {
	set_breakpoint: "setBreakpoints",
	remove_breakpoint: "setBreakpoints",
	set_instruction_breakpoint: "setInstructionBreakpoints",
	remove_instruction_breakpoint: "setInstructionBreakpoints",
	data_breakpoint_info: "dataBreakpointInfo",
	set_data_breakpoint: "setDataBreakpoints",
	remove_data_breakpoint: "setDataBreakpoints",
	continue: "continue",
	step_over: "next",
	step_in: "stepIn",
	step_out: "stepOut",
	pause: "pause",
	evaluate: "evaluate",
	stack_trace: "stackTrace",
	threads: "threads",
	scopes: "scopes",
	variables: "variables",
	disassemble: "disassemble",
	read_memory: "readMemory",
	write_memory: "writeMemory",
	modules: "modules",
	loaded_sources: "loadedSources",
}

export class DapBus implements vscode.Disposable {
	private readonly sessions = new Map<string, TrackedSession>()
	private readonly subscriptions: vscode.Disposable[]

	private readonly sessionStarted: ((id: string) => void)[] = []

	constructor(
		private readonly debugApi: DebugApi = vscode.debug,
		private readonly outputLimit = 1_000,
		private readonly ensureDebugger: (type: string | undefined) => Promise<void> = ensureDebuggerExtension,
		private readonly sessionWaitMs = 3_000,
	) {
		this.subscriptions = [
			debugApi.onDidStartDebugSession((session) => this.track(session)),
			// A finished session stays readable (output, final state) until the bus is disposed.
			debugApi.onDidTerminateDebugSession((session) => this.onEvent(session.id, "terminated", undefined)),
			debugApi.onDidReceiveDebugSessionCustomEvent((event) =>
				this.onEvent(event.session.id, event.event, event.body),
			),
		]
		// Standard DAP events (stopped, output, terminated) reach extensions only through
		// an adapter tracker; the custom-event stream above never carries them, so the
		// bus could not tell that a breakpoint had been hit.
		const tracker = debugApi.registerDebugAdapterTrackerFactory?.("*", {
			createDebugAdapterTracker: (session) => ({
				onDidSendMessage: (message: { type?: string; event?: string; body?: Record<string, unknown> }) => {
					if (message?.type === "event" && message.event)
						this.onEvent(session.id, message.event, message.body)
				},
			}),
		})
		if (tracker) this.subscriptions.push(tracker)
		if (debugApi.activeDebugSession) this.track(debugApi.activeDebugSession)
	}

	async dispatch(request: DapRequest): Promise<Record<string, unknown>> {
		if (request.kind === "bus" && request.action === "sessions") {
			return {
				action: "sessions",
				success: true,
				data: [...this.sessions.values()].map(({ session, parentSessionId }) => ({
					id: session.id,
					name: session.name,
					type: session.type,
					parentSessionId,
				})),
			}
		}
		if (!DAP_ACTIONS.includes(request.action as DapAction))
			return this.failure(
				`unknown DAP action: ${request.action}. Use one of: ${DAP_ACTIONS.join(", ")} (kind "dap"), or "sessions" (kind "bus").`,
			)

		const action = request.action as DapAction
		if (action === "launch" || action === "attach") {
			if (!request.configuration) return this.failure(`${action} requires configuration`)
			// An attach with nothing to attach to waits for a connection that never comes.
			if (
				action === "attach" &&
				!["connect", "port", "processId", "address"].some((key) => key in request.configuration!)
			)
				return this.failure(
					'attach needs "connect" {host, port}, "port" or "processId" in configuration. To debug a script, use action "launch" with "program".',
				)
			const type = typeof request.configuration.type === "string" ? request.configuration.type : undefined
			try {
				await this.ensureDebugger(type)
				// Breakpoints go in before the program starts, or a short program finishes first.
				const breakpoints = parseBreakpoints(request.arguments?.breakpoints)
				if (breakpoints.length > 0) this.debugApi.addBreakpoints?.(breakpoints.map(toSourceBreakpoint))
				const sessionId = this.nextSessionId()
				const started = await this.debugApi.startDebugging(undefined, {
					...request.configuration,
					request: action,
				})
				if (!started)
					return this.failure(
						`VS Code did not start the "${type ?? "unknown"}" debug session. Check the configuration ` +
							"(type, program path, cwd); the adapter's message is in the Debug Console.",
					)
				const id = await sessionId
				const waitMs = numberArgument(request.arguments?.waitForStopMs) ?? (breakpoints.length > 0 ? 30_000 : 0)
				const state = id && waitMs > 0 ? await this.waitForStop(id, waitMs) : undefined
				return { action, success: true, data: { sessionId: id, ...state } }
			} catch (error) {
				return this.failure(error)
			}
		}

		if (!request.sessionId) return this.failure(`${action} requires sessionId`)
		const tracked = this.sessions.get(request.sessionId)
		if (!tracked) return this.failure(`debug session not found: ${request.sessionId}`)
		if (action === "output") return { action, success: true, data: tracked.output }
		if (action === "wait_for_stop") {
			const state = await this.waitForStop(
				tracked.session.id,
				numberArgument(request.arguments?.timeoutMs) ?? 30_000,
			)
			return { action, success: true, data: state }
		}
		if (action === "terminate") {
			try {
				await this.debugApi.stopDebugging(tracked.session)
				return { action, success: true }
			} catch (error) {
				return this.failure(error)
			}
		}

		const command = action === "custom_request" ? request.command : COMMANDS[action]
		if (!command) return this.failure("custom_request requires command")
		const args = { ...request.arguments }
		if (["continue", "step_over", "step_in", "step_out", "pause"].includes(action)) {
			if (args.threadId === undefined && tracked.stoppedThreadId !== undefined)
				args.threadId = tracked.stoppedThreadId
		}
		try {
			const data = await tracked.session.customRequest(command, args)
			// Adapters need not send "continued" after continue/step; the thread runs until the next "stopped".
			if (["continue", "step_over", "step_in", "step_out"].includes(action)) tracked.state = "running"
			return { action, success: true, data }
		} catch (error) {
			return this.failure(error)
		}
	}

	dispose(): void {
		for (const subscription of this.subscriptions) subscription.dispose()
		this.sessions.clear()
	}

	private track(session: vscode.DebugSession): void {
		if (this.sessions.has(session.id)) return
		this.sessions.set(session.id, {
			session,
			parentSessionId: session.parentSession?.id,
			state: "running",
			output: [],
			waiters: [],
		})
		for (const resolve of this.sessionStarted.splice(0)) resolve(session.id)
	}

	/** The id of the next session to start, or undefined if none starts in time. */
	private nextSessionId(): Promise<string | undefined> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const index = this.sessionStarted.indexOf(done)
				if (index >= 0) this.sessionStarted.splice(index, 1)
				resolve(undefined)
			}, this.sessionWaitMs)
			const done = (id: string) => {
				clearTimeout(timer)
				resolve(id)
			}
			this.sessionStarted.push(done)
		})
	}

	/** Resolve once the session stops or ends, or report that it is still running. */
	private async waitForStop(sessionId: string, timeoutMs: number): Promise<Record<string, unknown>> {
		const tracked = this.sessions.get(sessionId)
		if (!tracked) return { state: "unknown" }
		if (tracked.state === "running") {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(finish, timeoutMs)
				function finish() {
					clearTimeout(timer)
					resolve()
				}
				tracked.waiters.push(finish)
			})
		}
		return { state: tracked.state, threadId: tracked.stoppedThreadId, reason: tracked.stopReason }
	}

	private onEvent(sessionId: string, event: string, body: Record<string, unknown> | undefined): void {
		const tracked = this.sessions.get(sessionId)
		if (!tracked) return
		if (event === "stopped") {
			if (typeof body?.threadId === "number") tracked.stoppedThreadId = body.threadId
			tracked.state = "stopped"
			tracked.stopReason = typeof body?.reason === "string" ? body.reason : undefined
		} else if (event === "continued") {
			tracked.state = "running"
		} else if (event === "terminated" || event === "exited") {
			tracked.state = "terminated"
		} else if (event === "output") {
			tracked.output.push(body)
			if (tracked.output.length > this.outputLimit)
				tracked.output.splice(0, tracked.output.length - this.outputLimit)
			return
		} else {
			return
		}
		for (const resolve of tracked.waiters.splice(0)) resolve()
	}

	private failure(error: unknown): Record<string, unknown> {
		return { success: false, error: error instanceof Error ? error.message : String(error) }
	}
}

function numberArgument(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function toSourceBreakpoint(breakpoint: DapBreakpoint): vscode.SourceBreakpoint {
	const location = new vscode.Location(vscode.Uri.file(breakpoint.path), new vscode.Position(breakpoint.line - 1, 0))
	return new vscode.SourceBreakpoint(location, true, breakpoint.condition)
}
