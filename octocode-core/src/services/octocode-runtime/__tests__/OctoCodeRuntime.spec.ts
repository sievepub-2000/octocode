import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import * as vscode from "vscode"

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

vi.mock("../RuntimeBrokerClient", () => ({ connectSharedHost: connectMock }))
vi.mock("../../code-index/state-manager", () => ({
	CodeIndexStateManager: class {
		dispose = vi.fn()
	},
}))

import {
	hostEnvironment,
	isExplicitReadOnlyTask,
	MAX_AGENT_TURNS,
	OctoCodeRuntime,
	parseHostLine,
	promptBlocks,
	requestTimeout,
	safeLogEndpoint,
	resolveAutoCompactThreshold,
} from "../OctoCodeRuntime"
import { normalizeAudioParams } from "../../models-api/SpeechProvider"
import { ripgrepCandidatePaths } from "../../ripgrep"
import { ProviderSettingsManager } from "../../../core/config/ProviderSettingsManager"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"

it("resolves saved compression settings with profile inheritance and safe defaults", () => {
	expect(resolveAutoCompactThreshold({})).toBe(90)
	expect(resolveAutoCompactThreshold({ autoCondenseContext: false, profileThresholds: { local: 60 } }, "local")).toBe(
		0,
	)
	expect(
		resolveAutoCompactThreshold({ autoCondenseContextPercent: 80, profileThresholds: { local: 60 } }, "local"),
	).toBe(60)
	expect(
		resolveAutoCompactThreshold({ autoCondenseContextPercent: 80, profileThresholds: { local: -1 } }, "local"),
	).toBe(80)
	expect(
		resolveAutoCompactThreshold({ autoCondenseContextPercent: 80, profileThresholds: { local: 101 } }, "local"),
	).toBe(80)
	for (const value of [0, 9, 101, 70.5, NaN])
		expect(resolveAutoCompactThreshold({ autoCondenseContextPercent: value })).toBe(90)
})

it("keeps autonomous tasks alive beyond the old 100-turn cutoff", () => {
	expect(MAX_AGENT_TURNS).toBe(1_000)
})

describe("parseHostLine", () => {
	it("separates RPC responses from live agent events", () => {
		expect(parseHostLine('{"id":1,"result":{"ok":true}}')).toMatchObject({ id: 1 })
		expect(parseHostLine('{"task_id":"t","session_id":"s","kind":"tool_call","payload":{}}')).toMatchObject({
			kind: "tool_call",
		})
		expect(() => parseHostLine("[]")).toThrow("expected an object")
	})
})

describe("requestTimeout", () => {
	it("keeps cancellation during model preparation and never starts the harness", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		const call = vi.fn().mockResolvedValue({ cancelled: false })
		const acceptLine = vi.fn()
		Object.assign(runtime, {
			runningSessions: new Map(),
			pendingUserInput: new Map(),
			defaultWorkspace: vi.fn().mockResolvedValue(process.cwd()),
			workbenchMcp: { startTask: vi.fn().mockResolvedValue({ url: "http://mcp", token: "test" }) },
			modelsApi: {
				materialize: async () => {
					await runtime.cancelTask("task")
					return { model: "test" }
				},
			},
			supervision: vi.fn().mockResolvedValue({}),
			call,
			acceptLine,
		})
		await runtime.runPreparedAgentTask(
			{ sessionId: "session", taskId: "task", route: {} } as Parameters<
				OctoCodeRuntime["runPreparedAgentTask"]
			>[0],
			"test",
		)
		expect(call.mock.calls.some(([method]) => method === "agent.run")).toBe(false)
		expect(call).toHaveBeenCalledWith("harness.transition", expect.objectContaining({ state: "cancelled" }))
		expect(JSON.parse(acceptLine.mock.calls[0][0])).toMatchObject({
			kind: "agent.finished",
			payload: { cancelled: true },
		})
	})
	it("allows local speech inference without weakening ordinary RPC timeouts", () => {
		expect(requestTimeout("health")).toBe(30_000)
		expect(requestTimeout("audio.finish")).toBe(300_000)
	})
})

describe("normalizeAudioParams", () => {
	it("bounds PCM and rejects caller-owned model paths", () => {
		expect(normalizeAudioParams("audio.chunk", { id: "voice", sample_rate: 16_000, samples: [0, 1] })).toEqual({
			id: "voice",
			sample_rate: 16_000,
			samples: [0, 1],
		})
		expect(normalizeAudioParams("audio.finish", { id: "voice", model_path: "C:/evil" })).toEqual({
			id: "voice",
		})
		expect(() => normalizeAudioParams("audio.chunk", { id: "voice", sample_rate: 48_000, samples: [0] })).toThrow(
			"16 kHz",
		)
		expect(() =>
			normalizeAudioParams("audio.chunk", {
				id: "voice",
				sample_rate: 16_000,
				samples: new Array(16_001).fill(0),
			}),
		).toThrow("1 to 16000")
	})
})

