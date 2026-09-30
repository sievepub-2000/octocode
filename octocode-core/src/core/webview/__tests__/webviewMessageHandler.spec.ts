// npx vitest core/webview/__tests__/webviewMessageHandler.spec.ts

import type { Mock } from "vitest"

const { mockActiveTask, mockEnhance, mockEnhanceTelemetry } = vi.hoisted(() => ({
	mockActiveTask: vi.fn(),
	mockEnhance: vi.fn(),
	mockEnhanceTelemetry: vi.fn(),
}))
vi.mock("../messageEnhancer", () => ({
	MessageEnhancer: { enhanceMessage: mockEnhance, captureTelemetry: mockEnhanceTelemetry },
}))

const { mockRuntimeCall, mockAllInstances, mockSetActiveRuntimeSession, mockClearActiveRuntimeSession } = vi.hoisted(
	() => ({
		mockRuntimeCall: vi.fn(),
		mockAllInstances: vi.fn(),
		mockSetActiveRuntimeSession: vi.fn(),
		mockClearActiveRuntimeSession: vi.fn(),
	}),
)

// Mock dependencies - must come before imports
vi.mock("../../../api/providers/fetchers/modelCache")
vi.mock("../../../services/octocode-auth", () => ({
	disconnectOctoCode: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../../api/providers/fetchers/lmstudio", () => ({
	getLMStudioModels: vi.fn(),
}))

vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn(),
		getAccountId: vi.fn(),
	},
}))

vi.mock("../../../integrations/openai-codex/rate-limits", () => ({
	fetchOpenAiCodexRateLimitInfo: vi.fn(),
}))

vi.mock("../../../services/command/commands", () => ({
	getCommands: vi.fn(),
}))

vi.mock("../../../services/destructive-command-guard", () => ({
	ensureDcgInstalled: vi.fn(),
}))

vi.mock("../../../services/octocode-runtime/OctoCodeRuntime", () => ({
	getOctoCodeRuntime: () => ({ call: mockRuntimeCall, getQueue: vi.fn().mockResolvedValue([]) }),
	normalizeAudioParams: (_method: string, params: unknown) => params,
}))

vi.mock("../ClineProvider", () => ({
	ClineProvider: {
		getActiveRuntimeTask: mockActiveTask,
		getAllInstances: mockAllInstances,
		setActiveRuntimeSession: mockSetActiveRuntimeSession,
		clearActiveRuntimeSession: mockClearActiveRuntimeSession,
	},
}))

vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(),
}))

vi.mock("google-auth-library", () => ({
	GoogleAuth: vi.fn(),
}))

vi.mock("ollama", () => ({
	Ollama: vi.fn(),
}))

// Mock the diagnosticsHandler module
vi.mock("../diagnosticsHandler", () => ({
	generateErrorDiagnostics: vi.fn().mockResolvedValue({ success: true, filePath: "/tmp/diagnostics.json" }),
}))

vi.mock("../rulesMessageHandler", () => ({
	handleRequestRules: vi.fn(),
	handleCreateRule: vi.fn(),
	handleDeleteRule: vi.fn(),
	handleOpenRuleFile: vi.fn(),
	handleOpenRulesDirectory: vi.fn(),
}))

import type { ModelRecord, WebviewMessage } from "@roo-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import { flushModels, getModels } from "../../../api/providers/fetchers/modelCache"
import { getLMStudioModels } from "../../../api/providers/fetchers/lmstudio"
import { getCommands } from "../../../services/command/commands"
import { ensureDcgInstalled } from "../../../services/destructive-command-guard"
import {
	handleCreateRule,
	handleDeleteRule,
	handleOpenRuleFile,
	handleOpenRulesDirectory,
	handleRequestRules,
} from "../rulesMessageHandler"
const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
const { fetchOpenAiCodexRateLimitInfo } = await import("../../../integrations/openai-codex/rate-limits")

const mockGetModels = getModels as Mock<typeof getModels>
const mockFlushModels = flushModels as Mock<typeof flushModels>
const mockGetLMStudioModels = getLMStudioModels as Mock<typeof getLMStudioModels>
const mockGetCommands = vi.mocked(getCommands)
const mockGetAccessToken = vi.mocked(openAiCodexOAuthManager.getAccessToken)
const mockGetAccountId = vi.mocked(openAiCodexOAuthManager.getAccountId)
const mockFetchOpenAiCodexRateLimitInfo = vi.mocked(fetchOpenAiCodexRateLimitInfo)
type MockMcpHub = { handleMcpEnabledChange: ReturnType<typeof vi.fn> }
type MutableMockProvider = {
	contextProxy: Record<string, unknown>
	providerSettingsManager: Record<string, unknown>
	upsertProviderProfile: ReturnType<typeof vi.fn>
	cwd: string
	getMcpHub: ReturnType<typeof vi.fn>
}
describe("webviewMessageHandler - diagnostic logging", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockRuntimeCall.mockResolvedValue({ id: 1 })
	})

	it("persists bounded webview errors in the unified log store", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "webviewLog",
			payload: { level: "error", message: "render failed", source: "window.error" },
		})

		expect(mockRuntimeCall).toHaveBeenCalledWith("log.create", {
			category: "system",
			fields: { source: "window.error" },
			level: "error",
			message: "render failed",
			subsystem: "webview",
		})
		expect(mockClineProvider.log).toHaveBeenCalledWith("[webview:error] render failed")
	})
})

