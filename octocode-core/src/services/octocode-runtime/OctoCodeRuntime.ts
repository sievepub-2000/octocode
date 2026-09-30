import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import * as vscode from "vscode"
import {
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	getModelId,
	withResolvedThinking,
	type GlobalSettings,
	type PermissionProfile,
	type ProviderSettings,
	type QueuedMessage,
	type RuntimeEvent,
	type RuntimeTask,
} from "@roo-code/types"
import type { WorkbenchMcpServer } from "../workbench-mcp/WorkbenchMcpServer"
import { ModelsApiManager, type ProviderRoute } from "../models-api/ModelsApiManager"
import { compressionBudget, type ModelContext } from "../models-api/ModelContext"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { getBinPath as getRipgrepPath } from "../ripgrep"
import { Package } from "../../shared/package"
import { configuredWorkspacePath } from "../../utils/defaultWorkspace"
import { TaskApprovals, type ApprovalTask } from "./TaskApprovals"

export type { RuntimeEvent, RuntimeTask } from "@roo-code/types"
export type PreparedTask = RuntimeTask & {
	route: ProviderRoute
	profileId?: string
	autoCompactThresholdPercent?: number
	providerSettings?: ProviderSettings
	workingDirectory?: string
	permissionProfile?: PermissionProfile
}
export type PreparedHandoff = PreparedTask & { prompt: string; displayPrompt: string; images: string[] }
export type NeedsInputResult = { status: "needs_input"; question: string; options?: string[] }
export type UserInputReply = { answer: string; timedOut?: boolean }

/** Default wait for an answer before the agent decides on its own (seconds; 0 waits forever). */
export const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 180

export function unansweredReply(seconds: number): UserInputReply {
	return {
		answer: `The user did not reply within ${seconds} seconds. Do not wait: choose the most reasonable option yourself, state the assumption you made, and continue the task.`,
		timedOut: true,
	}
}

export const MAX_AGENT_TURNS = 1_000

export function resolveAutoCompactThreshold(
	settings: Pick<GlobalSettings, "autoCondenseContext" | "autoCondenseContextPercent" | "profileThresholds">,
	profileId?: string,
): number {
	if (settings.autoCondenseContext === false) return 0
	const valid = (value: unknown): value is number =>
		Number.isInteger(value) && typeof value === "number" && value >= 10 && value <= 100
	const override = profileId ? settings.profileThresholds?.[profileId] : undefined
	if (valid(override)) return override
	return valid(settings.autoCondenseContextPercent)
		? settings.autoCondenseContextPercent
		: DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT
}

type RuntimeResponse = { id: number; result?: unknown; error?: { code: number; message: string } }
type Pending = {
	method: string
	startedAt: number
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	timer: NodeJS.Timeout
}

type PendingUserInput = {
	sessionId: string
	resolve: (reply: UserInputReply) => void
	reject: (error: Error) => void
}

export class OctoCodeRuntime implements vscode.Disposable {
	private process?: ChildProcessWithoutNullStreams
	private starting?: Promise<void>
	private disposed = false
	private nextId = 1
	private readonly pending = new Map<number, Pending>()
	private readonly pendingUserInput = new Map<string, PendingUserInput>()
	private approvals?: TaskApprovals
	private readonly eventEmitter = new vscode.EventEmitter<RuntimeEvent>()
	private readonly modelsApi: ModelsApiManager
	private readonly runningSessions = new Map<string, string>()
	private readonly sessionSettings = new Map<
		string,
		{ settings: ProviderSettings; permission: PermissionProfile; profileId?: string }
	>()
	private readonly cancelledTasks = new Set<string>()
	private readonly drainingSessions = new Map<string, boolean>()
	private readonly queueSettings = new Map<string, { settings: ProviderSettings; permission: PermissionProfile }>()
	// ponytail: serialize the short queue writes globally; use per-session locks if write contention matters.
	private queueWrite: Promise<unknown> = Promise.resolve()
	readonly onEvent = this.eventEmitter.event

	hasActiveTasks(): boolean {
		return this.runningSessions.size > 0 || this.drainingSessions.size > 0
	}

	async getQueue(sessionId: string): Promise<QueuedMessage[]> {
		return (await this.call<QueuedMessage[] | null>("setting.get", { key: `message-queue:${sessionId}` })) ?? []
	}

	async editQueue(
		sessionId: string,
		change: (queue: QueuedMessage[]) => QueuedMessage[] | Promise<QueuedMessage[]>,
	): Promise<void> {
		const write = this.queueWrite.then(async () => {
			const queue = await change(await this.getQueue(sessionId))
			await this.call("setting.set", { key: `message-queue:${sessionId}`, value: queue })
			this.eventEmitter.fire({
				task_id: this.runningSessions.get(sessionId) ?? "",
				session_id: sessionId,
				kind: "runtime.queue",
				payload: { queue },
			})
		})
		this.queueWrite = write.catch(() => undefined)
		return write
	}

