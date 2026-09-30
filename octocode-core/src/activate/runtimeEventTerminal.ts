import * as vscode from "vscode"
import * as path from "node:path"
import { StringDecoder } from "node:string_decoder"

import { getShell } from "../utils/shell"
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
type InteractiveShell = {
	kill(): void
	onData(callback: (data: string) => void): unknown
	onExit(callback: (event: { exitCode: number }) => void): unknown
	resize(columns: number, rows: number): void
	write(data: string): void
}
type SpawnInteractiveShell = (dimensions?: vscode.TerminalDimensions) => InteractiveShell

const spawnInteractiveShell: SpawnInteractiveShell = (dimensions) => {
	const nodePty = require(path.join(vscode.env.appRoot, "node_modules.asar", "node-pty")) as {
		spawn: (file: string, args: string[], options: Record<string, unknown>) => InteractiveShell
	}
	const shell = getShell()
	const args = /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell) ? ["-NoLogo"] : []
	return nodePty.spawn(shell, args, {
		cols: dimensions?.columns ?? 120,
		cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
		env: process.env,
		name: "xterm-256color",
		rows: dimensions?.rows ?? 30,
	})
}

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
	private onDidClose?: () => void
	private suppressCloseNotification = false
	private writeEmitter?: vscode.EventEmitter<string>
	private terminal?: vscode.Terminal
	constructor(
		private readonly createEmitter = () => new vscode.EventEmitter<string>(),
		private readonly spawnShell = spawnInteractiveShell,
	) {}

	setOnDidClose(callback?: () => void): void {
		this.onDidClose = callback
	}

	/**
	 * @param location Where the terminal is hosted. A `ViewColumn` puts it in an
	 * editor group; `TerminalLocation.Panel` puts it in the bottom panel.
	 * The OctoCode workbench uses the third editor group (lower right).
	 */
	open(location: vscode.ViewColumn | vscode.TerminalLocation): vscode.Terminal {
		if (this.terminal && this.terminal.exitStatus === undefined) return this.terminal
		this.terminal = undefined
		const writeEmitter = this.createEmitter()
		this.writeEmitter = writeEmitter
		let shell: InteractiveShell | undefined
		const pty: vscode.Pseudoterminal = {
			onDidWrite: writeEmitter.event,
			open: (dimensions) => {
				try {
					const openedShell = this.spawnShell(dimensions)
					shell = openedShell
					shell.onData((data) => writeEmitter.fire(data))
					shell.onExit(({ exitCode }) => {
						if (shell !== openedShell) return
						shell = undefined
						writeEmitter.fire(`\r\n[PowerShell exited: ${exitCode}]\r\n`)
					})
				} catch (error) {
					writeEmitter.fire(
						`\r\n[PowerShell unavailable: ${error instanceof Error ? error.message : String(error)}]\r\n`,
					)
				}
			},
			handleInput: (data) => shell?.write(data),
			setDimensions: ({ columns, rows }) => shell?.resize(columns, rows),
			close: () => {
				shell?.kill()
				shell = undefined
				if (this.terminal === terminal) {
					this.terminal = undefined
					this.executions.clear()
					if (!this.suppressCloseNotification) this.onDidClose?.()
				}
			},
		}
		const terminal = vscode.window.createTerminal({
			name: t("common:ui.runtimeTerminal"),
			pty,
			location:
				location === vscode.TerminalLocation.Panel
					? vscode.TerminalLocation.Panel
					: { viewColumn: location as vscode.ViewColumn, preserveFocus: true },
		})
		return (this.terminal = terminal)
	}

	async show(): Promise<void> {
		const terminal = this.open(vscode.ViewColumn.Three)
		await this.restorePosition()
		terminal.show(true)
	}

	async restorePosition(): Promise<void> {
		if (this.terminal && this.terminal.exitStatus === undefined) {
			await vscode.commands.executeCommand("workbench.action.octocode.placeRuntimeTerminal", this.terminal.name)
		}
	}

	/**
	 * Forget the terminal without opening another.
	 *
	 * Only tests need this, and they need it badly: the terminal is cached on this
	 * singleton, so one test that opens the workbench leaves the next one unable
	 * to observe its own `createTerminal` mock — the cached instance is returned
	 * instead and the mock is never called. That failure names the innocent test.
	 */
	forget(): void {
		const terminal = this.terminal
		this.terminal = undefined
		this.suppressCloseNotification = true
		try {
			terminal?.dispose()
		} finally {
			this.suppressCloseNotification = false
		}
	}

	reopen(location: vscode.ViewColumn | vscode.TerminalLocation): vscode.Terminal {
		const terminal = this.terminal
		this.terminal = undefined
		this.suppressCloseNotification = true
		try {
			terminal?.dispose()
		} finally {
			this.suppressCloseNotification = false
		}
		return this.open(location)
	}

	accept(event: RuntimeAgentEvent): void {
		const text = terminalEventText(event, this.executions)
		if (text) this.writeEmitter?.fire(text)
	}
}

export const runtimeEventTerminal = new RuntimeEventTerminal()