// Mock ClineProvider
const mockClineProvider = {
	getState: vi.fn(),
	postMessageToWebview: vi.fn(),
	customModesManager: {
		getCustomModes: vi.fn(),
		deleteCustomMode: vi.fn(),
	},
	context: {
		extensionPath: "/mock/extension/path",
		globalStorageUri: { fsPath: "/mock/global/storage" },
	},
	contextProxy: {
		context: {
			extensionPath: "/mock/extension/path",
			globalStorageUri: { fsPath: "/mock/global/storage" },
		},
		setValue: vi.fn(),
		getValue: vi.fn(),
	},
	log: vi.fn(),
	postStateToWebview: vi.fn(),
	getCurrentTask: vi.fn(),
	getTaskWithId: vi.fn(),
	createTaskWithHistoryItem: vi.fn(),
	startRuntimeTask: vi.fn().mockResolvedValue({ sessionId: "session-1", taskId: "task-1" }),
	showLogsInTerminal: vi.fn(),
	getSkillsManager: vi.fn(),
	cwd: "/mock/workspace",
} as unknown as ClineProvider
const mutableMockClineProvider = mockClineProvider as unknown as MutableMockProvider

describe("Runtime prompt enhancement history", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockRuntimeCall.mockReset()
		mockActiveTask.mockReturnValue({ sessionId: "selected-session", taskId: "run-1" })
		mockEnhance.mockResolvedValue({ success: true, enhancedText: "Enhanced" })
		vi.mocked(mockClineProvider.getState).mockResolvedValue({
			apiConfiguration: {},
			includeTaskHistoryInEnhance: true,
		} as Awaited<ReturnType<ClineProvider["getState"]>>)
	})
	it("reads only the selected session's persisted history when enabled", async () => {
		const rows = [{ role: "user", content: "Previous goal" }]
		mockRuntimeCall.mockResolvedValue(rows)
		await webviewMessageHandler(mockClineProvider, { type: "enhancePrompt", text: "Continue" })
		expect(mockRuntimeCall).toHaveBeenCalledExactlyOnceWith("message.list", { session_id: "selected-session" })
		expect(mockEnhance).toHaveBeenCalledWith(
			expect.objectContaining({ runtimeMessages: rows, includeTaskHistoryInEnhance: true }),
		)
		expect(mockEnhanceTelemetry).toHaveBeenCalledWith("selected-session", true)
	})
	it("does not query history when the setting is disabled", async () => {
		vi.mocked(mockClineProvider.getState).mockResolvedValue({
			apiConfiguration: {},
			includeTaskHistoryInEnhance: false,
		} as Awaited<ReturnType<ClineProvider["getState"]>>)
		await webviewMessageHandler(mockClineProvider, { type: "enhancePrompt", text: "Continue" })
		expect(mockRuntimeCall).not.toHaveBeenCalled()
		expect(mockEnhance).toHaveBeenCalledWith(expect.objectContaining({ runtimeMessages: [] }))
	})
	it("does not expose history or provider errors through logs", async () => {
		mockRuntimeCall.mockRejectedValue(new Error("fixture-secret"))
		await webviewMessageHandler(mockClineProvider, { type: "enhancePrompt", text: "Continue" })
		expect(mockEnhance).not.toHaveBeenCalled()
		expect(mockClineProvider.log).toHaveBeenCalledWith("Prompt enhancement failed")
		expect(JSON.stringify(vi.mocked(mockClineProvider.log).mock.calls)).not.toContain("fixture-secret")
	})
})

describe("webviewMessageHandler - log inspector", () => {
	it("forwards queried logs to the fixed terminal region", async () => {
		const records = [{ id: 7, level: "warn", subsystem: "browser", message: "retried", fields: {}, created_at: 1 }]
		mockRuntimeCall.mockResolvedValueOnce(records)

		await webviewMessageHandler(mockClineProvider, {
			type: "runtimeRequest",
			payload: { requestId: "logs-1", method: "log.list", params: { category: "system", keyword: "browser" } },
		})

		expect(mockClineProvider.showLogsInTerminal).toHaveBeenCalledWith(records, "system")
	})
})

describe("webviewMessageHandler - runtime history", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("loads and broadcasts a selected runtime session transcript", async () => {
		mockAllInstances.mockReturnValue([mockClineProvider])
		mockRuntimeCall
			.mockResolvedValueOnce({
				id: "session-1",
				title: "History prompt",
				status: "running",
				phase: "executing",
			})
			.mockResolvedValueOnce({ after: 0, skipped_turns: 0 })
			.mockResolvedValueOnce([
				{ id: "message-1", role: "user", content: "History prompt" },
				{ id: "message-2", role: "user", content: "Follow-up prompt" },
			])
			.mockResolvedValueOnce({
				rows: [
					[1, "harness.prepared", { harness: "octocode", task_id: "task-1" }],
					[2, "text", { data: "History answer" }],
					[3, "harness.continued", { harness: "octocode", task_id: "task-2" }],
					[4, "text", { data: "Follow-up answer" }],
				],
				next: 4,
				has_more: false,
			})

		await webviewMessageHandler(mockClineProvider, { type: "openRuntimeSession", text: "session-1" })
		expect(mockSetActiveRuntimeSession).toHaveBeenCalledWith("session-1", "task-2")

		expect(mockRuntimeCall.mock.calls).toEqual([
			["session.get", { id: "session-1" }],
			["event.history_start", { session_id: "session-1", turns: 3 }],
			["message.list", { session_id: "session-1" }],
			["event.page", { session_id: "session-1", after: 0, limit: 2000, presentation: true }],
		])
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "runtimeSessionLoaded",
			payload: {
				prompt: "History prompt",
				historyTurns: 3,
				hasEarlierHistory: false,
				images: [],
				startedAt: undefined,
				updatedAt: undefined,
				sessionId: "session-1",
				taskId: "task-2",
				status: "running",
				phase: "executing",
				queue: [],
				events: [
					{
						task_id: "task-1",
						session_id: "session-1",
						kind: "harness.prepared",
						payload: { harness: "octocode", task_id: "task-1" },
					},
					{
						task_id: "task-1",
						session_id: "session-1",
						kind: "text",
						payload: { data: "History answer" },
					},
					{
						task_id: "task-2",
						session_id: "session-1",
						kind: "user.message",
						payload: { text: "Follow-up prompt", images: [] },
					},
					{
						task_id: "task-2",
						session_id: "session-1",
						kind: "harness.continued",
						payload: { harness: "octocode", task_id: "task-2" },
					},
					{
						task_id: "task-2",
						session_id: "session-1",
						kind: "text",
						payload: { data: "Follow-up answer" },
					},
				],
			},
		})
	})

	it("resets every conversation view after deleting the active runtime session", async () => {
		mockRuntimeCall.mockResolvedValueOnce({ deleted: true })
		mockClearActiveRuntimeSession.mockReturnValueOnce(true)
		mockAllInstances.mockReturnValueOnce([mockClineProvider])

		await webviewMessageHandler(mockClineProvider, {
			type: "runtimeRequest",
			payload: { requestId: "delete-1", method: "session.delete", params: { id: "session-1" } },
		})

		expect(mockClearActiveRuntimeSession).toHaveBeenCalledWith("session-1")
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})
})