describe("promptBlocks", () => {
	it("maps attached images to ACP image blocks", () => {
		expect(promptBlocks("inspect", ["data:image/png;base64,AAAA"])).toEqual([
			{ type: "text", text: "inspect" },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
		])
	})
})

describe("memory ownership", () => {
	it("does not compose host recall into the prompt any more", () => {
		// Memory is the harness's: files, its own tools, its own injection.
		// The Host store keeps sessions, tasks and logs.
		const source = readFileSync(join(__dirname, "..", "OctoCodeRuntime.ts"), "utf8")
		expect(source).not.toContain("octocode_memory_context")
		expect(source).not.toContain("memory.recall")
		expect(source).not.toContain("memory.authorize_retain")
		expect(source).not.toContain("world_model.query")
	})
})

describe("continuation lifecycle", () => {
	it("does not replace an unconfigured session profile with another conversation's model", async () => {
		const lookup = vi.spyOn(ProviderSettingsManager.prototype, "getProfile").mockResolvedValue({
			id: "unfinished",
			name: "muse-spark-1.3-con",
		})
		try {
			const call = vi.fn().mockResolvedValue("unfinished")
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				context: {},
				runningSessions: new Map(),
				call,
			}) as OctoCodeRuntime
			await expect(
				runtime.prepareContinuation("session", "continue", {
					apiProvider: "openrouter",
					openRouterModelId: "nvidia/test:free",
				}),
			).rejects.toThrow("请先在模型设置中选择 API 提供商并保存配置")
			expect(call).toHaveBeenCalledTimes(1)
		} finally {
			lookup.mockRestore()
		}
	})
	it("falls back to the selected profile identity after a session profile is deleted", async () => {
		const lookup = vi.spyOn(ProviderSettingsManager.prototype, "getProfile").mockRejectedValue(new Error("deleted"))
		try {
			const call = vi.fn(async (method: string) =>
				method === "setting.get" ? "deleted-profile" : { session_id: "session", task_id: "task", route: {} },
			)
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				context: {
					globalState: {
						get: (key: string) =>
							key === "listApiConfigMeta" ? [{ id: "global-id", name: "global" }] : "global",
					},
				},
				runningSessions: new Map(),
				call,
			}) as OctoCodeRuntime
			await expect(
				runtime.prepareContinuation("session", "continue", { apiProvider: "openai" }),
			).resolves.toMatchObject({
				profileId: "global-id",
				providerSettings: { apiProvider: "openai" },
			})
		} finally {
			lookup.mockRestore()
		}
	})
	it("refuses crash recovery when session permissions were not persisted", async () => {
		const call = vi.fn(async (method: string) => {
			if (method === "session.get") return { status: "interrupted", workspace: "D:/project" }
			if (method === "setting.get") return null
			throw new Error(`Unexpected call: ${method}`)
		})
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			runningSessions: new Map(),
			sessionSettings: new Map(),
			call,
		}) as OctoCodeRuntime
		await expect(runtime.prepareHandoff("lost")).rejects.toThrow("Cannot safely recover")
		expect(call.mock.calls.some(([method]) => method === "harness.handoff")).toBe(false)
	})
	it("hands off one running session without touching another or completed history", async () => {
		const listeners: Array<
			(event: { task_id: string; session_id: string; kind: string; payload: object }) => void
		> = []
		const runningSessions = new Map([
			["a", "task-a"],
			["b", "task-b"],
		])
		const call = vi.fn(async (method: string, params: { id?: string }) => {
			if (method === "session.get")
				return { status: params.id === "old" ? "completed" : "cancelled", workspace: "D:/project" }
			if (method === "harness.handoff")
				return {
					session_id: "a2",
					task_id: "task-a2",
					working_directory: "D:/project/.octocode/sessions/a2",
					route: { model: { model: "qwen" } },
					prompt: "continue",
					display_prompt: "continue A",
					images: [],
				}
			throw new Error(method)
		})
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			runningSessions,
			sessionSettings: new Map([["a", { settings: { apiProvider: "openai" }, permission: "directory" }]]),
			onEvent: (
				listener: (event: { task_id: string; session_id: string; kind: string; payload: object }) => void,
			) => {
				listeners.push(listener)
				return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }
			},
			cancelTask: vi.fn(async () => {
				runningSessions.delete("a")
				for (const listener of listeners)
					listener({ task_id: "task-a", session_id: "a", kind: "agent.finished", payload: {} })
				return true
			}),
			readAutoCompactThreshold: () => 90,
			call,
		}) as OctoCodeRuntime
		await expect(runtime.prepareHandoff("a")).resolves.toMatchObject({
			sessionId: "a2",
			taskId: "task-a2",
			workingDirectory: "D:/project/.octocode/sessions/a2",
			permissionProfile: "directory",
		})
		expect(runningSessions.get("b")).toBe("task-b")
		expect(call).toHaveBeenCalledWith("harness.handoff", {
			source_session_id: "a",
			provider: { apiProvider: "openai" },
		})
		await expect(runtime.prepareHandoff("old")).resolves.toBeUndefined()
		expect(call.mock.calls.filter(([method]) => method === "harness.handoff")).toHaveLength(1)
	})
	it("prepares task identity before starting the agent process", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		Object.assign(runtime, { runningSessions: new Map() })
		const call = vi.spyOn(runtime, "call").mockResolvedValue({
			route: { model: { model: "qwen" } },
			session_id: "session",
			task_id: "task",
		})

		await expect(
			runtime.prepareContinuation("session", "continue", { apiProvider: "openrouter" }),
		).resolves.toMatchObject({
			sessionId: "session",
			taskId: "task",
		})
		// The session-model override lookup runs before the continue call
		// (setting.get for session-profile:<id>), then harness.continue itself.
		expect(call).toHaveBeenCalledTimes(2)
		expect(call).toHaveBeenCalledWith("setting.get", { key: "session-profile:session" })
		expect(call).toHaveBeenCalledWith("harness.continue", {
			prompt: "continue",
			images: [],
			provider: { apiProvider: "openrouter" },
			session_id: "session",
		})
	})
	it("rejects an unconfigured continuation before sending it to the host", async () => {
		const call = vi.fn().mockResolvedValue(null)
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			runningSessions: new Map(),
			call,
		}) as OctoCodeRuntime
		await expect(runtime.prepareContinuation("session", "continue", {})).rejects.toThrow(
			"请先在模型设置中选择 API 提供商并保存配置",
		)
		expect(call).not.toHaveBeenCalledWith("harness.continue", expect.anything())
	})
})