	async enqueue(
		sessionId: string,
		text: string,
		images: string[],
		settings: ProviderSettings,
		permission: PermissionProfile,
	): Promise<void> {
		this.queueSettings.set(sessionId, { settings, permission })
		await this.editQueue(sessionId, (queue) => [
			...queue,
			{ id: randomUUID(), timestamp: Date.now(), text, images },
		])
		await this.drainQueue(sessionId)
	}

	async pushQueuedMessage(
		sessionId: string,
		id: string,
		settings: ProviderSettings,
		permission: PermissionProfile,
	): Promise<void> {
		this.queueSettings.set(sessionId, { settings, permission })
		let deliver = false
		await this.editQueue(sessionId, async (queue) => {
			const entry = queue.find((item) => item.id === id)
			if (!entry) return queue
			if (queue.length > 1 && !(queue[0].id === id && entry.priority)) {
				return [
					{ ...entry, priority: true },
					...queue.filter((item) => item.id !== id).map((item) => ({ ...item, priority: false })),
				]
			}
			deliver = true
			const taskId = this.runningSessions.get(sessionId)
			if (!taskId) return [entry, ...queue.filter((item) => item.id !== id)]
			try {
				await this.steer(taskId, entry)
			} catch (error) {
				this.queueSettings.delete(sessionId)
				throw error
			}
			return queue.filter((item) => item.id !== id)
		})
		if (deliver) await this.drainQueue(sessionId)
	}

