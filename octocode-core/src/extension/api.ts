import { EventEmitter } from "events"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import * as vscode from "vscode"

import {
	type RooCodeAPI,
	type RooCodeSettings,
	type RooCodeEvents,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type TaskEvent,
	RooCodeEventName,
	TaskCommandName,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
} from "@roo-code/types"
import { IpcServer } from "@roo-code/ipc"

import { Package } from "../shared/package"
import type { Mode } from "../shared/modes"
import { ClineProvider } from "../core/webview/ClineProvider"
import { Terminal } from "../integrations/terminal/Terminal"
import { TerminalRegistry } from "../integrations/terminal/TerminalRegistry"
import { openClineInNewTab } from "../activate/registerCommands"
import { getCommands } from "../services/command/commands"
import { getOctoCodeRuntime } from "../services/octocode-runtime/OctoCodeRuntime"
import { webviewMessageHandler } from "../core/webview/webviewMessageHandler"
import type { HistoryItem, RuntimeSession, QueuedMessage } from "@roo-code/types"

export class API extends EventEmitter<RooCodeEvents> implements RooCodeAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: ClineProvider
	private readonly context: vscode.ExtensionContext
	private readonly ipc?: IpcServer
	private readonly log: (...args: unknown[]) => void
	private logfile?: string

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: ClineProvider,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider
		this.context = provider.context

		if (enableLogging) {
			this.log = (...args: unknown[]) => {
				this.outputChannelLog(...args)
				console.log(args)
			}

			this.logfile = path.join(os.tmpdir(), "octocode-api.log")
		} else {
			this.log = () => {}
		}

		this.registerListeners()

		if (socketPath) {
			const ipc = (this.ipc = new IpcServer(socketPath, this.log))

			ipc.listen()
			this.log(`[API] ipc server started: socketPath=${socketPath}, pid=${process.pid}, ppid=${process.ppid}`)

			ipc.on(IpcMessageType.TaskCommand, async (clientId, command) => {
				const sendResponse = (eventName: RooCodeEventName, payload: unknown[]) => {
					ipc.send(clientId, {
						type: IpcMessageType.TaskEvent,
						origin: IpcOrigin.Server,
						data: { eventName, payload } as TaskEvent,
					})
				}

				switch (command.commandName) {
					case TaskCommandName.StartNewTask:
						this.log(
							`[API] StartNewTask -> ${command.data.text}, ${JSON.stringify(command.data.configuration)}`,
						)
						await this.startNewTask(command.data)
						break
					case TaskCommandName.CancelTask:
						this.log(`[API] CancelTask`)
						await this.cancelCurrentTask()
						break
					case TaskCommandName.CloseTask:
						this.log(`[API] CloseTask`)
						await vscode.commands.executeCommand("workbench.action.files.saveFiles")
						await vscode.commands.executeCommand("workbench.action.closeWindow")
						break
					case TaskCommandName.ResumeTask:
						this.log(`[API] ResumeTask -> ${command.data}`)
						try {
							await this.resumeTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ResumeTask failed for taskId ${command.data}: ${errorMessage}`)
							// Don't rethrow - we want to prevent IPC server crashes.
							// The error is logged for debugging purposes.
						}
						break
					case TaskCommandName.SendMessage:
						this.log(`[API] SendMessage -> ${command.data.text}`)
						await this.sendMessage(command.data.text, command.data.images)
						break
					case TaskCommandName.GetCommands:
						try {
							const commands = await getCommands(this.sidebarProvider.cwd)

							sendResponse(RooCodeEventName.CommandsResponse, [
								commands.map((cmd) => ({
									name: cmd.name,
									source: cmd.source,
									filePath: cmd.filePath,
									description: cmd.description,
									argumentHint: cmd.argumentHint,
								})),
							])
						} catch (error) {
							sendResponse(RooCodeEventName.CommandsResponse, [[]])
						}

						break
					case TaskCommandName.GetModes:
						try {
							const modes = await this.sidebarProvider.getModes()
							sendResponse(RooCodeEventName.ModesResponse, [modes])
						} catch (error) {
							sendResponse(RooCodeEventName.ModesResponse, [[]])
						}

						break
					case TaskCommandName.GetModels:
						try {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						} catch (error) {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						}

						break
					case TaskCommandName.DeleteQueuedMessage:
						this.log(`[API] DeleteQueuedMessage -> ${command.data}`)
						try {
							await this.deleteQueuedMessage(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] DeleteQueuedMessage failed for messageId ${command.data}: ${errorMessage}`)
						}
						break
				}
			})
		}
	}

	public override emit<K extends keyof RooCodeEvents>(
		eventName: K,
		...args: K extends keyof RooCodeEvents ? RooCodeEvents[K] : never
	) {
		const data = { eventName: eventName as RooCodeEventName, payload: args } as TaskEvent
		this.ipc?.broadcast({ type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data })
		return super.emit(eventName, ...args)
	}

	public async startNewTask({
		configuration = {},
		text,
		images,
		newTab,
	}: {
		configuration?: RooCodeSettings
		text?: string
		images?: string[]
		newTab?: boolean
	}) {
		let provider: ClineProvider

		if (newTab) {
			provider = await openClineInNewTab({ context: this.context, outputChannel: this.outputChannel })
		} else {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)

			provider = this.sidebarProvider
		}

		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		const task = await provider.startRuntimeTask(text ?? "", images, undefined, configuration)
		return task.sessionId
	}

	public async resumeTask(sessionId: string): Promise<void> {
		await webviewMessageHandler(this.sidebarProvider, { type: "openRuntimeSession", text: sessionId })
		await this.continueSession(sessionId, "继续执行此任务，保留原有目标与约束。", [])
	}

	public async isTaskInHistory(sessionId: string): Promise<boolean> {
		return Boolean(await getOctoCodeRuntime().call<RuntimeSession | null>("session.get", { id: sessionId }))
	}

	// External compatibility projection only. Runtime Host remains the only persisted history.
	public async getTaskHistoryItem(sessionId: string): Promise<HistoryItem | undefined> {
		const session = await getOctoCodeRuntime().call<RuntimeSession | null>("session.get", { id: sessionId })
		if (!session) return undefined
		return {
			id: session.id,
			number: 0,
			ts: session.updated_at,
			task: session.title,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: session.workspace ?? undefined,
			status:
				session.status === "running" ? "active" : session.status === "completed" ? "completed" : "interrupted",
		}
	}

	public async getTaskApiConversationHistoryLength(sessionId: string): Promise<number> {
		return (await getOctoCodeRuntime().call<unknown[]>("message.list", { session_id: sessionId })).length
	}

	public getCurrentTaskStack(): string[] {
		const current = ClineProvider.getActiveRuntimeTask()
		return current ? [current.sessionId] : []
	}

	public async clearCurrentTask(_lastMessage?: string): Promise<void> {
		const task = ClineProvider.getActiveRuntimeTask()
		if (task) ClineProvider.clearActiveRuntimeSession(task.sessionId)
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
	}

	public async cancelCurrentTask(): Promise<void> {
		const task = ClineProvider.getActiveRuntimeTask()
		if (task) await getOctoCodeRuntime().call("agent.cancel", { task_id: task.taskId })
	}

	public async abandonSubtask(_childTaskId: string): Promise<boolean> {
		throw new Error("旧委派任务协议已停用；请使用 Runtime 会话接续。")
	}

	private async continueSession(sessionId: string, text: string, images: string[]): Promise<void> {
		const runtime = getOctoCodeRuntime()
		if (runtime.replyUserInput(sessionId, text)) return
		const state = await this.sidebarProvider.getState()
		const session = await runtime.call<RuntimeSession | null>("session.get", { id: sessionId })
		if (!session) throw new Error("Runtime session not found")
		if (session.status === "running") {
			await runtime.enqueue(sessionId, text, images, state.apiConfiguration, state.permissionProfile ?? "full")
			return
		}
		const task = await runtime.prepareContinuation(sessionId, text, state.apiConfiguration, images)
		ClineProvider.setActiveRuntimeSession(task.sessionId, task.taskId, task.workingDirectory)
		await this.sidebarProvider.postMessageToWebview({
			type: "runtimeTaskStarted",
			payload: { sessionId: task.sessionId, taskId: task.taskId, prompt: text, images },
		})
		try {
			await runtime.runPreparedAgentTask(task, text, images, true, state.permissionProfile ?? "full")
		} catch (error) {
			await this.sidebarProvider.reportRuntimeFailure(task, error)
			throw error
		}
	}

	public async sendMessage(text = "", images: string[] = []): Promise<void> {
		const task = ClineProvider.getActiveRuntimeTask()
		if (!task) throw new Error("No selected Runtime session")
		await this.continueSession(task.sessionId, text, images)
	}

	public async deleteQueuedMessage(messageId: string): Promise<void> {
		const task = ClineProvider.getActiveRuntimeTask()
		if (!task) throw new Error("No selected Runtime session")
		await getOctoCodeRuntime().editQueue(task.sessionId, (queue) =>
			queue.filter((message) => message.id !== messageId),
		)
	}

	public async pressPrimaryButton(): Promise<void> {
		await this.approveCurrentAsk()
	}
	public async pressSecondaryButton(): Promise<void> {
		await this.cancelCurrentTask()
	}
	public async approveCurrentAsk(): Promise<void> {
		const task = ClineProvider.getActiveRuntimeTask()
		if (task && !getOctoCodeRuntime().replyUserInput(task.sessionId, "确认"))
			throw new Error("No pending Runtime question")
	}
	public isReady(): boolean {
		return this.sidebarProvider.viewLaunched
	}

	private registerListeners(): void {
		this.context.subscriptions.push(
			getOctoCodeRuntime().onEvent((event) => {
				const id = event.session_id
				if (event.kind === "agent.started") {
					this.emit(RooCodeEventName.TaskCreated, id)
					this.emit(RooCodeEventName.TaskStarted, id)
				}
				if (event.kind === "agent.needs_input") this.emit(RooCodeEventName.TaskInteractive, id)
				if (event.kind === "agent.error") this.emit(RooCodeEventName.TaskAborted, id)
				if (event.kind === "agent.finished") this.emit(RooCodeEventName.TaskIdle, id)
				if (event.kind === "runtime.queue")
					this.emit(
						RooCodeEventName.QueuedMessagesUpdated,
						id,
						(event.payload as { queue: QueuedMessage[] }).queue,
					)
				void this.fileLog(JSON.stringify(event) + "\n")
			}),
		)
	}

	// Logging

	private outputChannelLog(...args: unknown[]) {
		for (const arg of args) {
			if (arg === null) {
				this.outputChannel.appendLine("null")
			} else if (arg === undefined) {
				this.outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				this.outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				this.outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					this.outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch (error) {
					this.outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}

	private async fileLog(message: string) {
		if (!this.logfile) {
			return
		}

		try {
			await fs.appendFile(this.logfile, message, "utf8")
		} catch (_) {
			this.logfile = undefined
		}
	}

	// Global Settings Management

	public getConfiguration(): RooCodeSettings {
		return Object.fromEntries(
			Object.entries(this.sidebarProvider.getValues()).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	public async setConfiguration(values: RooCodeSettings) {
		await this.sidebarProvider.contextProxy.setValues(values)
		await this.sidebarProvider.providerSettingsManager.saveConfig(values.currentApiConfigName || "default", values)
		if (values.modeApiConfigs) {
			await Promise.all(
				Object.entries(values.modeApiConfigs).map(([mode, configId]) =>
					this.sidebarProvider.providerSettingsManager.setModeConfig(mode as Mode, configId),
				),
			)
		}
		await this.sidebarProvider.postStateToWebview()
	}

	public setTerminalProfile(name: string | undefined): void {
		const previousProfile = Terminal.getTerminalProfile()
		Terminal.setTerminalProfile(name)

		if (Terminal.getTerminalProfile() !== previousProfile) {
			TerminalRegistry.closeIdleTerminals()
		}
	}

	// Provider Profile Management

	public getProfiles(): string[] {
		return this.sidebarProvider.getProviderProfileEntries().map(({ name }) => name)
	}

	public getProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.sidebarProvider.getProviderProfileEntry(name)
	}

	public async createProfile(name: string, profile?: ProviderSettings, activate: boolean = true) {
		const entry = this.getProfileEntry(name)

		if (entry) {
			throw new Error(`Profile with name "${name}" already exists`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile ?? {}, activate)

		if (!id) {
			throw new Error(`Failed to create profile with name "${name}"`)
		}

		return id
	}

	public async updateProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to update profile with name "${name}"`)
		}

		return id
	}

	public async upsertProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to upsert profile with name "${name}"`)
		}

		return id
	}

	public async deleteProfile(name: string): Promise<void> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.deleteProviderProfile(entry)
	}

	public getActiveProfile(): string | undefined {
		return this.getConfiguration().currentApiConfigName
	}

	public async setActiveProfile(name: string): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.activateProviderProfile({ name })
		return this.getActiveProfile()
	}
}
