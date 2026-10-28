import * as vscode from "vscode"
import * as path from "node:path"
import { StringDecoder } from "node:string_decoder"

import { getShell } from "../utils/shell"
import { getWorkspacePath } from "../utils/path"
import { t } from "../i18n"

export type RuntimeAgentEvent = {
	task_id: string
	session_id: string
	kind: string
	payload: unknown
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

type TerminalOutput = { bytes?: number[]; delta: boolean; found: boolean; text: string }
type TerminalExecution = { decoder: StringDecoder; output: string; status: string }
const terminalOutput = (value: unknown): TerminalOutput => {
	if (typeof value === "string") return { delta: false, found: true, text: value }
	if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
		return { bytes: value as number[], delta: false, found: true, text: "" }
	}
	const output = record(value)
	if (!output) return { delta: false, found: false, text: "" }
	for (const key of ["output_delta", "output", "stdout", "stderr", "text", "data"] as const) {
		if (!(key in output)) continue
		const nested = terminalOutput(output[key])
		return { ...nested, delta: key === "output_delta" || nested.delta }
	}
	if (Array.isArray(output.content)) {
		return {
			delta: false,
			found: true,
			text: output.content
				.map((item) => record(item)?.text)
				.filter((text): text is string => typeof text === "string")
				.join("\n"),
		}
	}
	if ("content" in output) return terminalOutput(output.content)
	return { delta: false, found: false, text: "" }
}

const SUPERVISOR_LABELS: Record<string, string> = {
	fallback: "模型回退",
	endpoint_retry: "端点重试",
	rule: "规则纠正",
	stall: "重复调用纠正",
	review: "复核意见",
	review_ok: "复核通过",
	review_skipped: "复核跳过",
}

function supervisorText(payload: Record<string, unknown>): string | undefined {
	const label = typeof payload.action === "string" ? SUPERVISOR_LABELS[payload.action] : undefined
	if (!label) return undefined
	const detail = typeof payload.detail === "string" && payload.detail ? `: ${payload.detail}` : ""
	return `\x1b[33m[OctoCode ${label}]${detail}\x1b[0m\r\n`
}

export function terminalEventText(
	event: RuntimeAgentEvent,
	executions: Map<string, TerminalExecution>,
): string | undefined {
	const payload = record(event.payload)
	if (!payload) return undefined
	if (event.kind === "agent.error") {
		const message =
			typeof payload.message === "string"
				? payload.message
				: typeof payload.error === "string"
					? payload.error
					: "Runtime execution failed"
		return `\x1b[31m[OctoCode error] ${message.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`
	}
	if (event.kind === "agent.supervisor") return supervisorText(payload)
	const id = typeof payload.toolCallId === "string" ? payload.toolCallId : ""
	if (event.kind === "tool_call") {
		if (payload.kind !== "execute" || !id) return undefined
		executions.set(id, { decoder: new StringDecoder("utf8"), output: "", status: "" })
		const input = record(payload.rawInput)
		const command =
			typeof input?.command === "string" ? input.command : String(payload.title ?? payload.toolName ?? "")
		return command ? `> ${command}\r\n` : undefined
	}
	if (event.kind !== "tool_call_update" || !id || !executions.has(id)) return undefined
	const execution = executions.get(id)!
	const status = typeof payload.status === "string" ? payload.status : ""
	const parsed = terminalOutput(payload.rawOutput)
	const value = parsed.found ? parsed : terminalOutput(payload)
	if (value.delta && value.bytes?.length === 0) {
		execution.decoder = new StringDecoder("utf8")
		execution.output = ""
	}
	const decoded = value.bytes
		? value.delta
			? execution.decoder.write(Buffer.from(value.bytes))
			: Buffer.from(value.bytes).toString("utf8")
		: value.text
	const output = value.delta
		? decoded
		: decoded.startsWith(execution.output)
			? decoded.slice(execution.output.length)
			: decoded
	execution.output = value.delta ? execution.output + decoded : decoded || execution.output
	const statusChanged = status && status !== execution.status
	execution.status = status || execution.status
	if (status === "completed" || status === "failed") executions.delete(id)
	const normalized = output.replace(/\r?\n/g, "\r\n")
	return (
		`${normalized ? `${normalized}${normalized.endsWith("\r\n") ? "" : "\r\n"}` : ""}${statusChanged ? `[${status}]\r\n` : ""}` ||
		undefined
	)
}