	private async steer(taskId: string, entry: QueuedMessage): Promise<void> {
		let subscription: vscode.Disposable | undefined
		let timer: NodeJS.Timeout | undefined
		try {
			await new Promise<void>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("插队确认超时，消息已保留，请检查对话后再重试")), 30_000)
				subscription = this.eventEmitter.event((event) => {
					if (event.task_id !== taskId) return
					if (
						["user.message", "agent.steer_ack"].includes(event.kind) &&
						(event.payload as { id?: string }).id === entry.id
					)
						resolve()
					else if (["agent.finished", "agent.error", "agent.steer_error"].includes(event.kind))
						reject(new Error("执行器未确认插队，消息已保留"))
				})
				void this.call("agent.steer", {
					task_id: taskId,
					id: entry.id,
					text: entry.text,
					images: entry.images ?? [],
					content: promptBlocks(entry.text, entry.images ?? []),
				}).catch(reject)
			})
		} finally {
			clearTimeout(timer)
			subscription?.dispose()
		}
	}

	async resumeQueue(sessionId: string, settings: ProviderSettings, permission: PermissionProfile): Promise<void> {
		this.queueSettings.set(sessionId, { settings, permission })
		await this.drainQueue(sessionId)
	}

	private async drainQueue(sessionId: string): Promise<void> {
		if (this.runningSessions.has(sessionId) || this.drainingSessions.has(sessionId)) return
		this.drainingSessions.set(sessionId, false)
		let launched = false
		let taskId = ""
		try {
			await this.queueWrite
			const config = this.queueSettings.get(sessionId)
			if (!config || this.runningSessions.has(sessionId)) return
			const queued = (await this.getQueue(sessionId))[0]
			if (!queued) return
			const prepared = await this.prepareContinuation(sessionId, queued.text, config.settings, queued.images)
			taskId = prepared.taskId
			this.eventEmitter.fire({
				task_id: prepared.taskId,
				session_id: sessionId,
				kind: "runtime.started",
				payload: { sessionId, taskId: prepared.taskId, prompt: queued.text, images: queued.images ?? [] },
			})
			await this.runPreparedAgentTask(prepared, queued.text, queued.images ?? [], true, config.permission)
			await this.editQueue(sessionId, (queue) => queue.filter((entry) => entry.id !== queued.id))
			launched = true
		} catch (error) {
			const uncertain = isAgentRunTimeout(error)
			if (uncertain) this.queueSettings.delete(sessionId)
			this.eventEmitter.fire({
				task_id: taskId,
				session_id: sessionId,
				kind: uncertain ? "error" : "agent.error",
				payload: {
					message: uncertain
						? "启动响应超时，队列已暂停；请检查该条消息是否已执行，再删除或恢复队列。"
						: `排队消息启动失败，消息已保留：${error instanceof Error ? error.message : String(error)}`,
				},
			})
		} finally {
			const completedSuccessfully = this.drainingSessions.get(sessionId)
			this.drainingSessions.delete(sessionId)
			if (launched && completedSuccessfully) void this.drainQueue(sessionId)
		}
	}

	async speechRequest(method: string, params: unknown, settings: ProviderSettings) {
		return this.modelsApi.speech.request(method, params, settings, {
			environments:
				process.env.OCTOCODE_ENVIRONMENTS ?? path.join(path.dirname(process.execPath), "environments"),
			extension: this.context.extensionUri.fsPath,
		})
	}

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
		private readonly workbenchMcp: WorkbenchMcpServer,
	) {
		this.modelsApi = new ModelsApiManager(output)
		this.workbenchMcp.setRequestApproval((task, title, details) => this.requestApproval(task, title, details))
	}

	private requestApproval(task: ApprovalTask, title: string, details: unknown): Promise<boolean> {
		this.approvals ??= new TaskApprovals(
			async (identity, action, input) => {
				const selected = await vscode.window.showWarningMessage(
					`OctoCode 请求审批：${action}`,
					{
						modal: true,
						detail: `会话：${identity.sessionId}\n任务：${identity.taskId}\n\n${JSON.stringify(input, null, 2)}\n\n仅授权本次调用；关闭、取消或 5 分钟未答复均拒绝。`,
					},
					"仅批准本次",
					"拒绝",
				)
				return selected === "仅批准本次"
			},
			(identity) =>
				!this.disposed &&
				this.runningSessions.get(identity.sessionId) === identity.taskId &&
				!this.cancelledTasks.has(identity.taskId),
		)
		return this.approvals.request(task, title, details)
	}

	async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
		if (this.disposed) throw new Error("OctoCode runtime is disposed")
		await this.start()
		const id = this.nextId++
		const startedAt = Date.now()
		this.output.appendLine(`[OctoCode RPC] #${id} ${method} started`)
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				this.output.appendLine(`[OctoCode RPC] #${id} ${method} timed out after ${Date.now() - startedAt} ms`)
				reject(new Error(`OctoCode host request timed out: ${method}`))
			}, requestTimeout(method))
			this.pending.set(id, { method, startedAt, resolve: resolve as (value: unknown) => void, reject, timer })
			this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
		})
	}

	async health(): Promise<unknown> {
		return this.call("health")
	}

	async resolveProvider(settings: ProviderSettings): Promise<ProviderRoute> {
		return this.call("provider.resolve", settings)
	}

	async modelContext(
		settings: ProviderSettings,
	): Promise<ModelContext & { percent: number; triggerTokens: number; reserveTokens: number }> {
		const route = await this.resolveProvider(settings)
		const id = `context-preview:${randomUUID()}`
		try {
			const model = await this.modelsApi.materialize(route, settings, id)
			const context = model.context!
			return { ...context, ...compressionBudget(context, this.readAutoCompactThreshold(settings)) }
		} finally {
			this.modelsApi.release(id)
		}
	}

	async runTask(
		prompt: string,
		settings: ProviderSettings,
		images: string[] = [],
		requestedSessionId?: string,
		route?: ProviderRoute,
		permissionProfile: PermissionProfile = "full",
	): Promise<RuntimeTask> {
		const prepared = await this.prepareTask(prompt, settings, requestedSessionId, route, images)
		await this.runPreparedAgentTask(prepared, prompt, images, false, permissionProfile)
		return { sessionId: prepared.sessionId, taskId: prepared.taskId }
	}

	async continueTask(
		sessionId: string,
		prompt: string,
		settings: ProviderSettings,
		images: string[] = [],
		permissionProfile: PermissionProfile = "full",
	): Promise<RuntimeTask> {
		const task = await this.prepareContinuation(sessionId, prompt, settings, images)
		await this.runPreparedAgentTask(task, prompt, images, true, permissionProfile)
		return { sessionId: task.sessionId, taskId: task.taskId }
	}

	async prepareContinuation(
		sessionId: string,
		prompt: string,
		settings: ProviderSettings,
		images: string[] = [],
	): Promise<PreparedTask> {
		if (this.runningSessions.has(sessionId)) throw new Error("此对话仍在执行，请将消息加入队列")
		const profileId = this.selectedProfileId()
		const prepared = await this.call<{
			session_id: string
			task_id: string
			route: ProviderRoute
		}>("harness.continue", { session_id: sessionId, prompt, provider: thinkingSettings(settings), images })
		return {
			profileId,
			sessionId: prepared.session_id,
			taskId: prepared.task_id,
			route: prepared.route,
			autoCompactThresholdPercent: this.readAutoCompactThreshold(settings),
			providerSettings: settings,
		}
	}

	async prepareHandoff(sourceSessionId: string, allowCompleted = false): Promise<PreparedHandoff | undefined> {
		const previous = this.sessionSettings.get(sourceSessionId)
		const taskId = this.runningSessions.get(sourceSessionId)
		if (taskId) {
			let subscription: vscode.Disposable | undefined
			let timer: NodeJS.Timeout | undefined
			try {
				const finished = new Promise<void>((resolve, reject) => {
					subscription = this.onEvent((event) => {
						if (event.task_id === taskId && ["agent.finished", "agent.error"].includes(event.kind))
							resolve()
					})
					timer = setTimeout(() => reject(new Error(`Task ${taskId} did not stop for handoff`)), 30_000)
				})
				await this.cancelTask(taskId)
				if (this.runningSessions.get(sourceSessionId) === taskId) await finished
			} finally {
				if (timer) clearTimeout(timer)
				subscription?.dispose()
			}
		}
		const source = await this.call<{ status: string; workspace?: string } | null>("session.get", {
			id: sourceSessionId,
		})
		if (!source || !["cancelled", "interrupted", ...(allowCompleted ? ["completed"] : [])].includes(source.status))
			return undefined
		const saved = previous
			? undefined
			: await this.call<{
					profileId: string
					permission: PermissionProfile
					modelId: string
				} | null>("setting.get", { key: `runtime-session:${sourceSessionId}` })
		if (!previous && (!saved?.profileId || !["review", "directory", "full"].includes(saved.permission))) {
			throw new Error(`Cannot safely recover session ${sourceSessionId}: its model or permission is unavailable`)
		}
		let settings = previous?.settings
		if (!settings && saved) {
			const {
				id: _id,
				name: _name,
				...profile
			} = await new ProviderSettingsManager(this.context).getProfile({ id: saved.profileId })
			if ((await this.resolveProvider(thinkingSettings(profile))).model.model !== saved.modelId) {
				throw new Error(`Cannot safely recover session ${sourceSessionId}: its model profile changed`)
			}
			settings = profile
		}
		if (!settings)
			throw new Error(`Cannot safely recover session ${sourceSessionId}: provider settings unavailable`)
		const handoff = await this.call<{
			session_id: string
			task_id: string
			route: ProviderRoute
			prompt: string
			display_prompt: string
			images: string[]
		}>("harness.handoff", { source_session_id: sourceSessionId, provider: thinkingSettings(settings) })
		return {
			sessionId: handoff.session_id,
			taskId: handoff.task_id,
			route: handoff.route,
			prompt: handoff.prompt,
			displayPrompt: handoff.display_prompt,
			images: handoff.images,
			providerSettings: settings,
			permissionProfile: previous?.permission ?? saved?.permission,
			profileId: previous?.profileId ?? saved?.profileId,
			workingDirectory: source.workspace,
			autoCompactThresholdPercent: this.readAutoCompactThreshold(settings),
		}
	}

	async prepareTask(
		prompt: string,
		settings: ProviderSettings,
		requestedSessionId?: string,
		route?: ProviderRoute,
		images: string[] = [],
	): Promise<PreparedTask> {
		const profileId = this.selectedProfileId()
		const workspace = await this.defaultWorkspace()
		const prepared = await this.call<{
			session_id: string
			task_id: string
			route: ProviderRoute
		}>("harness.prepare", {
			session_id: requestedSessionId,
			title: prompt.slice(0, 120) || "New task",
			workspace,
			prompt,
			provider: thinkingSettings(settings),
			images,
		})
		if (route && JSON.stringify(route.model) !== JSON.stringify(prepared.route.model)) {
			throw new Error("Provider route changed while preparing the task")
		}
		return {
			profileId,
			providerSettings: settings,
			sessionId: prepared.session_id,
			taskId: prepared.task_id,
			route: prepared.route,
			autoCompactThresholdPercent: this.readAutoCompactThreshold(settings),
		}
	}

	/**
	 * Fallback models, stream rules and the reviewer for one task (see the host's
	 * `supervisor` module). A fallback profile that cannot be resolved is skipped
	 * with a log line rather than failing the task it is meant to protect.
	 */
	private async supervision(prepared: PreparedTask, model: { model: string }): Promise<Record<string, unknown>> {
		const config = vscode.workspace.getConfiguration(Package.name)
		const fallbacks: unknown[] = []
		const names = config.get<string[]>("agent.fallbackProfiles") ?? []
		if (names.length) {
			const profiles = new ProviderSettingsManager(this.context)
			for (const [index, name] of names.entries()) {
				try {
					const { id: _id, name: _name, ...settings } = await profiles.getProfile({ name })
					const route = await this.resolveProvider(thinkingSettings(settings))
					fallbacks.push(
						await this.modelsApi.materialize(
							route,
							settings,
							`${prepared.taskId}:fallback:${index}`,
							prepared.sessionId,
						),
					)
				} catch (error) {
					this.output.appendLine(`[OctoCode] fallback profile "${name}" skipped: ${String(error)}`)
				}
			}
		}
		const rules = config.get<unknown[]>("agent.streamRules")
		return {
			fallbacks,
			...(Array.isArray(rules) && rules.length ? { stream_rules: rules } : {}),
			...(config.get<boolean>("agent.review", true) ? { advisor: { model } } : {}),
		}
	}

	private readAutoCompactThreshold(provider: ProviderSettings = {}): number {
		const saved = this.context?.globalState
		const profileId =
			"id" in provider && typeof provider.id === "string"
				? provider.id
				: saved
						?.get<GlobalSettings["listApiConfigMeta"]>("listApiConfigMeta")
						?.find((profile) => profile.name === saved.get<string>("currentApiConfigName"))?.id
		return resolveAutoCompactThreshold(
			{
				autoCondenseContext: saved?.get<boolean>("autoCondenseContext"),
				autoCondenseContextPercent: saved?.get<number>("autoCondenseContextPercent"),
				profileThresholds: saved?.get<Record<string, number>>("profileThresholds"),
			},
			profileId,
		)
	}

	private selectedProfileId(): string | undefined {
		const saved = this.context?.globalState
		return saved
			?.get<GlobalSettings["listApiConfigMeta"]>("listApiConfigMeta")
			?.find((profile) => profile.name === saved.get<string>("currentApiConfigName"))?.id
	}

	async runPreparedAgentTask(
		prepared: PreparedTask,
		prompt: string,
		images: string[] = [],
		resume = false,
		permissionProfile: PermissionProfile = "full",
	): Promise<void> {
		if (this.runningSessions.has(prepared.sessionId)) throw new Error("此对话仍在执行，请将消息加入队列")
		if (prepared.providerSettings) {
			const profileId =
				prepared.profileId ??
				this.sessionSettings.get(prepared.sessionId)?.profileId ??
				this.selectedProfileId() ??
				(
					await new ProviderSettingsManager(this.context).getProfile({
						name: this.context.globalState.get<string>("currentApiConfigName") ?? "default",
					})
				).id
			if (!profileId) {
				throw new Error(`Cannot start session ${prepared.sessionId}: model profile identity unavailable`)
			}
			await this.call("setting.set", {
				key: `runtime-session:${prepared.sessionId}`,
				value: {
					profileId,
					permission: permissionProfile,
					modelId: prepared.route.model.model,
				},
			})
			this.sessionSettings.set(prepared.sessionId, {
				settings: prepared.providerSettings,
				permission: permissionProfile,
				profileId,
			})
		}
		this.runningSessions.set(prepared.sessionId, prepared.taskId)
		try {
			const workspace = prepared.workingDirectory ?? (await this.defaultWorkspace())
			const workingDirectory = workspace
			// Memory lives in the harness (files + index, its own tools and injection).
			// The Host store keeps sessions, tasks and logs; it no longer recalls into the prompt.
			const effectivePrompt = prompt
			const readOnlyTask = isExplicitReadOnlyTask(prompt)
			const workbench = await this.workbenchMcp.startTask({
				taskId: prepared.taskId,
				sessionId: prepared.sessionId,
				workingDirectory,
				workspaceRoot: workspace,
				permissionProfile,
				readOnly: readOnlyTask,
			})
			const model = await this.modelsApi.materialize(
				prepared.route,
				prepared.providerSettings,
				prepared.taskId,
				prepared.sessionId,
			)
			await this.call("log.create", {
				category: "system",
				level: "info",
				subsystem: "model",
				message: "Model route materialized",
				fields: {
					model: model.model,
					base_url: safeLogEndpoint(model.base_url),
					api_backend: model.api_backend,
					context: model.context,
					task_id: prepared.taskId,
				},
				session_id: prepared.sessionId,
			})
			const supervision = await this.supervision(prepared, model)
			if (this.cancelledTasks.has(prepared.taskId)) {
				await this.transitionTask(prepared, "cancelled")
				this.acceptLine(
					JSON.stringify({
						task_id: prepared.taskId,
						session_id: prepared.sessionId,
						kind: "agent.finished",
						payload: { cancelled: true, success: false },
					}),
				)
				return
			}
			const result = await this.call<{ task_id: string }>("agent.run", {
				task_id: prepared.taskId,
				session_id: prepared.sessionId,
				executable: resolveHarnessBinary(this.context.extensionPath),
				harness_home: path.join(
					this.context.globalStorageUri.fsPath,
					"harness-runtime",
					"sessions",
					`s-${Buffer.from(prepared.sessionId, "utf8").toString("base64url")}`,
				),
				cwd: workingDirectory,
				model,
				prompt: effectivePrompt,
				prompt_json: images.length > 0 ? promptBlocks(effectivePrompt, images) : undefined,
				max_turns: MAX_AGENT_TURNS,
				auto_compact_threshold_percent: model.context
					? compressionBudget(
							model.context,
							prepared.autoCompactThresholdPercent ?? this.readAutoCompactThreshold(),
						).percent
					: (prepared.autoCompactThresholdPercent ?? this.readAutoCompactThreshold()),
				workbench_mcp_url: workbench.url,
				workbench_mcp_token: workbench.token,
				resume,
				permission_profile: permissionProfile,
				read_only: readOnlyTask,
				supervision,
			})
			if (result.task_id !== prepared.taskId) throw new Error("Runtime returned a different task identity")
			if (this.cancelledTasks.has(prepared.taskId)) await this.cancelTask(prepared.taskId)
		} catch (error) {
			if (!isAgentRunTimeout(error)) {
				this.runningSessions.delete(prepared.sessionId)
				this.sessionSettings?.delete(prepared.sessionId)
				this.cancelledTasks.delete(prepared.taskId)
				this.workbenchMcp.releaseTask?.(prepared.taskId)
				this.modelsApi.release(prepared.taskId)
				await this.transitionTask(prepared, "failed", {
					message: error instanceof Error ? error.message : String(error),
				}).catch((transitionError) => {
					this.output.appendLine(`Failed to persist task startup failure: ${String(transitionError)}`)
				})
			}
			throw error
		}
	}

	private async defaultWorkspace(): Promise<string> {
		const tasks = configuredWorkspacePath()
		await fs.promises.mkdir(tasks, { recursive: true })
		return tasks
	}

	async transitionTask(
		prepared: PreparedTask,
		state: "running" | "completed" | "cancelled" | "failed",
		detail: unknown = {},
	): Promise<void> {
		await this.call("harness.transition", {
			session_id: prepared.sessionId,
			task_id: prepared.taskId,
			state,
			detail,
		})
	}

	async cancelTask(taskId: string): Promise<boolean> {
		const active = [...this.runningSessions.values()].includes(taskId)
		if (active) this.cancelledTasks.add(taskId)
		this.approvals?.cancel(taskId)
		this.rejectUserInput(taskId, new Error("OctoCode task cancelled"))
		const result = await this.call<{ cancelled: boolean }>("agent.cancel", { task_id: taskId })
		return result.cancelled || active
	}

	async requestUserInput(task: RuntimeTask, question: string, options?: string[]): Promise<UserInputReply> {
		if (this.pendingUserInput.has(task.taskId)) throw new Error("OctoCode task already awaits user input")
		const result = { status: "needs_input" as const, question, ...(options ? { options } : {}) }
		this.eventEmitter.fire({
			task_id: task.taskId,
			session_id: task.sessionId,
			kind: "agent.needs_input",
			payload: result,
		})
		const seconds =
			vscode.workspace.getConfiguration(Package.name).get<number>("agent.askUserTimeoutSeconds") ??
			DEFAULT_ASK_USER_TIMEOUT_SECONDS
		return new Promise<UserInputReply>((resolve, reject) => {
			// An unanswered question must not stall the task: after the timeout the
			// agent is told to decide for itself and say which assumption it made.
			const timer =
				seconds > 0
					? setTimeout(() => {
							if (this.pendingUserInput.get(task.taskId)?.sessionId !== task.sessionId) return
							this.pendingUserInput.delete(task.taskId)
							this.eventEmitter.fire({
								task_id: task.taskId,
								session_id: task.sessionId,
								kind: "agent.needs_input_expired",
								payload: { seconds },
							})
							resolve(unansweredReply(seconds))
						}, seconds * 1000)
					: undefined
			timer?.unref?.()
			this.pendingUserInput.set(task.taskId, {
				sessionId: task.sessionId,
				resolve: (reply) => {
					if (timer) clearTimeout(timer)
					resolve(reply)
				},
				reject: (error) => {
					if (timer) clearTimeout(timer)
					reject(error)
				},
			})
		})
	}

	replyUserInput(sessionId: string, answer: string): boolean {
		for (const [taskId, pending] of this.pendingUserInput) {
			if (pending.sessionId !== sessionId) continue
			this.pendingUserInput.delete(taskId)
			pending.resolve({ answer })
			return true
		}
		return false
	}

	rejectUserInput(taskId: string, error: Error): void {
		const pending = this.pendingUserInput.get(taskId)
		if (!pending) return
		this.pendingUserInput.delete(taskId)
		pending.reject(error)
	}

	dispose(): void {
		this.disposed = true
		this.approvals?.dispose()
		this.modelsApi.dispose()
		const child = this.process
		if (child) {
			// Let the host drop its agent tasks and their child processes before forcing termination.
			child.stdin.end()
			const timer = setTimeout(() => child.kill(), 5000)
			timer.unref()
			child.once("exit", () => clearTimeout(timer))
		}
		this.failPending(new Error("OctoCode host stopped"))
		this.failUserInput(new Error("OctoCode host stopped"))
		this.eventEmitter.dispose()
	}

	private async start(): Promise<void> {
		if (this.process) return
		this.starting ??= (async () => {
			await fs.promises.mkdir(this.context.globalStorageUri.fsPath, { recursive: true })
			const executable = resolveHostBinary(this.context.extensionPath)
			const database = path.join(this.context.globalStorageUri.fsPath, "octocode.db")
			const child = spawn(executable, ["--db", database], {
				cwd: await this.defaultWorkspace(),
				env: await hostEnvironment(vscode.env.appRoot),
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			})
			this.process = child
			this.output.appendLine(`[OctoCode host] started pid=${child.pid ?? "pending"} db=${database}`)
			createInterface({ input: child.stdout }).on("line", (line) => this.acceptLine(line))
			createInterface({ input: child.stderr }).on("line", (line) =>
				this.output.appendLine(`[OctoCode host] ${line}`),
			)
			child.once("error", (error) => {
				if (this.process === child) this.stop(error)
			})
			child.once("exit", (code, signal) => {
				if (this.process === child)
					this.stop(new Error(`OctoCode host exited (${code ?? signal ?? "unknown"})`))
			})
		})()
		try {
			await this.starting
		} finally {
			this.starting = undefined
		}
	}

	private acceptLine(line: string): void {
		try {
			const message = parseHostLine(line)
			if ("kind" in message) {
				if (!["thought", "text", "tool_call_update"].includes(message.kind))
					this.output.appendLine(`[OctoCode event] ${message.kind} task=${message.task_id}`)
				const finishedCurrentTask = this.runningSessions.get(message.session_id) === message.task_id
				if (message.kind === "agent.permission_request" && finishedCurrentTask) {
					const request = message.payload as { id?: unknown; tool_call?: unknown }
					if (typeof request.id === "string") {
						const requestId = request.id
						void this.requestApproval(
							{ taskId: message.task_id, sessionId: message.session_id },
							"工具调用",
							request.tool_call,
						)
							.then((approved) =>
								this.call("agent.permission", {
									task_id: message.task_id,
									session_id: message.session_id,
									id: requestId,
									approved,
								}),
							)
							.catch((error: unknown) => this.output.appendLine(`[OctoCode approval] ${String(error)}`))
					}
				}
				if (message.kind === "agent.finished" || message.kind === "agent.error") {
					this.approvals?.cancel(message.task_id)
					this.cancelledTasks.delete(message.task_id)
					if (this.runningSessions.get(message.session_id) === message.task_id) {
						this.runningSessions.delete(message.session_id)
						this.sessionSettings?.delete(message.session_id)
					}
					this.workbenchMcp.releaseTask(message.task_id)
					this.modelsApi.release(message.task_id)
					this.rejectUserInput(message.task_id, new Error("OctoCode task finished"))
					void this.call<{ indexes: { warnings: unknown[] } }>("project.refresh", {})
						.then((result) => {
							if (result.indexes.warnings.length)
								this.output.appendLine(
									`[OctoCode project index] ${JSON.stringify(result.indexes.warnings)}`,
								)
						})
						.catch((error: unknown) => this.output.appendLine(`[OctoCode project index] ${String(error)}`))
				}
				this.eventEmitter.fire(message)
				if (["user.message", "agent.steer_ack"].includes(message.kind)) {
					const id = (message.payload as { id?: unknown })?.id
					if (typeof id === "string")
						void this.editQueue(message.session_id, (queue) =>
							queue.filter((entry) => entry.id !== id),
						).catch((error: unknown) =>
							this.output.appendLine(`[OctoCode queue acknowledgement] ${String(error)}`),
						)
				}
				if (
					finishedCurrentTask &&
					message.kind === "agent.finished" &&
					(message.payload as { success?: boolean })?.success
				) {
					if (this.drainingSessions.has(message.session_id))
						this.drainingSessions.set(message.session_id, true)
					else void this.drainQueue(message.session_id)
				}
				return
			}
			const pending = this.pending.get(message.id)
			if (!pending) return
			clearTimeout(pending.timer)
			this.pending.delete(message.id)
			const duration = Date.now() - pending.startedAt
			if (message.error) {
				this.output.appendLine(
					`[OctoCode RPC] #${message.id} ${pending.method} failed after ${duration} ms: ${message.error.code} ${message.error.message}`,
				)
				pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
			} else {
				this.output.appendLine(`[OctoCode RPC] #${message.id} ${pending.method} completed in ${duration} ms`)
				pending.resolve(message.result)
			}
		} catch (error) {
			this.output.appendLine(
				`[OctoCode host] Invalid output: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private stop(error: Error): void {
		for (const taskId of this.runningSessions.values()) this.approvals?.cancel(taskId)
		if (!this.disposed) this.output.appendLine(`[OctoCode host] stopped: ${error.message}`)
		for (const [sessionId, taskId] of this.runningSessions) {
			if (!this.disposed)
				this.eventEmitter.fire({
					session_id: sessionId,
					task_id: taskId,
					kind: "agent.error",
					payload: { message: error.message },
				})
		}
		this.runningSessions.clear()
		this.cancelledTasks.clear()
		this.modelsApi.dispose()
		this.process = undefined
		this.failPending(error)
		this.failUserInput(error)
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer)
			pending.reject(error)
		}
		this.pending.clear()
	}

	private failUserInput(error: Error): void {
		for (const taskId of this.pendingUserInput.keys()) this.rejectUserInput(taskId, error)
	}
}

/** Explicit read-only instructions limit one turn's tools without changing its permission profile. */
export function isExplicitReadOnlyTask(prompt: string): boolean {
	// ponytail: lexical guard covers direct instructions; add a per-turn UI switch if indirect phrasing must be enforced.
	const opening = prompt.trim().slice(0, 240)
	// A read-only first phase must not remove write access requested later in the same turn.
	if (
		/(?:然后|随后|之后|再|接着|(?:检查|分析|查看|审查)后|发现问题(?:就|后)?|如有问题(?:就|后)?|并)\s*(?:请|直接|立即)?\s*(?:修复|修改|实现|更新|提交|写入|删除|清理|安装|部署|编辑)|\b(?:then|and then)\s+(?:fix|edit|modify|implement|update|commit|write|delete|install|deploy)\b/i.test(
			prompt,
		)
	)
		return false
	return (
		/^(?:(?:请|先|帮我|本次|这次|在全权限(?:模式)?下|全权限(?:模式)?|\s|[，,：:])*)(?:只读|仅(?:检查|分析|查看|审查|查询)|不要修改|不做修改|禁止修改)/.test(
			opening,
		) ||
		/(?:^|[，,。.;；\n])\s*(?:请|先|务必)?\s*(?:不要|不得|禁止|切勿)\s*(?:修改|更改|改动|编辑|写入)/.test(
			opening,
		) ||
		/^(?:(?:please|first|with full access|\s|[,])*)(?:read[- ]only|review only|do not (?:edit|modify|write|change)|without (?:edits|modifications|changes))/i.test(
			opening,
		)
	)
}

export function thinkingSettings(settings: ProviderSettings): ProviderSettings {
	return withResolvedThinking(settings, getModelId(settings))
}

export function safeLogEndpoint(value: string): string {
	try {
		const url = new URL(value)
		url.username = ""
		url.password = ""
		url.search = ""
		url.hash = ""
		return url.toString()
	} catch {
		return "<configured>"
	}
}

export function requestTimeout(method: string): number {
	return method === "audio.preview" || method === "audio.finish" ? 300_000 : 30_000
}

function isAgentRunTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === "OctoCode host request timed out: agent.run"
}

export function promptBlocks(prompt: string, images: string[]): unknown[] {
	return [
		{ type: "text", text: prompt },
		...images.map((image) => {
			const match = /^data:(image\/[^;]+);base64,(.+)$/s.exec(image)
			if (!match) throw new Error("Image must be a base64 data URL")
			return { type: "image", mimeType: match[1], data: match[2] }
		}),
	]
}

export function parseHostLine(line: string): RuntimeResponse | RuntimeEvent {
	const value: unknown = JSON.parse(line)
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object")
	const record = value as Record<string, unknown>
	if (typeof record.id === "number") return value as RuntimeResponse
	if (
		typeof record.task_id === "string" &&
		typeof record.session_id === "string" &&
		typeof record.kind === "string" &&
		"payload" in record
	)
		return value as RuntimeEvent
	throw new Error("unknown host message")
}

let runtime: OctoCodeRuntime | undefined

export function initializeOctoCodeRuntime(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	workbenchMcp: WorkbenchMcpServer,
): OctoCodeRuntime {
	runtime ??= new OctoCodeRuntime(context, output, workbenchMcp)
	return runtime
}

export function getOctoCodeRuntime(): OctoCodeRuntime {
	if (!runtime) throw new Error("OctoCode runtime is not initialized")
	return runtime
}

export function resolveHostBinary(extensionPath: string): string {
	const name = process.platform === "win32" ? "octocode-host.exe" : "octocode-host"
	const platform = `${process.platform}-${process.arch}`
	const candidates = [
		process.env.OCTOCODE_HOST_PATH,
		path.join(extensionPath, "bin", platform, name),
		path.resolve(extensionPath, "..", "target", "debug", name),
	].filter((candidate): candidate is string => Boolean(candidate))
	const executable = candidates.find(fs.existsSync)
	if (!executable) throw new Error(`OctoCode host binary not found (${candidates.join(", ")})`)
	return executable
}

/**
 * Environment for the host, inherited by the agent harness it launches. The
 * harness's grep tools spawn `rg`, which is bundled only into non-Windows
 * harness builds and is not on a Windows PATH, so every grep call failed with
 * "program not found". Point them at the ripgrep VS Code ships instead.
 */
export async function hostEnvironment(
	appRoot: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
	if (env.RG_BIN_PATH || !appRoot) return env
	const rg = await getRipgrepPath(appRoot)
	return rg ? { ...env, RG_BIN_PATH: rg } : env
}

export function resolveHarnessBinary(extensionPath: string): string {
	const name = process.platform === "win32" ? "octocode-harness.exe" : "octocode-harness"
	const platform = `${process.platform}-${process.arch}`
	const candidates = [process.env.OCTOCODE_HARNESS_PATH, path.join(extensionPath, "bin", platform, name)].filter(
		(candidate): candidate is string => Boolean(candidate),
	)
	const executable = candidates.find(fs.existsSync)
	if (!executable) throw new Error(`OctoCode harness binary not found (${candidates.join(", ")})`)
	return executable
}