import { t } from "../../../i18n"

vi.mock("vscode", () => {
	const showInformationMessage = vi.fn()
	const showErrorMessage = vi.fn()
	const openTextDocument = vi.fn().mockResolvedValue({})
	const showTextDocument = vi.fn().mockResolvedValue(undefined)

	return {
		extensions: {
			all: [
				{
					packageJSON: {
						contributes: {
							themes: [
								{ id: "dark", label: "Dark" },
								{ id: "light", label: "Light" },
							],
						},
					},
				},
			],
		},
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		window: {
			showInformationMessage,
			showErrorMessage,
			showTextDocument,
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
			openTextDocument,
			getConfiguration: vi.fn(() => ({ get: vi.fn() })),
		},
		commands: {
			executeCommand: vi.fn().mockResolvedValue(undefined),
		},
	}
})

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, args?: Record<string, string>) => {
		// For the delete confirmation with rules, we need to return the interpolated string
		if (key === "common:confirmation.delete_custom_mode_with_rules" && args) {
			return `Are you sure you want to delete this ${args.scope} mode?\n\nThis will also delete the associated rules folder at:\n${args.rulesFolderPath}`
		}
		// Return the translated value for "Yes"
		if (key === "common:answers.yes") {
			return "Yes"
		}
		// Return the translated value for "Cancel"
		if (key === "common:answers.cancel") {
			return "Cancel"
		}
		return key
	}),
}))

vi.mock("fs/promises", () => {
	const mockRm = vi.fn().mockResolvedValue(undefined)
	const mockMkdir = vi.fn().mockResolvedValue(undefined)
	const mockReadFile = vi.fn().mockResolvedValue("[]")
	const mockWriteFile = vi.fn().mockResolvedValue(undefined)

	return {
		default: {
			rm: mockRm,
			mkdir: mockMkdir,
			readFile: mockReadFile,
			writeFile: mockWriteFile,
		},
		rm: mockRm,
		mkdir: mockMkdir,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
	}
})

import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as fsUtils from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"
import { generateErrorDiagnostics } from "../diagnosticsHandler"
import type { ModeConfig } from "@roo-code/types"

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")
vi.mock("../../../utils/globalContext")

vi.mock("../../mentions/resolveImageMentions", () => ({
	resolveImageMentions: vi.fn(async ({ text, images }: { text: string; images?: string[] }) => ({
		text,
		images: [...(images ?? []), "data:image/png;base64,from-mention"],
	})),
}))

import { resolveImageMentions } from "../../mentions/resolveImageMentions"

describe("webviewMessageHandler - inline color themes", () => {
	it("reads a fresh configuration after saving and rejects unavailable themes", async () => {
		let current = "dark"
		let followSystem = false
		let workspaceTheme: string | undefined = "legacy"
		const update = vi.fn(async (key: string, value: unknown) => {
			if (key === "colorTheme") current = String(value)
			if (key === "autoDetectColorScheme") followSystem = value === true
			if (key === "workbench.colorTheme" && value === undefined) workspaceTheme = undefined
		})
		await vi.mocked(vscode.workspace.getConfiguration).withImplementation(
			() => {
				const snapshot = current
				return {
					get: (key: string) => (key === "colorTheme" ? snapshot : followSystem),
					inspect: (key: string) =>
						key === "workbench.colorTheme" ? { workspaceValue: workspaceTheme } : undefined,
					update,
				} as unknown as vscode.WorkspaceConfiguration
			},
			async () => {
				await webviewMessageHandler(mockClineProvider, { type: "setColorTheme", text: "light" })
				expect(update).toHaveBeenCalledWith("colorTheme", "light", vscode.ConfigurationTarget.Global)
				expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith({
					type: "colorThemeSettings",
					error: undefined,
					colorThemeSettings: {
						current: "light",
						followSystem: false,
						themes: [
							{ id: "dark", label: "Dark" },
							{ id: "light", label: "Light" },
						],
					},
				})
				expect(update).toHaveBeenCalledWith(
					"workbench.colorTheme",
					undefined,
					vscode.ConfigurationTarget.Workspace,
				)
				expect(workspaceTheme).toBeUndefined()
				await webviewMessageHandler(mockClineProvider, { type: "setColorTheme", text: "not-installed" })
				expect(update).toHaveBeenCalledTimes(4)
				expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith(
					expect.objectContaining({
						type: "colorThemeSettings",
						error: "common:ui.themeNotInstalled",
					}),
				)
				await webviewMessageHandler(mockClineProvider, { type: "setColorTheme", text: "__system__" })
				expect(update).toHaveBeenCalledWith("autoDetectColorScheme", true, vscode.ConfigurationTarget.Global)
				expect(mockClineProvider.postMessageToWebview).toHaveBeenLastCalledWith(
					expect.objectContaining({
						colorThemeSettings: expect.objectContaining({ followSystem: true }),
						error: undefined,
					}),
				)
			},
		)
	})
})
import { Terminal } from "../../../integrations/terminal/Terminal"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