describe("Models API routing", () => {
	it.each([
		{ global: false, workspace: true, expected: false },
		{ global: true, workspace: false, expected: false },
		{ global: true, workspace: true, expected: true },
	])(
		"passes workspace indexing opt-in to the actual agent.run payload: $global/$workspace",
		async ({ global, workspace, expected }) => {
			const { CodeIndexManager } = await import("../../code-index/manager")
			const previous = process.env.OCTOCODE_HARNESS_PATH
			process.env.OCTOCODE_HARNESS_PATH = process.execPath
			const context = makeExtensionContext({
				extensionPath: process.cwd(),
				globalStorageUri: makeUri(process.cwd()),
			})
			vi.mocked(context.globalState.get).mockReturnValue({ codebaseIndexEnabled: global })
			vi.mocked(context.workspaceState.get).mockReturnValue(workspace)
			const call = vi.fn(async (method: string, params?: { task_id?: string }) =>
				method === "agent.run" ? { task_id: params?.task_id } : {},
			)
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				context,
				call,
				runningSessions: new Map(),
				cancelledTasks: new Set(),
				workbenchMcp: { startTask: vi.fn().mockResolvedValue({ url: "http://mcp", token: "fixture" }) },
				modelsApi: { materialize: vi.fn().mockResolvedValue({ model: "fixture" }), release: vi.fn() },
				supervision: vi.fn().mockResolvedValue({ fallbacks: [] }),
			}) as OctoCodeRuntime
			try {
				await runtime.runPreparedAgentTask(
					{
						sessionId: "index-session",
						taskId: "index-task",
						workingDirectory: process.cwd(),
						autoCompactThresholdPercent: 90,
						route: {
							model: {
								model: "fixture",
								base_url: "http://fixture",
								api_backend: "chat_completions",
								context_window: 1000,
								max_completion_tokens: 100,
							},
						},
					},
					"fixture",
				)
				expect(call).toHaveBeenCalledWith("agent.run", expect.objectContaining({ codebase_indexing: expected }))
			} finally {
				CodeIndexManager.disposeAll()
				if (previous === undefined) delete process.env.OCTOCODE_HARNESS_PATH
				else process.env.OCTOCODE_HARNESS_PATH = previous
			}
		},
	)

	it("removes credentials and query secrets from logged endpoints", () => {
		expect(safeLogEndpoint("https://user:pass@example.com/v1?api_key=secret#token")).toBe("https://example.com/v1")
	})

	it("materializes provider adapters before the unified harness starts", async () => {
		const previousHarnessPath = process.env.OCTOCODE_HARNESS_PATH
		process.env.OCTOCODE_HARNESS_PATH = process.execPath
		try {
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				cancelledTasks: new Set(),
			}) as unknown as {
				runPreparedAgentTask: OctoCodeRuntime["runPreparedAgentTask"]
			}
			const call = vi.fn(async (_method: string, params?: { task_id?: string }) => {
				return { task_id: params?.task_id ?? "task" }
			})
			const materialize = vi.fn().mockResolvedValue({
				model: "local-qwen",
				base_url: "http://127.0.0.1:4567/v1",
				api_key: "bridge-token",
				api_backend: "chat_completions",
				context_window: 200_000,
				max_completion_tokens: 32_768,
			})
			const startTask = vi.fn(async ({ taskId }: { taskId: string }) => ({
				url: "http://mcp",
				token: `mcp-${taskId}`,
			}))
			Object.assign(runtime, {
				runningSessions: new Map(),
				drainingSessions: new Map(),
				queueSettings: new Map(),
				queueWrite: Promise.resolve(),
				defaultWorkspace: vi.fn().mockResolvedValue(join(process.cwd(), "tasks")),
				context: { extensionPath: process.cwd(), globalStorageUri: { fsPath: process.cwd() } },
				workbenchMcp: {
					startTask,
				},
				modelsApi: { release: vi.fn(), dispose: vi.fn(), materialize },
				call,
			})
			const route = {
				model: {
					model: "local-qwen",
					base_url: "vscode-lm://provider",
					api_backend: "chat_completions" as const,
					context_window: 200_000,
					max_completion_tokens: 32_768,
				},
				vs_code_lm_model_selector: { id: "local-qwen" },
			}

			await runtime.runPreparedAgentTask(
				{ sessionId: "session", taskId: "task", route, autoCompactThresholdPercent: 70 },
				"hello",
			)

			expect(materialize).toHaveBeenCalledWith(route, undefined, "task", "session")
			expect(call).toHaveBeenCalledWith("log.create", {
				category: "system",
				fields: {
					api_backend: "chat_completions",
					base_url: "http://127.0.0.1:4567/v1",
					model: "local-qwen",
					task_id: "task",
					context: undefined,
				},
				level: "info",
				message: "Model route materialized",
				session_id: "session",
				subsystem: "model",
			})
			expect(startTask).toHaveBeenCalledWith({
				permissionProfile: "full",
				readOnly: false,
				taskId: "task",
				sessionId: "session",
				workingDirectory: join(process.cwd(), "tasks"),
				workspaceRoot: join(process.cwd(), "tasks"),
			})
			expect(call).not.toHaveBeenCalledWith("world_model.query", expect.anything())
			expect(call).toHaveBeenCalledWith(
				"agent.run",
				expect.objectContaining({
					model: expect.objectContaining({ base_url: "http://127.0.0.1:4567/v1" }),
					prompt: "hello",
					cwd: join(process.cwd(), "tasks"),
					auto_compact_threshold_percent: 70,
					supervision: expect.objectContaining({ fallbacks: [] }),
				}),
			)

			await runtime.runPreparedAgentTask(
				{ sessionId: "read-session", taskId: "read-task", route },
				"请只读检查代码，不要修改文件",
				[],
				false,
				"full",
			)
			expect(startTask).toHaveBeenLastCalledWith(
				expect.objectContaining({ permissionProfile: "full", readOnly: true }),
			)
			expect(call).toHaveBeenCalledWith(
				"agent.run",
				expect.objectContaining({ task_id: "read-task", permission_profile: "full", read_only: true }),
			)
		} finally {
			if (previousHarnessPath === undefined) delete process.env.OCTOCODE_HARNESS_PATH
			else process.env.OCTOCODE_HARNESS_PATH = previousHarnessPath
		}
	})

	it("gives concurrent sessions safe separate harness homes and task-scoped MCP tokens", async () => {
		const previousHarnessPath = process.env.OCTOCODE_HARNESS_PATH
		process.env.OCTOCODE_HARNESS_PATH = process.execPath
		try {
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				cancelledTasks: new Set(),
			}) as unknown as {
				runPreparedAgentTask: OctoCodeRuntime["runPreparedAgentTask"]
			}
			const call = vi.fn(async (method: string, params?: { task_id?: string }) => {
				if (method === "agent.run") return { task_id: params?.task_id }
				return {}
			})
			const startTask = vi.fn(async ({ taskId }: { taskId: string }) => ({
				url: "http://mcp",
				token: `token-${taskId}`,
			}))
			const releaseTask = vi.fn()
			Object.assign(runtime, {
				runningSessions: new Map(),
				sessionSettings: new Map(),
				drainingSessions: new Map(),
				queueSettings: new Map(),
				queueWrite: Promise.resolve(),
				defaultWorkspace: vi.fn().mockResolvedValue(join(process.cwd(), "tasks")),
				context: { extensionPath: process.cwd(), globalStorageUri: { fsPath: process.cwd() } },
				workbenchMcp: { startTask, releaseTask },
				modelsApi: {
					release: vi.fn(),
					dispose: vi.fn(),
					materialize: vi.fn().mockResolvedValue({ model: "qwen" }),
				},
				call,
			})
			const route = {
				model: {
					model: "qwen",
					base_url: "http://model",
					api_backend: "chat_completions" as const,
					context_window: 1,
					max_completion_tokens: 1,
				},
			}

			await Promise.all([
				runtime.runPreparedAgentTask({ sessionId: "", taskId: "task-empty", route }, "empty"),
				runtime.runPreparedAgentTask({ sessionId: ".", taskId: "task-dot", route }, "dot"),
				runtime.runPreparedAgentTask({ sessionId: "..", taskId: "task-dot-dot", route }, "dot dot"),
				runtime.runPreparedAgentTask({ sessionId: "session/a", taskId: "task-slash", route }, "slash"),
				runtime.runPreparedAgentTask({ sessionId: "session:a", taskId: "task-colon", route }, "colon"),
			])

			type AgentRun = { task_id: string; harness_home: string; workbench_mcp_token: string }
			const runs = new Map<string, AgentRun>(
				call.mock.calls
					.filter(([method]) => method === "agent.run")
					.map(([, params]) => {
						const run = params as AgentRun
						return [run.task_id, run]
					}),
			)
			expect(runs.get("task-empty")).toMatchObject({
				harness_home: expect.stringMatching(/harness-runtime[\\/]sessions[\\/]s-$/),
				workbench_mcp_token: "token-task-empty",
			})
			expect(runs.get("task-dot")).toMatchObject({
				harness_home: expect.stringMatching(/harness-runtime[\\/]sessions[\\/]s-Lg$/),
				workbench_mcp_token: "token-task-dot",
			})
			expect(runs.get("task-dot-dot")).toMatchObject({
				harness_home: expect.stringMatching(/harness-runtime[\\/]sessions[\\/]s-Li4$/),
				workbench_mcp_token: "token-task-dot-dot",
			})
			expect(runs.get("task-slash")).toMatchObject({
				harness_home: expect.stringMatching(/harness-runtime[\\/]sessions[\\/]s-c2Vzc2lvbi9h$/),
				workbench_mcp_token: "token-task-slash",
			})
			expect(runs.get("task-colon")).toMatchObject({
				harness_home: expect.stringMatching(/harness-runtime[\\/]sessions[\\/]s-c2Vzc2lvbjph$/),
				workbench_mcp_token: "token-task-colon",
			})
			expect(new Set([...runs.values()].map((run) => run.harness_home)).size).toBe(5)
			expect(releaseTask).not.toHaveBeenCalled()
		} finally {
			if (previousHarnessPath === undefined) delete process.env.OCTOCODE_HARNESS_PATH
			else process.env.OCTOCODE_HARNESS_PATH = previousHarnessPath
		}
	})

	it("releases a task token when startup fails after the endpoint is issued", async () => {
		const previousHarnessPath = process.env.OCTOCODE_HARNESS_PATH
		process.env.OCTOCODE_HARNESS_PATH = process.execPath
		try {
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				cancelledTasks: new Set(),
			}) as unknown as {
				runPreparedAgentTask: OctoCodeRuntime["runPreparedAgentTask"]
			}
			const releaseTask = vi.fn()
			Object.assign(runtime, {
				runningSessions: new Map(),
				sessionSettings: new Map(),
				drainingSessions: new Map(),
				queueSettings: new Map(),
				queueWrite: Promise.resolve(),
				defaultWorkspace: vi.fn().mockResolvedValue(join(process.cwd(), "tasks")),
				context: { extensionPath: process.cwd(), globalStorageUri: { fsPath: process.cwd() } },
				workbenchMcp: {
					startTask: vi.fn().mockResolvedValue({ url: "http://mcp", token: "token-task-a" }),
					releaseTask,
				},
				modelsApi: {
					release: vi.fn(),
					dispose: vi.fn(),
					materialize: vi.fn().mockRejectedValue(new Error("materialize failed")),
				},
				call: vi.fn(async () => ({})),
			})
			const route = {
				model: {
					model: "qwen",
					base_url: "http://model",
					api_backend: "chat_completions" as const,
					context_window: 1,
					max_completion_tokens: 1,
				},
			}

			await expect(
				runtime.runPreparedAgentTask(
					{
						sessionId: "session-a",
						taskId: "task-a",
						route,
						profileId: "profile-a",
						providerSettings: { apiProvider: "openai", openAiApiKey: "secret" },
					},
					"start",
					[],
					false,
					"directory",
				),
			).rejects.toThrow("materialize failed")
			expect(releaseTask).toHaveBeenCalledExactlyOnceWith("task-a")
			expect((runtime as unknown as { call: ReturnType<typeof vi.fn> }).call).toHaveBeenCalledWith(
				"setting.set",
				{
					key: "runtime-session:session-a",
					value: { profileId: "profile-a", permission: "directory", modelId: "qwen" },
				},
			)
			expect((runtime as unknown as { call: ReturnType<typeof vi.fn> }).call).toHaveBeenCalledWith(
				"harness.transition",
				{
					session_id: "session-a",
					task_id: "task-a",
					state: "failed",
					detail: { message: "materialize failed" },
				},
			)
		} finally {
			if (previousHarnessPath === undefined) delete process.env.OCTOCODE_HARNESS_PATH
			else process.env.OCTOCODE_HARNESS_PATH = previousHarnessPath
		}
	})

	it("keeps a task token when agent.run times out after the Host may have started it", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as unknown as {
			runPreparedAgentTask: OctoCodeRuntime["runPreparedAgentTask"]
		}
		const releaseTask = vi.fn()
		Object.assign(runtime, {
			runningSessions: new Map(),
			sessionSettings: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			defaultWorkspace: vi.fn().mockResolvedValue(join(process.cwd(), "tasks")),
			context: { extensionPath: process.cwd(), globalStorageUri: { fsPath: process.cwd() } },
			workbenchMcp: {
				startTask: vi.fn().mockResolvedValue({ url: "http://mcp", token: "token-task-a" }),
				releaseTask,
			},
			modelsApi: {
				release: vi.fn(),
				dispose: vi.fn(),
				materialize: vi.fn().mockResolvedValue({ model: "qwen" }),
			},
			call: vi.fn(async (method: string) => {
				if (method === "agent.run") throw new Error("OctoCode host request timed out: agent.run")
				return {}
			}),
		})
		const route = {
			model: {
				model: "qwen",
				base_url: "http://model",
				api_backend: "chat_completions" as const,
				context_window: 1,
				max_completion_tokens: 1,
			},
		}

		await expect(
			runtime.runPreparedAgentTask({ sessionId: "session-a", taskId: "task-a", route }, "start"),
		).rejects.toThrow("timed out")
		expect(releaseTask).not.toHaveBeenCalled()
	})

	it("releases a task token when the Host explicitly rejects agent.run", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as unknown as {
			runPreparedAgentTask: OctoCodeRuntime["runPreparedAgentTask"]
		}
		const releaseTask = vi.fn()
		Object.assign(runtime, {
			runningSessions: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			defaultWorkspace: vi.fn().mockResolvedValue(join(process.cwd(), "tasks")),
			context: { extensionPath: process.cwd(), globalStorageUri: { fsPath: process.cwd() } },
			workbenchMcp: {
				startTask: vi.fn().mockResolvedValue({ url: "http://mcp", token: "token-task-a" }),
				releaseTask,
			},
			modelsApi: {
				release: vi.fn(),
				dispose: vi.fn(),
				materialize: vi.fn().mockResolvedValue({ model: "qwen" }),
			},
			call: vi.fn(async (method: string) => {
				if (method === "agent.run") throw new Error("rejected: invalid executable")
				return {}
			}),
		})
		const route = {
			model: {
				model: "qwen",
				base_url: "http://model",
				api_backend: "chat_completions" as const,
				context_window: 1,
				max_completion_tokens: 1,
			},
		}

		await expect(
			runtime.runPreparedAgentTask({ sessionId: "session-a", taskId: "task-a", route }, "start"),
		).rejects.toThrow("invalid executable")
		expect(releaseTask).toHaveBeenCalledExactlyOnceWith("task-a")
	})
})