export function runtimeEventArtifactPath(event: RuntimeAgentEvent): string | undefined {
	if (event.kind !== "tool_call") return undefined
	const payload = record(event.payload)
	if (!payload || payload.kind === "execute") return undefined
	const input = record(payload.rawInput)
	for (const key of ["target_file", "file_path", "path", "absolute_path"] as const) {
		if (typeof input?.[key] === "string" && input[key]) return input[key]
	}
	return undefined
}

export class RuntimeEventTerminal {
	private readonly executions = new Map<string, TerminalExecution>()
	private terminal?: vscode.Terminal
	private closeSubscription?: vscode.Disposable
	private pendingOutput: string[] = []
	private workingDirectory?: string
	private onDidClose?: () => void

	constructor(
		private readonly terminalName = t("common:ui.runtimeTerminal"),
		private readonly sessionScoped = false,
	) {}

	setOnDidClose(callback?: () => void): void {
		this.onDidClose = callback
	}

	currentTerminal(): vscode.Terminal | undefined {
		return this.terminal
	}

	hasWorkingDirectory(): boolean {
		return Boolean(this.workingDirectory)
	}

	setWorkingDirectory(directory: string): void {
		if (!path.isAbsolute(directory)) throw new Error("Session working directory must be absolute")
		if (this.workingDirectory === directory) return
		if (this.terminal) this.forget()
		this.workingDirectory = directory
	}

	open(location: vscode.ViewColumn | vscode.TerminalLocation): vscode.Terminal {
		if (this.terminal && this.terminal.exitStatus === undefined) return this.terminal
		if (this.sessionScoped && !this.workingDirectory) throw new Error("Session working directory unavailable")
		this.closeSubscription?.dispose()
		this.closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
			if (closed !== this.terminal) return
			this.terminal = undefined
			this.executions.clear()
			this.closeSubscription?.dispose()
			this.closeSubscription = undefined
			this.onDidClose?.()
		})
		const shell = getShell()
		this.terminal = vscode.window.createTerminal({
			name: this.terminalName,
			// Session owners are recreated on restart; stale restored shells must not share their names.
			isTransient: true,
			shellPath: shell,
			shellArgs: /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell) ? ["-NoLogo"] : [],
			cwd: this.workingDirectory ?? getWorkspacePath(),
			location:
				location === vscode.TerminalLocation.Panel
					? vscode.TerminalLocation.Panel
					: { viewColumn: location as vscode.ViewColumn, preserveFocus: true },
		})
		for (const message of this.pendingOutput.splice(0)) this.write(message)
		return this.terminal
	}

	async show(): Promise<void> {
		const terminal = this.open(vscode.ViewColumn.Three)
		await this.restorePosition()
		terminal.show(true)
	}

	async reportArtifactFailure(name: string, showTerminal = true): Promise<void> {
		if (showTerminal) await this.show()
		this.write(`\r\n[Artifact] 无法预览文件：${name}。请检查工具返回的实际文件路径。\r\n`)
	}

	private write(message: string): void {
		if (!this.terminal) {
			this.pendingOutput.push(message)
			return
		}
		// Display agent output without sending it to the native shell as executable input.
		void vscode.commands
			.executeCommand("workbench.action.octocode.writeRuntimeTerminal", this.terminal.name, message)
			.then(undefined, (error) => console.error("Unable to display OctoCode terminal output", error))
	}

	async restorePosition(): Promise<void> {
		if (this.terminal && this.terminal.exitStatus === undefined)
			await vscode.commands.executeCommand("workbench.action.octocode.placeRuntimeTerminal", this.terminal.name)
	}

	forget(): void {
		const terminal = this.terminal
		this.terminal = undefined
		this.closeSubscription?.dispose()
		this.closeSubscription = undefined
		this.pendingOutput = []
		terminal?.dispose()
	}

	reopen(location: vscode.ViewColumn | vscode.TerminalLocation): vscode.Terminal {
		this.forget()
		return this.open(location)
	}

	accept(event: RuntimeAgentEvent): void {
		const text = terminalEventText(event, this.executions)
		if (text) this.write(text)
	}
}