describe("webviewMessageHandler - unified OctoCode task route", () => {
	it("routes new tasks through the provider runtime entrypoint", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({})
		await webviewMessageHandler(mockClineProvider, {
			type: "newTask",
			text: "inspect",
			images: ["data:image/png;base64,direct"],
			taskId: "requested-session",
		})

		expect(mockClineProvider.startRuntimeTask).toHaveBeenCalledWith(
			"inspect",
			["data:image/png;base64,direct", "data:image/png;base64,from-mention"],
			"requested-session",
		)
	})
})

describe("webviewMessageHandler - requestLmStudioModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetLMStudioModels.mockReset()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				lmStudioModelId: "model-1",
				lmStudioBaseUrl: "http://localhost:1234",
			},
		})
	})

	it("successfully fetches models from LMStudio", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsPromptCache: false,
				description: "Test model 2",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestLmStudioModels",
		})

		expect(mockGetModels).toHaveBeenCalledWith({ provider: "lmstudio", baseUrl: "http://localhost:1234" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "lmStudioModels",
			lmStudioModels: mockModels,
		})
	})

	it("prefers the request payload base URL over persisted settings", async () => {
		mockGetLMStudioModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestLmStudioModels",
			values: { baseUrl: "http://127.0.0.1:4321" },
		})

		expect(mockGetLMStudioModels).toHaveBeenCalledWith("http://127.0.0.1:4321")
		expect(mockGetModels).not.toHaveBeenCalled()
	})

	it("treats an empty-string base URL as an explicit preview request", async () => {
		mockGetLMStudioModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestLmStudioModels",
			values: { baseUrl: "" },
		})

		expect(mockGetLMStudioModels).toHaveBeenCalledWith("")
		expect(mockGetModels).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - requestOllamaModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFlushModels.mockReset()
		mockFlushModels.mockResolvedValue(undefined)
		mockGetModels.mockReset()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				ollamaModelId: "model-1",
				ollamaBaseUrl: "http://localhost:1234",
			},
		})
	})

	it("successfully fetches models from Ollama", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsPromptCache: false,
				description: "Test model 2",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
		})

		expect(mockGetModels).toHaveBeenCalledWith({ provider: "ollama", baseUrl: "http://localhost:1234" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: mockModels,
		})
	})

	it("posts empty models response when no models are found", async () => {
		mockGetModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: {},
		})
	})

	it("posts empty models response with error message and logs to output on fetch failure", async () => {
		mockGetModels.mockRejectedValue(new Error("Connection refused"))

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: {},
			error: "Connection refused",
		})

		expect(mockClineProvider.log).toHaveBeenCalledWith(
			"[requestOllamaModels] Failed to read models for http://localhost:1234: Connection refused",
		)
	})

	it("distinguishes a model cache refresh failure from a model read failure", async () => {
		mockFlushModels.mockRejectedValue(new Error("Cache write failed"))

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
			values: { baseUrl: "https://ollama.example.com" },
		})

		expect(mockGetModels).not.toHaveBeenCalled()
		expect(mockClineProvider.log).toHaveBeenCalledWith(
			"[requestOllamaModels] Failed to refresh model cache for https://ollama.example.com: Cache write failed",
		)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: {},
			error: "Cache write failed",
		})
	})

	it("uses baseUrl from message values over saved state", async () => {
		const mockModels: ModelRecord = {
			"remote-model": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Remote model",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOllamaModels",
			values: {
				baseUrl: "https://ollama.example.com",
				apiKey: "secret-key",
			},
		})

		// Should use the URL from message values, not the saved state
		expect(mockFlushModels).toHaveBeenCalledWith(
			{
				provider: "ollama",
				baseUrl: "https://ollama.example.com",
				apiKey: "secret-key",
			},
			true,
		)
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: "ollama",
			baseUrl: "https://ollama.example.com",
			apiKey: "secret-key",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "ollamaModels",
			ollamaModels: mockModels,
		})
	})
})