describe("agent lifecycle ownership", () => {
	it("releases only the task whose agent finished or failed", () => {
		const releaseTask = vi.fn()
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as unknown as {
			acceptLine(line: string): void
		}
		Object.assign(runtime, {
			runningSessions: new Map(),
			sessionSettings: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			output: { appendLine: vi.fn() },
			eventEmitter: { fire: vi.fn() },
			workbenchMcp: { releaseTask },
			pendingUserInput: new Map(),
		})

		runtime.acceptLine(
			'{"task_id":"task-a","session_id":"session-a","kind":"agent.finished","payload":{"success":true}}',
		)
		runtime.acceptLine('{"task_id":"task-b","session_id":"session-b","kind":"agent.error","payload":{}}')
		runtime.acceptLine('{"task_id":"task-c","session_id":"session-c","kind":"tool_call","payload":{}}')

		expect(releaseTask).toHaveBeenNthCalledWith(1, "task-a")
		expect(releaseTask).toHaveBeenNthCalledWith(2, "task-b")
		expect(releaseTask).toHaveBeenCalledTimes(2)
	})
})

describe("hostEnvironment", () => {
	it("pins the Windows agent to bundled PowerShell 7 even with an inherited legacy override", async () => {
		if (process.platform !== "win32") return
		const result = await hostEnvironment(undefined, {
			OCTOCODE_ENVIRONMENTS: "E:\\Program Files\\octocode\\environments",
			Path: "C:\\Windows\\System32",
			GROK_SHELL: "powershell",
		})
		expect(result.GROK_SHELL).toBe("pwsh")
		expect(result.Path?.split(";")[0]).toBe("E:\\Program Files\\octocode\\environments\\powershell")
	})
	it("points the harness grep tools at VS Code's bundled ripgrep", async () => {
		const appRoot = mkdtempSync(join(tmpdir(), "octocode-approot-"))
		try {
			const rg = ripgrepCandidatePaths(appRoot)[0]
			mkdirSync(dirname(rg), { recursive: true })
			writeFileSync(rg, "")

			expect(await hostEnvironment(appRoot, { PATH: "p" })).toEqual({ PATH: "p", RG_BIN_PATH: rg })
			// An explicit override and an unknown app root leave the environment alone.
			expect(await hostEnvironment(appRoot, { RG_BIN_PATH: "own" })).toEqual({ RG_BIN_PATH: "own" })
			expect(await hostEnvironment(undefined, { PATH: "p" })).toEqual({ PATH: "p" })
			rmSync(rg)
			expect(await hostEnvironment(appRoot, { PATH: "p" })).toEqual({ PATH: "p" })
		} finally {
			rmSync(appRoot, { force: true, recursive: true })
		}
	})
})