export class SessionRuntimeEventTerminals {
	private readonly terminals = new Map<string, RuntimeEventTerminal>()
	private readonly releasedSessions = new Set<string>()
	private activeSessionId?: string
	private readonly unassigned: RuntimeEventTerminal
	private onDidClose?: () => void
	constructor(
		private readonly createTerminal = (sessionId?: string) =>
			new RuntimeEventTerminal(
				sessionId ? `${t("common:ui.runtimeTerminal")} (${sessionId})` : t("common:ui.runtimeTerminal"),
				Boolean(sessionId),
			),
		private readonly resolveDirectory = async (sessionId: string): Promise<string | undefined> => {
			const { getOctoCodeRuntime } = await import("../services/octocode-runtime/OctoCodeRuntime")
			const result = await getOctoCodeRuntime().call<{ working_directory?: string }>(
				"session.working_directory",
				{ id: sessionId },
			)
			return result.working_directory
		},
	) {
		this.unassigned = createTerminal()
	}

	private get active(): RuntimeEventTerminal {
		if (!this.activeSessionId) return this.unassigned
		return this.forSession(this.activeSessionId)
	}

	private forSession(sessionId: string): RuntimeEventTerminal {
		let terminal = this.terminals.get(sessionId)
		if (!terminal) {
			terminal = this.createTerminal(sessionId)
			terminal.setOnDidClose(this.onDidClose)
			this.terminals.set(sessionId, terminal)
		}
		return terminal
	}

	setOnDidClose(callback?: () => void): void {
		this.onDidClose = callback
		this.unassigned.setOnDidClose(callback)
		for (const terminal of this.terminals.values()) terminal.setOnDidClose(callback)
	}

	setSessionWorkingDirectory(sessionId: string, directory: string): void {
		if (this.releasedSessions.has(sessionId)) return
		this.forSession(sessionId).setWorkingDirectory(directory)
	}

	setActiveSession(sessionId?: string): void {
		if (sessionId && this.releasedSessions.has(sessionId)) return
		if (sessionId === this.activeSessionId) return
		this.active.currentTerminal()?.hide?.()
		this.activeSessionId = sessionId
		void this.show().catch((error) => console.error("Unable to open OctoCode session terminal", error))
	}

	releaseSession(sessionId: string): void {
		if (this.activeSessionId === sessionId) this.setActiveSession(undefined)
		const terminal = this.terminals.get(sessionId)
		this.terminals.delete(sessionId)
		terminal?.forget()
		this.releasedSessions.add(sessionId)
	}

	open(location: vscode.ViewColumn | vscode.TerminalLocation): vscode.Terminal {
		return this.active.open(location)
	}

	async show(): Promise<void> {
		const sessionId = this.activeSessionId

		const owner = this.active
		if (sessionId && !owner.hasWorkingDirectory()) {
			const directory = await this.resolveDirectory(sessionId)
			if (this.activeSessionId !== sessionId || this.releasedSessions.has(sessionId)) return
			if (!directory) throw new Error("Session working directory unavailable")
			owner.setWorkingDirectory(directory)
		}
		const terminal = owner.open(vscode.ViewColumn.Three)
		await owner.restorePosition()
		if (this.activeSessionId === sessionId) terminal.show(true)
	}

	restorePosition(): Promise<void> {
		return this.active.restorePosition()
	}

	reopen(location: vscode.ViewColumn | vscode.TerminalLocation): vscode.Terminal {
		return this.active.reopen(location)
	}

	forget(): void {
		this.unassigned.forget()
		for (const terminal of this.terminals.values()) terminal.forget()
		this.terminals.clear()
		this.releasedSessions.clear()
		this.activeSessionId = undefined
	}

	accept(event: RuntimeAgentEvent): void {
		if (this.releasedSessions.has(event.session_id)) return
		this.forSession(event.session_id).accept(event)
	}

	async reportArtifactFailure(name: string, sessionId = this.activeSessionId): Promise<void> {
		if (sessionId && this.releasedSessions.has(sessionId)) return
		const owner = sessionId ? this.forSession(sessionId) : this.active
		if (sessionId === this.activeSessionId) await this.show()
		await owner.reportArtifactFailure(name, false)
	}
}

export const runtimeEventTerminal = new SessionRuntimeEventTerminals()