describe("webviewMessageHandler - requestRouterModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				litellmApiKey: "litellm-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		})
	})

	it("successfully fetches models from all providers", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				supportsPromptCache: false,
				description: "Test model 2",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
		})

		// Verify getModels was called for each provider
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "openrouter" })
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "requesty", apiKey: "requesty-key" })
		expect(mockGetModels).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "unbound",
			}),
		)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "vercel-ai-gateway" })
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: "litellm",
			apiKey: "litellm-key",
			baseUrl: "http://localhost:4000",
		})
		// Opencode Go's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(mockGetModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "opencode-go" }))
		// Kenari's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(mockGetModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "kenari" }))
		// NanoGPT's detailed catalog is public and may optionally be scoped by a key.
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: undefined })

		// Verify response was sent
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: mockModels,
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"octocode-gateway": mockModels,
				litellm: mockModels,
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	it("fetches Opencode Go models without an API key (public /models endpoint, regression for empty picker)", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				// Deliberately no opencodeGoApiKey — the endpoint is public.
			},
		})

		const mockModels: ModelRecord = {
			"glm-5.1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "GLM 5.1",
			},
		}
		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, { type: "requestRouterModels" })

		// Must be fetched despite no configured key, forwarding apiKey: undefined.
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "opencode-go", apiKey: undefined })

		const routerModelsCall = vi
			.mocked(mockClineProvider.postMessageToWebview)
			.mock.calls.find(([msg]: [{ type: string }]) => msg.type === "routerModels")
		expect(routerModelsCall?.[0]?.routerModels?.["opencode-go"]).toEqual(mockModels)
	})

	it("flushes and fetches Opencode Go models when an explicit API key is supplied", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {},
		})
		mockGetModels.mockResolvedValue({
			"opencode/model": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Opencode model",
			},
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				provider: "opencode-go",
				opencodeGoApiKey: "fresh-key",
			},
		})

		expect(mockFlushModels).toHaveBeenCalledWith({ provider: "opencode-go", apiKey: "fresh-key" }, true)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "opencode-go", apiKey: "fresh-key" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				"opencode-go": {
					"opencode/model": expect.objectContaining({ description: "Opencode model" }),
				},
			},
			values: { provider: "opencode-go" },
		})
	})

	it("flushes and fetches Kenari models when an explicit API key is supplied", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {},
		})
		mockGetModels.mockResolvedValue({
			"glm-5-2": {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsPromptCache: false,
				description: "Kenari model",
			},
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				provider: "kenari",
				kenariApiKey: "fresh-kenari-key",
			},
		})

		expect(mockFlushModels).toHaveBeenCalledWith({ provider: "kenari", apiKey: "fresh-kenari-key" }, true)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "kenari", apiKey: "fresh-kenari-key" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				kenari: {
					"glm-5-2": expect.objectContaining({ description: "Kenari model" }),
				},
			},
			values: { provider: "kenari" },
		})
	})

	it("fetches NanoGPT publicly without an API key", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({ apiConfiguration: {} })
		mockGetModels.mockResolvedValue({
			"openai/gpt-5.6-sol": { maxTokens: 128000, contextWindow: 1050000, supportsPromptCache: false },
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: { provider: "nanogpt" },
		})

		expect(mockGetModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: undefined })
		expect(mockFlushModels).not.toHaveBeenCalled()
	})

	it("prefers an unsaved NanoGPT key and refreshes the matching key-scoped cache", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: { nanoGptApiKey: "saved-key" },
		})
		mockGetModels.mockResolvedValue({
			"openai/gpt-5.6-sol": { maxTokens: 128000, contextWindow: 1050000, supportsPromptCache: false },
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: { provider: "nanogpt", nanoGptApiKey: "unsaved-key" },
		})

		expect(mockFlushModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: "unsaved-key" }, true)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: "unsaved-key" })
	})

	it("uses the saved NanoGPT key for manual refresh", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: { nanoGptApiKey: "saved-key" },
		})
		mockGetModels.mockResolvedValue({})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: { provider: "nanogpt", refresh: true },
		})

		expect(mockFlushModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: "saved-key" }, true)
		expect(mockGetModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: "saved-key" })
	})

	it("handles LiteLLM models with values from message when config is missing", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// Missing litellm config
			},
		})

		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				litellmApiKey: "message-litellm-key",
				litellmBaseUrl: "http://message-url:4000",
			},
		})

		// Verify LiteLLM was called with values from message
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: "litellm",
			apiKey: "message-litellm-key",
			baseUrl: "http://message-url:4000",
		})
	})

	it("skips LiteLLM when both config and message values are missing", async () => {
		mockClineProvider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// Missing litellm config
			},
		})

		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
		}

		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			// No values provided
		})

		// Verify LiteLLM was NOT called
		expect(mockGetModels).not.toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "litellm",
			}),
		)

		// Verify response includes empty object for LiteLLM
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: mockModels,
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"octocode-gateway": mockModels,
				litellm: {},
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	it("handles individual provider failures gracefully", async () => {
		const mockModels: ModelRecord = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				supportsPromptCache: false,
				description: "Test model 1",
			},
		}

		// Mock some providers to succeed and others to fail
		mockGetModels
			.mockResolvedValueOnce(mockModels) // openrouter
			.mockRejectedValueOnce(new Error("Requesty API error")) // requesty
			.mockResolvedValueOnce(mockModels) // unbound
			.mockResolvedValueOnce(mockModels) // vercel-ai-gateway
			.mockResolvedValueOnce(mockModels) // octocode-gateway
			.mockRejectedValueOnce(new Error("LiteLLM connection failed")) // litellm
			.mockResolvedValueOnce(mockModels) // opencode-go
			.mockResolvedValueOnce(mockModels) // kenari
			.mockResolvedValueOnce(mockModels) // nanogpt

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
		})

		// Verify error messages were sent for failed providers (these come first)
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Requesty API error",
			values: { provider: "requesty" },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "LiteLLM connection failed",
			values: { provider: "litellm" },
		})

		// Verify final routerModels response includes successful providers and empty objects for failed ones
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: {},
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"octocode-gateway": mockModels,
				litellm: {},
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	it("handles Error objects and string errors correctly", async () => {
		// Mock providers to fail with different error types
		mockGetModels
			.mockRejectedValueOnce(new Error("Structured error message")) // openrouter
			.mockRejectedValueOnce(new Error("Requesty API error")) // requesty
			.mockRejectedValueOnce(new Error("Unbound error")) // unbound
			.mockRejectedValueOnce(new Error("Vercel AI Gateway error")) // vercel-ai-gateway
			.mockRejectedValueOnce(new Error("OctoCode Gateway error")) // octocode-gateway
			.mockRejectedValueOnce(new Error("LiteLLM connection failed")) // litellm

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
		})

		// Verify error handling for different error types
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Structured error message",
			values: { provider: "openrouter" },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Requesty API error",
			values: { provider: "requesty" },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Unbound error",
			values: { provider: "unbound" },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Vercel AI Gateway error",
			values: { provider: "vercel-ai-gateway" },
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "LiteLLM connection failed",
			values: { provider: "litellm" },
		})
	})

	it("returns an explicit removal error for requestRooModels", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "requestRooModels",
		})

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Roo Code Router has been removed. Please select and configure a different provider.",
			values: { provider: "roo" },
		})
	})

	it("prefers message values over config values for LiteLLM", async () => {
		const mockModels: ModelRecord = {}
		mockGetModels.mockResolvedValue(mockModels)

		await webviewMessageHandler(mockClineProvider, {
			type: "requestRouterModels",
			values: {
				litellmApiKey: "message-key",
				litellmBaseUrl: "http://message-url",
			},
		})

		// Verify message values take precedence over saved config (current unsaved field state wins)
		expect(mockGetModels).toHaveBeenCalledWith({
			provider: "litellm",
			apiKey: "message-key", // From message.values
			baseUrl: "http://message-url", // From message.values
		})
	})
})