describe("shutdown lifecycle", () => {
	it("waits for queued persistence and a Host barrier before permitting an update", async () => {
		let finishWrite: () => void = () => {}
		const queueWrite = new Promise<void>((resolve) => {
			finishWrite = resolve
		})
		const call = vi.fn().mockResolvedValueOnce({ pong: true }).mockResolvedValueOnce([])
		const runtime: OctoCodeRuntime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			queueWrite,
			runningSessions: new Map(),
			drainingSessions: new Map(),
			call,
		})
		const idle = runtime.awaitIdleForUpdate()
		expect(call).not.toHaveBeenCalled()
		finishWrite()
		await idle
		expect(call.mock.calls.map(([method]) => method)).toEqual(["ping", "session.list"])
	})

	it("blocks an update for tasks starting during the barrier or running in another window", async () => {
		const runningSessions = new Map<string, string>()
		// The ping itself starts a task: the gate must re-check through the Host
		// even when this process's map was empty at entry.
		const runtime: OctoCodeRuntime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			queueWrite: Promise.resolve(),
			runningSessions,
			drainingSessions: new Map(),
			call: vi.fn(async (method: string) => {
				runningSessions.set("owned", "task")
				return method === "ping" ? { pong: true } : []
			}),
		})
		await expect(runtime.awaitIdleForUpdate()).rejects.toThrow(/active/i)
		runningSessions.clear()
		Object.assign(runtime, {
			call: vi
				.fn()
				.mockResolvedValueOnce({ pong: true })
				.mockResolvedValueOnce([{ status: "running" }]),
		})
		await expect(runtime.awaitIdleForUpdate()).rejects.toThrow(/active/i)
	})

	it("starts one host when initial RPC calls arrive concurrently", async () => {
		const storage = mkdtempSync(join(tmpdir(), "octocode-runtime-"))
		const previousHostPath = process.env.OCTOCODE_HOST_PATH
		process.env.OCTOCODE_HOST_PATH = process.execPath
		connectMock.mockImplementation(
			async (options: { onLine: (line: string) => void; onLog: (line: string) => void }) => {
				const socket = new PassThrough()
				options.onLog("[OctoCode host] attached broker=42 pid=43")
				socket.on("data", (chunk) => {
					for (const line of String(chunk).trim().split("\n")) {
						const { id } = JSON.parse(line) as { id: number }
						options.onLine(JSON.stringify({ id, result: { ok: true } }))
					}
				})
				return socket
			},
		)
		const output = { appendLine: vi.fn() }
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		Object.assign(runtime, {
			runningSessions: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			context: { extensionPath: storage, globalStorageUri: { fsPath: storage } },
			defaultWorkspace: vi.fn().mockResolvedValue(storage),
			disposed: false,
			eventEmitter: { dispose: vi.fn(), fire: vi.fn() },
			modelsApi: { dispose: vi.fn() },
			nextId: 1,
			output,
			pending: new Map(),
			pendingUserInput: new Map(),
		})

		try {
			await Promise.all([runtime.health(), runtime.health()])

			expect(connectMock).toHaveBeenCalledOnce()
			expect(
				output.appendLine.mock.calls.filter(([line]) => line.includes("[OctoCode host] attached")),
			).toHaveLength(1)
		} finally {
			runtime.dispose()
			rmSync(storage, { force: true, recursive: true })
			if (previousHostPath === undefined) delete process.env.OCTOCODE_HOST_PATH
			else process.env.OCTOCODE_HOST_PATH = previousHostPath
			connectMock.mockReset()
		}
	})

	it("does not write to the output channel after disposal", () => {
		const output = { appendLine: vi.fn() }
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as unknown as {
			dispose(): void
			stop(error: Error): void
			acceptLine(line: string): void
		}
		Object.assign(runtime, {
			runningSessions: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			output,
			pending: new Map(),
			pendingUserInput: new Map(),
			eventEmitter: { dispose: vi.fn() },
			modelsApi: { dispose: vi.fn() },
		})

		runtime.dispose()
		runtime.stop(new Error("process exited"))
		runtime.acceptLine('{"task_id":"task-a","session_id":"session-a","kind":"agent.finished","payload":{}}')

		expect(output.appendLine).not.toHaveBeenCalled()
	})
})