describe("webviewMessageHandler - requestOpenAiCodexRateLimits", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetAccessToken.mockResolvedValue(null)
		mockGetAccountId.mockResolvedValue(null)
	})

	it("posts error when not authenticated", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "requestOpenAiCodexRateLimits",
		} as unknown as WebviewMessage)

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiCodexRateLimits",
			error: "Not authenticated with OpenAI Codex",
		})
	})

	it("posts values when authenticated", async () => {
		mockGetAccessToken.mockResolvedValue("token")
		mockGetAccountId.mockResolvedValue("acct_123")
		mockFetchOpenAiCodexRateLimitInfo.mockResolvedValue({
			primary: { usedPercent: 10, resetsAt: 1700000000000 },
			fetchedAt: 1700000000000,
		})

		await webviewMessageHandler(mockClineProvider, {
			type: "requestOpenAiCodexRateLimits",
		} as unknown as WebviewMessage)

		expect(mockFetchOpenAiCodexRateLimitInfo).toHaveBeenCalledWith("token", { accountId: "acct_123" })
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiCodexRateLimits",
			values: {
				primary: { usedPercent: 10, resetsAt: 1700000000000 },
				fetchedAt: 1700000000000,
			},
		})
	})
})

describe("webviewMessageHandler - deleteCustomMode", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getWorkspacePath).mockReturnValue("/mock/workspace")
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined)
		vi.mocked(ensureSettingsDirectoryExists).mockResolvedValue("/mock/global/storage/.roo")
	})

	it("should delete a project mode and its rules folder", async () => {
		const slug = "test-project-mode"
		const rulesFolderPath = path.join("/mock/workspace", ".roo", `rules-${slug}`)

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Project Mode",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
	})

	it("should delete a global mode and its rules folder", async () => {
		const slug = "test-global-mode"
		const homeDir = os.homedir()
		const rulesFolderPath = path.join(homeDir, ".roo", `rules-${slug}`)

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Global Mode",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "global",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
	})

	it("should only delete the mode when rules folder does not exist", async () => {
		const slug = "test-mode-no-rules"
		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Mode No Rules",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).not.toHaveBeenCalled()
	})

	it("should handle errors when deleting rules folder", async () => {
		const slug = "test-mode-error"
		const rulesFolderPath = path.join("/mock/workspace", ".roo", `rules-${slug}`)
		const error = new Error("Permission denied")

		vi.mocked(mockClineProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Mode Error",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockClineProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)
		vi.mocked(fs.rm).mockRejectedValue(error)

		await webviewMessageHandler(mockClineProvider, { type: "deleteCustomMode", slug })

		expect(mockClineProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
		// Verify error message is shown to the user
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			t("common:errors.delete_rules_folder_failed", {
				rulesFolderPath,
				error: error.message,
			}),
		)
		// No error response is sent anymore - we just continue with deletion
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - mcpEnabled", () => {
	let mockMcpHub: MockMcpHub

	beforeEach(() => {
		vi.clearAllMocks()

		// Create a mock McpHub instance
		mockMcpHub = {
			handleMcpEnabledChange: vi.fn().mockResolvedValue(undefined),
		}

		// Ensure provider exposes getMcpHub and returns our mock
		mutableMockClineProvider.getMcpHub = vi.fn().mockReturnValue(mockMcpHub)
	})

	it("delegates enable=true to McpHub and posts updated state", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})

		expect(mutableMockClineProvider.getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(true)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("delegates enable=false to McpHub and posts updated state", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: false },
		})

		expect(mutableMockClineProvider.getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(false)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("handles missing McpHub instance gracefully and still posts state", async () => {
		mutableMockClineProvider.getMcpHub = vi.fn().mockReturnValue(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})

		expect(mutableMockClineProvider.getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})

describe("webviewMessageHandler - toggleMcpServer", () => {
	beforeEach(() => vi.clearAllMocks())

	it("posts the updated server state after the persisted toggle completes", async () => {
		const toggleServerDisabled = vi.fn().mockResolvedValue(undefined)
		Object.assign(mockClineProvider, { getMcpHub: vi.fn().mockReturnValue({ toggleServerDisabled }) })

		await webviewMessageHandler(mockClineProvider, {
			type: "toggleMcpServer",
			serverName: "code-review-graph",
			source: "global",
			disabled: true,
		})

		expect(toggleServerDisabled).toHaveBeenCalledWith("code-review-graph", true, "global")
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})

describe("webviewMessageHandler - destructiveCommandGuardEnabled", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(ensureDcgInstalled).mockResolvedValue("/mock/global/storage/dcg")
	})

	it("installs and persists destructive command guard when enabled", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(ensureDcgInstalled).toHaveBeenCalledWith("/mock/global/storage")
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", true)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("disables the setting and reports an installation failure", async () => {
		vi.mocked(ensureDcgInstalled).mockRejectedValue(new Error("checksum mismatch"))

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"common:errors.destructiveCommandGuard.enableFailed",
		)
	})

	it("disables the setting when DCG is unavailable for the current platform", async () => {
		vi.mocked(ensureDcgInstalled).mockResolvedValue(undefined)

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expect(t).toHaveBeenCalledWith("common:errors.destructiveCommandGuard.unavailable")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.destructiveCommandGuard.unavailable")
		expect(t).not.toHaveBeenCalledWith("common:errors.destructiveCommandGuard.enableFailed", expect.anything())
	})

	it("reports non-Error installation failures", async () => {
		vi.mocked(ensureDcgInstalled).mockRejectedValue("download unavailable")

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: true },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
		expect(t).toHaveBeenCalledWith("common:errors.destructiveCommandGuard.enableFailed", {
			error: "download unavailable",
		})
	})

	it("persists disabled state without trying to install", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { destructiveCommandGuardEnabled: false },
		})

		expect(ensureDcgInstalled).not.toHaveBeenCalled()
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("destructiveCommandGuardEnabled", false)
	})
})

describe("webviewMessageHandler - terminalProfile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		Terminal.setTerminalProfile(undefined)
	})

	afterEach(() => {
		Terminal.setTerminalProfile(undefined)
		vi.restoreAllMocks()
	})

	it("normalizes and persists a saved terminalProfile, then closes stale idle terminals", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: " Git Bash " },
		})

		expect(Terminal.getTerminalProfile()).toBe("Git Bash")
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", "Git Bash")
		expect(closeIdleTerminalsSpy).toHaveBeenCalledTimes(1)
	})

	it("does not close idle terminals when hydration sends the unchanged profile", async () => {
		Terminal.setTerminalProfile("Git Bash")
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: " Git Bash " },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", "Git Bash")
		expect(closeIdleTerminalsSpy).not.toHaveBeenCalled()
	})

	it("clears the persisted profile when SettingsView sends the empty-string sentinel", async () => {
		Terminal.setTerminalProfile("Git Bash")
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: "" },
		})

		expect(Terminal.getTerminalProfile()).toBeUndefined()
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", undefined)
		expect(closeIdleTerminalsSpy).toHaveBeenCalledTimes(1)
	})

	it("does not close idle terminals when the empty-string sentinel leaves the profile unset", async () => {
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: "" },
		})

		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", undefined)
		expect(closeIdleTerminalsSpy).not.toHaveBeenCalled()
	})

	it("treats non-string terminalProfile values as unset", async () => {
		Terminal.setTerminalProfile("Git Bash")
		const closeIdleTerminalsSpy = vi.spyOn(TerminalRegistry, "closeIdleTerminals").mockImplementation(() => {})

		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { terminalProfile: 42 as unknown as string },
		})

		expect(Terminal.getTerminalProfile()).toBeUndefined()
		expect(mockClineProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalProfile", undefined)
		expect(closeIdleTerminalsSpy).toHaveBeenCalledTimes(1)
	})
})

describe("webviewMessageHandler - requestTerminalProfiles", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("posts available profile names", async () => {
		vi.spyOn(Terminal, "getAvailableProfileNames").mockReturnValue(["Git Bash", "bash"])

		await webviewMessageHandler(mockClineProvider, { type: "requestTerminalProfiles" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "terminalProfiles",
			profiles: ["Git Bash", "bash"],
		})
	})

	it("posts an empty array when profile discovery throws", async () => {
		vi.spyOn(Terminal, "getAvailableProfileNames").mockImplementation(() => {
			throw new Error("config error")
		})

		await webviewMessageHandler(mockClineProvider, { type: "requestTerminalProfiles" })

		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "terminalProfiles",
			profiles: [],
		})
	})
})

describe("webviewMessageHandler - openTerminalProfilePicker", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("executes the VS Code selectDefaultShell command", async () => {
		await webviewMessageHandler(mockClineProvider, { type: "openTerminalProfilePicker" })
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.selectDefaultShell")
	})
})

describe("webviewMessageHandler - rules", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mutableMockClineProvider.cwd = "/mock/workspace"
	})

	it("routes rules management messages with the current workspace", async () => {
		const messages = [
			{ type: "requestRules" },
			{ type: "createRule", values: { scope: "project", kind: "generic", fileName: "new.md" } },
			{ type: "deleteRule", values: { scope: "project", kind: "generic", relativePath: "old.md" } },
			{ type: "openRuleFile", values: { scope: "global", kind: "generic", relativePath: "global.md" } },
			{ type: "openRulesDirectory", values: { scope: "project", kind: "mode", modeSlug: "code" } },
		] as const

		for (const message of messages) {
			await webviewMessageHandler(mockClineProvider, message as unknown as WebviewMessage)
		}

		expect(handleRequestRules).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace")
		expect(handleCreateRule).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[1])
		expect(handleDeleteRule).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[2])
		expect(handleOpenRuleFile).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[3])
		expect(handleOpenRulesDirectory).toHaveBeenCalledWith(mockClineProvider, "/mock/workspace", messages[4])
	})
})