describe("user input requests", () => {
	it("waits for a reply in the authenticated task before resuming", async () => {
		const fire = vi.fn()
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		Object.assign(runtime, {
			runningSessions: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			eventEmitter: { fire },
			pendingUserInput: new Map(),
		})

		const answer = runtime.requestUserInput({ taskId: "task-a", sessionId: "session-a" }, "Which branch?", [
			"main",
			"dev",
		])
		expect(fire).toHaveBeenCalledWith({
			task_id: "task-a",
			session_id: "session-a",
			kind: "agent.needs_input",
			payload: { status: "needs_input", question: "Which branch?", options: ["main", "dev"] },
		})
		expect(runtime.replyUserInput("session-a", "main")).toBe(true)
		await expect(answer).resolves.toEqual({ answer: "main" })
	})

	it("lets the agent decide on its own when the question goes unanswered", async () => {
		vi.useFakeTimers()
		try {
			vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
				get: (key: string) => (key === "agent.askUserTimeoutSeconds" ? 2 : undefined),
			} as unknown as vscode.WorkspaceConfiguration)
			const fire = vi.fn()
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				cancelledTasks: new Set(),
			}) as OctoCodeRuntime
			Object.assign(runtime, { eventEmitter: { fire }, pendingUserInput: new Map() })
			const answer = runtime.requestUserInput({ taskId: "task-a", sessionId: "session-a" }, "Which branch?")
			await vi.advanceTimersByTimeAsync(2_000)
			await expect(answer).resolves.toMatchObject({
				timedOut: true,
				answer: expect.stringContaining("choose the most reasonable option"),
			})
			expect(fire).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "agent.needs_input_expired" }))
			expect(runtime.replyUserInput("session-a", "late")).toBe(false)
		} finally {
			vi.useRealTimers()
			vi.restoreAllMocks()
		}
	})

	it("rejects a pending input when its task finishes", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		Object.assign(runtime, {
			runningSessions: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			eventEmitter: { fire: vi.fn() },
			pendingUserInput: new Map(),
		})
		const answer = runtime.requestUserInput({ taskId: "task-a", sessionId: "session-a" }, "Which branch?")

		runtime.rejectUserInput("task-a", new Error("OctoCode task finished"))
		await expect(answer).rejects.toThrow("OctoCode task finished")
	})

	it("rejects a pending input when the runtime is disposed", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		Object.assign(runtime, {
			runningSessions: new Map(),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			eventEmitter: { fire: vi.fn(), dispose: vi.fn() },
			modelsApi: { dispose: vi.fn() },
			pending: new Map(),
			pendingUserInput: new Map(),
		})
		const answer = runtime.requestUserInput({ taskId: "task-a", sessionId: "session-a" }, "Which branch?")

		runtime.dispose()
		await expect(answer).rejects.toThrow("OctoCode host stopped")
	})
})