describe("octoCodeSignOut", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("disconnects OctoCode and clears tokens from all OctoCode Gateway profiles", async () => {
		const { disconnectOctoCode } = await import("../../../services/octocode-auth")
		const upsertProviderProfile = vi.fn().mockResolvedValue(undefined)
		const saveConfig = vi.fn().mockResolvedValue(undefined)

		mutableMockClineProvider.contextProxy = {
			...mockClineProvider.contextProxy,
			getProviderSettings: vi.fn().mockReturnValue({ apiProvider: "octocode-gateway" }),
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "OctoCode Gateway" }),
		}
		mutableMockClineProvider.providerSettingsManager = {
			listConfig: vi.fn().mockResolvedValue([
				{ name: "OctoCode Gateway", apiProvider: "octocode-gateway" },
				{ name: "Backup OctoCode", apiProvider: "octocode-gateway" },
			]),
			getProfile: vi
				.fn()
				.mockResolvedValueOnce({
					apiProvider: "octocode-gateway",
					octoCodeSessionToken: "token-active",
					octoCodeGatewayModelId: "anthropic/claude-sonnet-4",
				})
				.mockResolvedValueOnce({
					apiProvider: "octocode-gateway",
					octoCodeSessionToken: "token-backup",
				}),
			saveConfig,
		}
		mutableMockClineProvider.upsertProviderProfile = upsertProviderProfile

		await webviewMessageHandler(mockClineProvider, { type: "octoCodeSignOut" })

		expect(disconnectOctoCode).toHaveBeenCalled()
		expect(upsertProviderProfile).toHaveBeenCalledWith(
			"OctoCode Gateway",
			expect.not.objectContaining({ octoCodeSessionToken: expect.anything() }),
			true,
		)
		expect(saveConfig).toHaveBeenCalledWith(
			"Backup OctoCode",
			expect.not.objectContaining({ octoCodeSessionToken: expect.anything() }),
		)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("still clears the in-memory handler when the active profile token is already empty on disk", async () => {
		const upsertProviderProfile = vi.fn().mockResolvedValue(undefined)

		mutableMockClineProvider.contextProxy = {
			...mockClineProvider.contextProxy,
			getProviderSettings: vi.fn().mockReturnValue({ apiProvider: "octocode-gateway" }),
			getValues: vi.fn().mockReturnValue({ currentApiConfigName: "OctoCode Gateway" }),
		}
		mutableMockClineProvider.providerSettingsManager = {
			listConfig: vi.fn().mockResolvedValue([{ name: "OctoCode Gateway", apiProvider: "octocode-gateway" }]),
			getProfile: vi.fn().mockResolvedValue({
				apiProvider: "octocode-gateway",
				octoCodeGatewayModelId: "anthropic/claude-sonnet-4",
			}),
			saveConfig: vi.fn(),
		}
		mutableMockClineProvider.upsertProviderProfile = upsertProviderProfile

		await webviewMessageHandler(mockClineProvider, { type: "octoCodeSignOut" })

		expect(upsertProviderProfile).toHaveBeenCalledWith(
			"OctoCode Gateway",
			expect.not.objectContaining({ octoCodeSessionToken: expect.anything() }),
			true,
		)
	})
})

describe("webviewMessageHandler - kimiCodeSignIn", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
	})

	it("starts OAuth authorization and opens browser", async () => {
		const mockStartAuthorization = vi.fn().mockResolvedValue({
			userCode: "TEST-CODE",
			verificationUri: "https://auth.kimi.com/device",
			expiresAt: Date.now() + 600000,
		})
		const mockWaitForAuthorization = vi.fn().mockResolvedValue({
			type: "kimi-code",
			accessToken: "token",
			refreshToken: "refresh",
			expiresAt: Date.now() + 3600000,
		})

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
				waitForAuthorization: mockWaitForAuthorization,
			},
		}))

		const mockOpenExternal = vi.fn().mockResolvedValue(true)
		Object.assign(vscode, {
			env: { openExternal: mockOpenExternal },
			Uri: { parse: vi.fn((url: string) => url) },
		})

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })

		expect(mockStartAuthorization).toHaveBeenCalled()
		expect(mockOpenExternal).toHaveBeenCalled()
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("shows success message after successful authorization", async () => {
		const mockStartAuthorization = vi.fn().mockResolvedValue({
			userCode: "TEST-CODE",
			verificationUri: "https://auth.kimi.com/device",
			expiresAt: Date.now() + 600000,
		})
		const mockWaitForAuthorization = vi.fn().mockResolvedValue({
			type: "kimi-code",
			accessToken: "token",
			refreshToken: "refresh",
			expiresAt: Date.now() + 3600000,
		})

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
				waitForAuthorization: mockWaitForAuthorization,
			},
		}))

		const mockOpenExternal = vi.fn().mockResolvedValue(true)
		Object.assign(vscode, {
			env: { openExternal: mockOpenExternal },
			Uri: { parse: vi.fn((url: string) => url) },
		})

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:ui.kimiSignedIn")
	})

	it("handles authorization failure", async () => {
		const mockStartAuthorization = vi.fn().mockResolvedValue({
			userCode: "TEST-CODE",
			verificationUri: "https://auth.kimi.com/device",
			expiresAt: Date.now() + 600000,
		})
		const mockWaitForAuthorization = vi.fn().mockRejectedValue(new Error("Authorization cancelled"))

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
				waitForAuthorization: mockWaitForAuthorization,
			},
		}))

		const mockOpenExternal = vi.fn().mockResolvedValue(true)
		Object.assign(vscode, {
			env: { openExternal: mockOpenExternal },
			Uri: { parse: vi.fn((url: string) => url) },
		})

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("handles startAuthorization error", async () => {
		const mockStartAuthorization = vi.fn().mockRejectedValue(new Error("Network error"))

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				startAuthorization: mockStartAuthorization,
			},
		}))

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignIn" })

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:ui.kimiSignInError")
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - kimiCodeSignOut", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.resetModules()
	})

	it("clears credentials and shows success message", async () => {
		const mockClearCredentials = vi.fn().mockResolvedValue(undefined)

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				clearCredentials: mockClearCredentials,
			},
		}))

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignOut" })

		expect(mockClearCredentials).toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:ui.kimiSignedOut")
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("handles sign out error", async () => {
		const mockClearCredentials = vi.fn().mockRejectedValue(new Error("Clear failed"))

		vi.doMock("../../../integrations/kimi-code/oauth", () => ({
			kimiCodeOAuthManager: {
				clearCredentials: mockClearCredentials,
			},
		}))

		await webviewMessageHandler(mockClineProvider, { type: "kimiCodeSignOut" })

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:ui.kimiSignOutFailed")
	})
})