it("uses the installation workspace when no folder is open, without copying files", async () => {
	const base = mkdtempSync(join(tmpdir(), "octocode-default-workspace-"))
	const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
		cancelledTasks: new Set(),
	}) as OctoCodeRuntime
	Object.assign(runtime, { context: { globalStorageUri: { fsPath: join(base, "storage") } } })
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: () => join(base, "workspace"),
	} as unknown as vscode.WorkspaceConfiguration)
	try {
		const workspace = await runtime["defaultWorkspace"]()
		expect(workspace).toBe(join(base, "workspace"))
		writeFileSync(join(workspace, "result.txt"), "user output")
		expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("user output")
		expect(existsSync(join(workspace, ".octocode", "sessions"))).toBe(false)
	} finally {
		vi.restoreAllMocks()
		rmSync(base, { recursive: true, force: true })
	}
})

describe("explicit read-only task", () => {
	it("narrows an instruction, not a bug report about read-only behavior", () => {
		for (const prompt of [
			"请只读检查项目",
			"全权限，只读检查项目",
			"检查代码，不要修改文件",
			"只读分析日志",
			"Read-only review of this code",
			"Please do not edit files",
		])
			expect(isExplicitReadOnlyTask(prompt)).toBe(true)
		for (const prompt of [
			"修复只读任务的错误",
			"Fix the read-only mode",
			"现在修改代码并测试",
			"先只读检查，再修复问题",
			"请只读检查，发现问题直接修复",
			"Read-only review, then fix the bug",
		])
			expect(isExplicitReadOnlyTask(prompt)).toBe(false)
	})
})
