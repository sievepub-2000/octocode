// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.spec.ts

import * as path from "path"

import Anthropic from "@octocode/sdk"
import * as vscode from "vscode"
import axios from "axios"

import {
	type ProviderSettingsEntry,
	type ClineMessage,
	type ExtensionMessage,
	type ExtensionState,
	type WebviewMessage,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_DIFF_FUZZY_THRESHOLD,
	DEFAULT_WRITE_DELAY_MS,
	providerIdentifiers,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { defaultModeSlug } from "../../../shared/modes"
import { experimentDefault } from "../../../shared/experiments"
import { setTtsEnabled } from "../../../utils/tts"
import { ContextProxy } from "../../config/ContextProxy"
import { safeWriteJson } from "../../../utils/safeWriteJson"

import { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../../api/providers/fetchers/lmstudio"

// Mock setup must come before imports.
vi.mock("../../prompts/sections/custom-instructions")

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mocked = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue(""),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mocked,
		default: {
			...actual,
			...mocked,
		},
	}
})

vi.mock("axios", () => ({
	default: {
		get: vi.fn().mockResolvedValue({ data: { data: [] } }),
		post: vi.fn(),
	},
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/path")>()
	return {
		...actual,
		getWorkspacePath: vi.fn().mockReturnValue(""),
	}
})

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: {
		InvalidRequest: "InvalidRequest",
		MethodNotFound: "MethodNotFound",
		InternalError: "InternalError",
	},
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
			this.name = "McpError"
		}
	},
}))

// Remove duplicate mock - it's already defined below.

const mockAddCustomInstructions = vi.fn().mockResolvedValue("Combined instructions")

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

// MCP-related modules are mocked once above (lines 87-109).

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			listTools: vi.fn().mockResolvedValue({ tools: [] }),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
		}
	}),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	EventEmitter: vi.fn().mockImplementation(function () {
		return {
			event: vi.fn(),
			fire: vi.fn(),
			dispose: vi.fn(),
		}
	}),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		createOutputChannel: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showSaveDialog: vi.fn(),
		showOpenDialog: vi.fn(),
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		getWorkspaceFolder: vi.fn(),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	ViewColumn: { One: 1, Two: 2, Three: 3 },
	version: "1.85.0",
}))

vi.mock("../../../utils/tts", () => ({
	playTts: vi.fn().mockResolvedValue(undefined),
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
	stopTts: vi.fn(),
}))

vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../integrations/misc/image-handler", () => ({
	openImage: vi.fn().mockResolvedValue(undefined),
	saveImage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../mentions", () => ({
	openMention: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn().mockResolvedValue({ fsPath: "/test/default-export.yaml" }),
	saveLastExportPath: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockImplementation(async () => "mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				initializeFilePaths: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
			}
		}),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options: any) {
		return {
			api: undefined,
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			taskId: options?.historyItem?.id || "test-task-id",
			emit: vi.fn(),
		}
	}),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockImplementation(async (_filePath: string) => {
		const content = "const x = 1;\nconst y = 2;\nconst z = 3;"
		const lines = content.split("\n")
		return lines.map((line, index) => `${index + 1} | ${line}`).join("\n")
	}),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../api/providers/fetchers/lmstudio", () => ({
	hasLoadedFullDetails: vi.fn().mockReturnValue(false),
	forceFullModelDetailsLoad: vi.fn().mockResolvedValue(undefined),
}))

const mockAssertOctoCodeAuthenticationAllowed = vi.hoisted(() => vi.fn())

vi.mock("../../../services/octocode-auth", () => ({
	getOctoCodeBaseUrl: vi.fn(() => "https://www.octocode.dev"),
	getCachedOctoCodeToken: vi.fn(),
	handleAuthCallback: vi.fn(),
	setOctoCodeUserInfo: vi.fn(),
	disconnectOctoCode: vi.fn(),
	assertOctoCodeAuthenticationAllowed: mockAssertOctoCodeAuthenticationAllowed,
}))

vi.mock("../../../shared/modes", () => ({
	modes: [
		{
			slug: "code",
			name: "Code Mode",
			roleDefinition: "You are a code assistant",
			groups: ["read", "edit"],
		},
		{
			slug: "architect",
			name: "Architect Mode",
			roleDefinition: "You are an architect",
			groups: ["read", "edit"],
		},
		{
			slug: "ask",
			name: "Ask Mode",
			roleDefinition: "You are a helpful assistant",
			groups: ["read"],
		},
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	getGroupName: vi.fn().mockImplementation((group: string) => {
		// Return appropriate group names for different tool groups
		switch (group) {
			case "read":
				return "Read Tools"
			case "edit":
				return "Edit Tools"
			case "mcp":
				return "MCP Tools"
			default:
				return "General Tools"
		}
	}),
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockImplementation(async (_filePath: string) => {
		const content = "const x = 1;\nconst y = 2;\nconst z = 3;"
		const lines = content.split("\n")
		return lines.map((line, index) => `${index + 1} | ${line}`).join("\n")
	}),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getToolDescription: () => "test",
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				login: vi.fn().mockResolvedValue(undefined),
				logout: vi.fn().mockResolvedValue(undefined),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

afterAll(() => {
	vi.restoreAllMocks()
})

describe("ClineProvider", () => {
	beforeAll(() => {})

	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any
	let updateGlobalStateSpy: any

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "architect",
			currentApiConfigName: "current-config",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value)
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					return delete secrets[key]
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		// Mock CustomModesManager
		const mockCustomModesManager = {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
			getCustomModes: vi.fn().mockResolvedValue([]),
			dispose: vi.fn(),
		}

		// Mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		// Mock webview
		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation((callback) => {
				callback()
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		}

		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		// @ts-ignore - Access private property for testing
		updateGlobalStateSpy = vi.spyOn(provider.contextProxy, "setValue")

		// @ts-ignore - Accessing private property for testing.
		provider.customModesManager = mockCustomModesManager

		// Mock getMcpHub method for generateSystemPrompt
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	test("constructor initializes correctly", () => {
		expect(provider).toBeInstanceOf(ClineProvider)
		// Since getVisibleInstance returns the last instance where view.visible is true
		// @ts-ignore - accessing private property for testing
		provider.view = mockWebviewView
		expect(ClineProvider.getVisibleInstance()).toBe(provider)
	})

	test("clearTask clears the selected view and publishes settings", async () => {
		const evict = vi.spyOn(provider, "evictCurrentTask").mockResolvedValue(undefined)
		const publish = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
		await provider.clearTask()
		expect(evict).toHaveBeenCalledOnce()
		expect(publish).toHaveBeenCalledOnce()
	})

	test("resolveWebviewView hydrates the saved terminalProfile into the process-wide Terminal state", async () => {
		const setTerminalProfileSpy = vi.spyOn(Terminal, "setTerminalProfile").mockImplementation(() => {})
		// Seed the persisted setting so the real getState() returns it during hydration.
		await (provider as any).contextProxy.setValue("terminalProfile", "Git Bash")

		await provider.resolveWebviewView(mockWebviewView)
		// The hydration runs in a getState().then(...) callback, so flush microtasks.
		await new Promise((resolve) => setImmediate(resolve))

		expect(setTerminalProfileSpy).toHaveBeenCalledWith("Git Bash")

		setTerminalProfileSpy.mockRestore()
	})

	test("resolveWebviewView sets up webview correctly", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		expect(mockWebviewView.webview.options).toEqual({
			enableScripts: true,
			localResourceRoots: [mockContext.extensionUri],
		})

		expect(mockWebviewView.webview.html).toContain("<!DOCTYPE html>")
		expect(mockWebviewView.webview.html).toContain("<title>OctoCode</title>")
	})

	describe("logWebviewHiddenDiagnostics", () => {
		let visibilityCallback: () => void

		beforeEach(async () => {
			// Capture the visibility callback registered during resolveWebviewView
			mockWebviewView.onDidChangeVisibility = vi.fn().mockImplementation((cb: () => void) => {
				visibilityCallback = cb
				return { dispose: vi.fn() }
			})
			// @ts-ignore - accessing private property for testing
			provider.view = mockWebviewView
			await provider.resolveWebviewView(mockWebviewView)
			;(mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mockClear()
		})

		test("does not log when no task is active", () => {
			// view becomes hidden with no task on the stack
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
			visibilityCallback()
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
		})
	})

	test("resolveWebviewView sets up webview correctly in development mode even if local server is not running", async () => {
		provider = new ClineProvider(
			{ ...mockContext, extensionMode: vscode.ExtensionMode.Development },
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
		)
		;(axios.get as any).mockRejectedValueOnce(new Error("Network error"))

		await provider.resolveWebviewView(mockWebviewView)

		expect(mockWebviewView.webview.options).toEqual({
			enableScripts: true,
			localResourceRoots: [mockContext.extensionUri],
		})

		expect(mockWebviewView.webview.html).toContain("<!DOCTYPE html>")

		// Verify Content Security Policy contains the necessary PostHog domains
		expect(mockWebviewView.webview.html).toContain(
			"connect-src vscode-webview://test-csp-source https://openrouter.ai https://api.requesty.ai https://us.i.posthog.com",
		)

		// Extract the script-src directive section and verify required security elements
		const html = mockWebviewView.webview.html
		const scriptSrcMatch = html.match(/script-src[^;]*;/)
		expect(scriptSrcMatch).not.toBeNull()
		expect(scriptSrcMatch![0]).toContain("'nonce-")
		// Verify wasm-unsafe-eval is present for Shiki syntax highlighting
		expect(scriptSrcMatch![0]).toContain("'wasm-unsafe-eval'")
	})

	test("postMessageToWebview does not throw when webview is disposed", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Simulate postMessage throwing after webview disposal
		mockPostMessage.mockRejectedValueOnce(new Error("Webview is disposed"))

		const message: ExtensionMessage = { type: "action", action: "chatButtonClicked" }

		// Should not throw
		await expect(provider.postMessageToWebview(message)).resolves.toBeUndefined()
	})

	test("postStateToWebview does not force action navigation for non-compliant MDM state", async () => {
		const mdmService = {
			requiresCloudAuth: vi.fn().mockReturnValue(true),
			isCompliant: vi.fn().mockReturnValue({ compliant: false, reason: "auth required" }),
		} as any

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			mdmService,
		)

		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockImplementation(async () => undefined)
		vi.spyOn(provider as any, "getStateToPostToWebview").mockResolvedValue({ version: "1.0.0" })

		await provider.postStateToWebview()

		expect(postMessageSpy).toHaveBeenCalledTimes(1)
		expect(postMessageSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "action" }))
	})

	test("postMessageToWebview skips postMessage after dispose", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		await provider.dispose()
		mockPostMessage.mockClear()

		const message: ExtensionMessage = { type: "action", action: "chatButtonClicked" }
		await provider.postMessageToWebview(message)

		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	test("dispose is idempotent — second call is a no-op", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		await provider.dispose()
		await provider.dispose()

		// dispose body runs only once: log "Disposing ClineProvider..." appears once
		const disposeCalls = (mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mock.calls.filter(
			([msg]) => typeof msg === "string" && msg.includes("Disposing ClineProvider..."),
		)
		expect(disposeCalls).toHaveLength(1)
	})

	test("handles webviewDidLaunch message", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Get the message handler from onDidReceiveMessage
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
			.calls[0][0]

		// Simulate webviewDidLaunch message
		await messageHandler({ type: "webviewDidLaunch" })

		// Should post state and theme to webview
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("replays an artifact after a resource-root reload", async () => {
		vi.mocked(vscode.Uri.file).mockImplementation((fsPath) => ({ fsPath }) as vscode.Uri)
		mockWebviewView.webview.asWebviewUri.mockReturnValue({ toString: () => "vscode-resource://icon.png" })
		mockWebviewView.reveal = vi.fn()
		provider = new ClineProvider(mockContext, mockOutputChannel, "artifact", new ContextProxy(mockContext))
		await provider.resolveWebviewView(mockWebviewView)
		await provider.showArtifact("/outside/icon.png")
		mockPostMessage.mockClear()

		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		await messageHandler({ type: "webviewDidLaunch" })

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "artifactSelected",
			payload: {
				kind: "image",
				path: "/outside/icon.png",
				uri: "vscode-resource://icon.png",
			},
		})
	})

	test("publishes queried logs through a reusable output channel", async () => {
		const channel = { clear: vi.fn(), appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }
		const createChannel = vi.spyOn(vscode.window, "createOutputChannel").mockReturnValue(channel as unknown as vscode.LogOutputChannel)
		mockPostMessage.mockClear()
		const records = [{ id: 7, level: "warn", subsystem: "browser", message: "retried", fields: {}, created_at: 1 }]
		try {
			await provider.showLogsInTerminal(records, "system")
			await provider.showLogsInTerminal(records, "system")
			expect(createChannel).toHaveBeenCalledTimes(1)
			expect(channel.appendLine).toHaveBeenCalledWith(JSON.stringify(records[0]))
			expect(channel.show).toHaveBeenCalledWith(true)
			expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "artifactSelected" }))
			await provider.dispose()
			expect(channel.dispose).toHaveBeenCalledTimes(1)
		} finally {
			createChannel.mockRestore()
		}
	})

	test("ships no model configuration of its own", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
			.calls[0][0]

		await messageHandler({ type: "webviewDidLaunch" })

		/*
		 * The product used to launch with a provider, a model and an endpoint on
		 * one particular machine already filled in, and a migration that rewrote
		 * anything the user typed back to them. When that machine's Wi-Fi failed,
		 * every request died with no reason given and the correct address the user
		 * had entered was silently overwritten on each launch. What a person
		 * configures is now the only statement about where their model lives.
		 */
		const { apiConfiguration } = await provider.getState()
		expect(apiConfiguration.apiProvider).toBeUndefined()
		expect(apiConfiguration.apiModelId).toBeUndefined()
		expect(apiConfiguration.openAiNativeBaseUrl).toBeUndefined()
	})

	test("uses local defaults without querying an uninitialized cloud service", async () => {
		const { CloudService } = await import("@roo-code/cloud")
		const hasInstance = vi.mocked(CloudService.hasInstance)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		hasInstance.mockReturnValue(false)

		try {
			await expect(provider.getState()).resolves.toMatchObject({
				organizationAllowList: ORGANIZATION_ALLOW_ALL,
				cloudUserInfo: null,
				cloudIsAuthenticated: false,
			})
			expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("[getState] failed to get cloud")
		} finally {
			errorSpy.mockRestore()
			hasInstance.mockReturnValue(true)
		}
	})

	test("logs detached workspace initialization failures", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		let rejectInitialization!: (error: Error) => void
		const initializationPromise = new Promise<void>((_, reject) => {
			rejectInitialization = reject
		})
		const initializeSpy = vi
			.spyOn(provider.workspaceTracker!, "initializeFilePaths")
			.mockReturnValue(initializationPromise)
		const logSpy = vi.spyOn(provider, "log")
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await expect(messageHandler({ type: "webviewDidLaunch" })).resolves.toBeUndefined()
		expect(initializeSpy).toHaveBeenCalledOnce()

		rejectInitialization(new Error("workspace boom"))
		await Promise.resolve()
		await Promise.resolve()

		expect(logSpy).toHaveBeenCalledWith("Workspace initialization error: Error: workspace boom")
	})

	describe("clearTask message handler", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles case when no current task exists", async () => {
			// Don't add any tasks to the stack

			// Mock the provider methods
			const clearTaskSpy = vi.spyOn(provider, "clearTask").mockResolvedValue(undefined)
			const postStateToWebviewSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// Get the message handler
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Trigger clearTask message
			await messageHandler({ type: "clearTask" })

			// When there's no current task, clearTask is still called (it handles the no-task case internally)
			expect(clearTaskSpy).toHaveBeenCalled()
			expect(postStateToWebviewSpy).toHaveBeenCalled()
		})
	})

	test("getState returns correct initial state", async () => {
		const state = await provider.getState()

		expect(state).toHaveProperty("apiConfiguration")
		expect(state.apiConfiguration).toHaveProperty("apiProvider")
		expect(state).toHaveProperty("customInstructions")
		expect(state).toHaveProperty("alwaysAllowReadOnly")
		expect(state).toHaveProperty("alwaysAllowWrite")
		expect(state).toHaveProperty("alwaysAllowExecute")
		expect(state).not.toHaveProperty("taskHistory")
		expect(state).toHaveProperty("soundEnabled")
		expect(state).toHaveProperty("ttsEnabled")
		expect(state).toHaveProperty("writeDelayMs")
	})

	test("getState and getStateToPostToWebview return the complete NanoGPT configuration", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setProviderSettings({
			apiProvider: "nanogpt",
			nanoGptApiKey: "nanogpt-secret",
			nanoGptModelId: "openai/model",
			nanoGptRoutingPreference: "latency",
		})

		const state = await provider.getState()
		const postedState = await provider.getStateToPostToWebview()
		const expectedConfiguration = {
			apiProvider: "nanogpt",
			nanoGptApiKey: "nanogpt-secret",
			nanoGptModelId: "openai/model",
			nanoGptRoutingPreference: "latency",
		}

		expect(state.apiConfiguration).toMatchObject(expectedConfiguration)
		expect(postedState.apiConfiguration).toMatchObject(expectedConfiguration)
	})

	test("getState returns the saved destructive command guard setting", async () => {
		await provider.contextProxy.setValue("destructiveCommandGuardEnabled", true)

		const state = await provider.getState()

		expect(state.destructiveCommandGuardEnabled).toBe(true)
	})

	test("getStateToPostToWebview returns the saved destructive command guard setting", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("destructiveCommandGuardEnabled", true)

		const state = await provider.getStateToPostToWebview()

		expect(state.destructiveCommandGuardEnabled).toBe(true)
	})

	test("getStateToPostToWebview disables destructive command guard by default", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const state = await provider.getStateToPostToWebview()

		expect(state.destructiveCommandGuardEnabled).toBe(false)
	})

	test("new installations default to Simplified Chinese", async () => {
		;(vscode.env as any).language = "pt-BR"

		const state = await provider.getState()
		expect(state.language).toBe("zh-CN")
	})

	test("writeDelayMs defaults to 1000ms", async () => {
		// Mock globalState.get to return undefined for writeDelayMs
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			return key === "writeDelayMs" ? undefined : null
		})

		const state = await provider.getState()
		expect(state.writeDelayMs).toBe(1000)
	})

	test("getState applies fallback defaults for write, diff, and terminal settings", async () => {
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			if (
				[
					"writeDelayMs",
					"diffFuzzyThreshold",
					"terminalShellIntegrationTimeout",
					"terminalShellIntegrationDisabled",
					"terminalCommandDelay",
				].includes(key)
			) {
				return undefined
			}

			return null
		})

		const state = await provider.getState()

		expect(state.writeDelayMs).toBe(DEFAULT_WRITE_DELAY_MS)
		expect(state.diffFuzzyThreshold).toBe(DEFAULT_DIFF_FUZZY_THRESHOLD)
		expect(state.terminalShellIntegrationTimeout).toBe(Terminal.defaultShellIntegrationTimeout)
		expect(state.terminalShellIntegrationDisabled).toBe(true)
		expect(state.terminalCommandDelay).toBe(0)
	})

	test("getState passes through defined write/diff/terminal values instead of defaults", async () => {
		await provider.contextProxy.setValue("writeDelayMs", 500)
		await provider.contextProxy.setValue("diffFuzzyThreshold", 0.5)
		await provider.contextProxy.setValue("terminalShellIntegrationTimeout", 99999)
		await provider.contextProxy.setValue("terminalShellIntegrationDisabled", false)
		await provider.contextProxy.setValue("terminalCommandDelay", 1234)

		const state = await provider.getState()

		expect(state.writeDelayMs).toBe(500)
		expect(state.diffFuzzyThreshold).toBe(0.5)
		expect(state.terminalShellIntegrationTimeout).toBe(99999)
		expect(state.terminalShellIntegrationDisabled).toBe(false)
		expect(state.terminalCommandDelay).toBe(1234)
	})

	test("handles writeDelayMs message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await messageHandler({ type: "updateSettings", updatedSettings: { writeDelayMs: 2000 } })

		expect(updateGlobalStateSpy).toHaveBeenCalledWith("writeDelayMs", 2000)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("writeDelayMs", 2000)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("updates sound utility when sound setting changes", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Get the message handler from onDidReceiveMessage
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Simulate setting sound to enabled
		await messageHandler({ type: "updateSettings", updatedSettings: { soundEnabled: true } })
		expect(updateGlobalStateSpy).toHaveBeenCalledWith("soundEnabled", true)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("soundEnabled", true)
		expect(mockPostMessage).toHaveBeenCalled()

		// Simulate setting sound to disabled
		await messageHandler({ type: "updateSettings", updatedSettings: { soundEnabled: false } })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("soundEnabled", false)
		expect(mockPostMessage).toHaveBeenCalled()

		// Simulate setting tts to enabled
		await messageHandler({ type: "updateSettings", updatedSettings: { ttsEnabled: true } })
		expect(setTtsEnabled).toHaveBeenCalledWith(true)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("ttsEnabled", true)
		expect(mockPostMessage).toHaveBeenCalled()

		// Simulate setting tts to disabled
		await messageHandler({ type: "updateSettings", updatedSettings: { ttsEnabled: false } })
		expect(setTtsEnabled).toHaveBeenCalledWith(false)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("ttsEnabled", false)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("autoCondenseContext defaults to true", async () => {
		// Mock globalState.get to return undefined for autoCondenseContext
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			return key === "autoCondenseContext" ? undefined : null
		})
		const state = await provider.getState()
		expect(state.autoCondenseContext).toBe(true)
	})

	test("handles autoCondenseContext message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
		await messageHandler({ type: "updateSettings", updatedSettings: { autoCondenseContext: false } })
		expect(updateGlobalStateSpy).toHaveBeenCalledWith("autoCondenseContext", false)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("autoCondenseContext", false)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("autoCondenseContextPercent defaults to 100", async () => {
		// Mock globalState.get to return undefined for autoCondenseContextPercent
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			return key === "autoCondenseContextPercent" ? undefined : null
		})

		const state = await provider.getState()
		expect(state.autoCondenseContextPercent).toBe(90)
	})

	test("handles autoCondenseContextPercent message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await messageHandler({ type: "updateSettings", updatedSettings: { autoCondenseContextPercent: 75 } })

		expect(updateGlobalStateSpy).toHaveBeenCalledWith("autoCondenseContextPercent", 75)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("autoCondenseContextPercent", 75)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	describe("auto-close settings are included in posted state", () => {
		it("getStateToPostToWebview returns saved autoCloseOctoCodeOpenedFiles value", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Simulate the updateSettings handler storing the value.
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedFiles", false)
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedFilesAfterUserEdited", true)
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedNewFiles", true)

			const state = await provider.getStateToPostToWebview()

			// The saved values must be present in the state posted to the webview.
			expect(state.autoCloseOctoCodeOpenedFiles).toBe(false)
			expect(state.autoCloseOctoCodeOpenedFilesAfterUserEdited).toBe(true)
			expect(state.autoCloseOctoCodeOpenedNewFiles).toBe(true)
		})

		it("getStateToPostToWebview defaults autoCloseOctoCodeOpenedFiles to false when unset", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Ensure the settings are not set.
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedFiles", undefined)
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedFilesAfterUserEdited", undefined)
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedNewFiles", undefined)

			const state = await provider.getStateToPostToWebview()

			// Unset values should default to their documented defaults (opt-in).
			expect(state.autoCloseOctoCodeOpenedFiles).toBe(false)
			expect(state.autoCloseOctoCodeOpenedFilesAfterUserEdited).toBe(false)
			expect(state.autoCloseOctoCodeOpenedNewFiles).toBe(false)
		})

		it("getState returns saved autoCloseOctoCodeOpenedFiles value for DiffViewProvider", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedFiles", false)
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedFilesAfterUserEdited", true)
			await provider.contextProxy.setValue("autoCloseOctoCodeOpenedNewFiles", true)

			const state = await provider.getState()

			// DiffViewProvider reads from getState(); all three fields must be present
			// so a regression that drops any of them is caught.
			expect(state.autoCloseOctoCodeOpenedFiles).toBe(false)
			expect(state.autoCloseOctoCodeOpenedFilesAfterUserEdited).toBe(true)
			expect(state.autoCloseOctoCodeOpenedNewFiles).toBe(true)
		})
	})

	it("getStateToPostToWebview passes through defined diffFuzzyThreshold value", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("diffFuzzyThreshold", 0.5)

		const state = await provider.getStateToPostToWebview()

		expect(state.diffFuzzyThreshold).toBe(0.5)
	})

	it("loads saved API config when switching modes", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const profile: ProviderSettingsEntry = { name: "test-config", id: "test-id", apiProvider: "anthropic" }

		;(provider as any).providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue("test-id"),
			listConfig: vi.fn().mockResolvedValue([profile]),
			activateProfile: vi.fn().mockResolvedValue(profile),
			setModeConfig: vi.fn(),
			getProfile: vi.fn().mockResolvedValue(profile),
		} as any

		// Switch to architect mode
		await messageHandler({ type: "mode", text: "architect" })

		// Should load the saved config for architect mode
		expect(provider.providerSettingsManager.getModeConfigId).toHaveBeenCalledWith("architect")
		expect(provider.providerSettingsManager.activateProfile).toHaveBeenCalledWith({ name: "test-config" })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "test-config")
	})

	it("saves current config when switching to mode without config", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		;(provider as any).providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			listConfig: vi
				.fn()
				.mockResolvedValue([{ name: "current-config", id: "current-id", apiProvider: "anthropic" }]),
			setModeConfig: vi.fn(),
		} as any

		await provider.setValue("currentApiConfigName", "current-config")

		// Switch to architect mode
		await messageHandler({ type: "mode", text: "architect" })

		// Should save current config as default for architect mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "current-id")
	})

	it("saves config as default for current mode when loading config", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const profile: ProviderSettingsEntry = { apiProvider: "anthropic", id: "new-id", name: "new-config" }

		;(provider as any).providerSettingsManager = {
			activateProfile: vi.fn().mockResolvedValue(profile),
			listConfig: vi.fn().mockResolvedValue([profile]),
			setModeConfig: vi.fn(),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
		} as any

		// First set the mode
		await messageHandler({ type: "mode", text: "architect" })

		// Then load the config
		await messageHandler({ type: "loadApiConfiguration", text: "new-config" })

		// Should save new config as default for architect mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "new-id")
	})

	it("load API configuration by ID works and updates mode config", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const profile: ProviderSettingsEntry = {
			name: "config-by-id",
			id: "config-id-123",
			apiProvider: "anthropic",
		}

		;(provider as any).providerSettingsManager = {
			activateProfile: vi.fn().mockResolvedValue(profile),
			listConfig: vi.fn().mockResolvedValue([profile]),
			setModeConfig: vi.fn(),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
		} as any

		// First set the mode
		await messageHandler({ type: "mode", text: "architect" })

		// Then load the config by ID
		await messageHandler({ type: "loadApiConfigurationById", text: "config-id-123" })

		// Should save new config as default for architect mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "config-id-123")

		// Ensure the `activateProfile` method was called with the correct ID
		expect(provider.providerSettingsManager.activateProfile).toHaveBeenCalledWith({ id: "config-id-123" })
	})

	test("handles showRooIgnoredFiles setting", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Default value should be false
		expect((await provider.getState()).showRooIgnoredFiles).toBe(false)

		// Test showRooIgnoredFiles with true
		await messageHandler({ type: "updateSettings", updatedSettings: { showRooIgnoredFiles: true } })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("showRooIgnoredFiles", true)
		expect(mockPostMessage).toHaveBeenCalled()
		expect((await provider.getState()).showRooIgnoredFiles).toBe(true)

		// Test showRooIgnoredFiles with false
		await messageHandler({ type: "updateSettings", updatedSettings: { showRooIgnoredFiles: false } })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("showRooIgnoredFiles", false)
		expect(mockPostMessage).toHaveBeenCalled()
		expect((await provider.getState()).showRooIgnoredFiles).toBe(false)
	})

	test("handles updatePrompt message correctly", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock existing prompts
		const existingPrompts = {
			code: {
				roleDefinition: "existing code role",
				customInstructions: "existing code prompt",
			},
			architect: {
				roleDefinition: "existing architect role",
				customInstructions: "existing architect prompt",
			},
		}

		await provider.setValue("customModePrompts", existingPrompts)

		// Test updating a prompt
		await messageHandler({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: "new code prompt",
		})

		// Verify state was updated correctly
		expect(mockContext.globalState.update).toHaveBeenCalledWith("customModePrompts", {
			...existingPrompts,
			code: "new code prompt",
		})

		// Verify state was posted to webview
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "state",
				state: expect.objectContaining({
					customModePrompts: {
						...existingPrompts,
						code: "new code prompt",
					},
				}),
			}),
		)
	})

	test("customModePrompts defaults to empty object", async () => {
		// Mock globalState.get to return undefined for customModePrompts
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			if (key === "customModePrompts") {
				return undefined
			}
			return null
		})

		const state = await provider.getState()
		expect(state.customModePrompts).toEqual({})
	})

	test("handles maxWorkspaceFiles message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await messageHandler({ type: "updateSettings", updatedSettings: { maxWorkspaceFiles: 300 } })

		expect(updateGlobalStateSpy).toHaveBeenCalledWith("maxWorkspaceFiles", 300)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("maxWorkspaceFiles", 300)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("handles mode-specific custom instructions updates", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock existing prompts
		const existingPrompts = {
			code: {
				roleDefinition: "Code role",
				customInstructions: "Old instructions",
			},
		}
		mockContext.globalState.get = vi.fn((key: string) => {
			if (key === "customModePrompts") {
				return existingPrompts
			}
			return undefined
		})

		// Update custom instructions for code mode
		await messageHandler({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: {
				roleDefinition: "Code role",
				customInstructions: "New instructions",
			},
		})

		// Verify state was updated correctly
		expect(mockContext.globalState.update).toHaveBeenCalledWith("customModePrompts", {
			code: {
				roleDefinition: "Code role",
				customInstructions: "New instructions",
			},
		})
	})

	it("saves mode config when updating API configuration", async () => {
		// Setup mock context with mode and config name
		mockContext = {
			...mockContext,
			globalState: {
				...mockContext.globalState,
				get: vi.fn((key: string) => {
					if (key === "mode") {
						return "code"
					} else if (key === "currentApiConfigName") {
						return "test-config"
					}
					return undefined
				}),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
		} as unknown as vscode.ExtensionContext

		// Create new provider with updated mock context
		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		;(provider as any).providerSettingsManager = {
			listConfig: vi.fn().mockResolvedValue([{ name: "test-config", id: "test-id", apiProvider: "anthropic" }]),
			saveConfig: vi.fn().mockResolvedValue("test-id"),
			setModeConfig: vi.fn(),
		} as any

		// Update API configuration
		await messageHandler({
			type: "upsertApiConfiguration",
			text: "test-config",
			apiConfiguration: { apiProvider: "anthropic" },
		})

		// Should save config as default for current mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("code", "test-id")
	})

	test("file content includes line numbers", async () => {
		const { extractTextFromFile } = await import("../../../integrations/misc/extract-text")
		const result = await extractTextFromFile("test.js")
		expect(result).toBe("1 | const x = 1;\n2 | const y = 2;\n3 | const z = 3;")
	})

	describe("getSystemPrompt", () => {
		beforeEach(async () => {
			mockPostMessage.mockClear()
			await provider.resolveWebviewView(mockWebviewView)
			// Reset and setup mock
			mockAddCustomInstructions.mockClear()
			mockAddCustomInstructions.mockImplementation(
				(modeInstructions: string, globalInstructions: string, _cwd: string) => {
					return Promise.resolve(modeInstructions || globalInstructions || "")
				},
			)
		})

		const getMessageHandler = () => {
			const mockCalls = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls
			expect(mockCalls.length).toBeGreaterThan(0)
			return mockCalls[0][0]
		}

		test("handles mcpEnabled setting correctly", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const handler = getMessageHandler()
			expect(typeof handler).toBe("function")

			// Test with mcpEnabled: true
			vi.spyOn(provider, "getState").mockResolvedValueOnce({
				apiConfiguration: {
					apiProvider: "openrouter" as const,
				},
				mcpEnabled: true,
				mode: "code" as const,
				experiments: experimentDefault,
			} as any)

			await handler({ type: "getSystemPrompt", mode: "code" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "code",
				}),
			)

			// Reset for second test
			mockPostMessage.mockClear()

			// Test with mcpEnabled: false
			vi.spyOn(provider, "getState").mockResolvedValueOnce({
				apiConfiguration: {
					apiProvider: "openrouter" as const,
				},
				mcpEnabled: false,
				mode: "code" as const,
				experiments: experimentDefault,
			} as any)

			await handler({ type: "getSystemPrompt", mode: "code" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "code",
				}),
			)
		})

		test("uses code mode custom instructions", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock getState to return custom instructions for code mode
			vi.spyOn(provider, "getState").mockResolvedValue({
				apiConfiguration: {
					apiProvider: "openrouter" as const,
				},
				customModePrompts: {
					code: { customInstructions: "Code mode specific instructions" },
				},
				mode: "code" as const,
				experiments: experimentDefault,
			} as any)

			// Trigger getSystemPrompt
			const handler = getMessageHandler()
			await handler({ type: "getSystemPrompt", mode: "code" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "code",
				}),
			)
		})

		test("uses correct mode-specific instructions when mode is specified", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock getState to return architect mode instructions
			vi.spyOn(provider, "getState").mockResolvedValue({
				apiConfiguration: {
					apiProvider: "openrouter",
				},
				customModePrompts: {
					architect: { customInstructions: "Architect mode instructions" },
				},
				mode: "architect",
				mcpEnabled: false,
				experiments: experimentDefault,
			} as any)

			// Trigger getSystemPrompt for architect mode
			const handler = getMessageHandler()
			await handler({ type: "getSystemPrompt", mode: "architect" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "architect",
				}),
			)
		})
	})

	describe("handleModeSwitch", () => {
		beforeEach(async () => {
			// Set up webview for each test
			await provider.resolveWebviewView(mockWebviewView)
		})

		it("loads saved API config when switching modes", async () => {
			const profile: ProviderSettingsEntry = {
				name: "saved-config",
				id: "saved-config-id",
				apiProvider: "anthropic",
			}

			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue("saved-config-id"),
				listConfig: vi.fn().mockResolvedValue([profile]),
				activateProfile: vi.fn().mockResolvedValue(profile),
				setModeConfig: vi.fn(),
				getProfile: vi.fn().mockResolvedValue(profile),
			} as any

			// Switch to architect mode
			await provider.handleModeSwitch("architect")

			// Verify mode was updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "architect")

			// Verify saved config was loaded
			expect(provider.providerSettingsManager.getModeConfigId).toHaveBeenCalledWith("architect")
			expect(provider.providerSettingsManager.activateProfile).toHaveBeenCalledWith({ name: "saved-config" })
			expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "saved-config")

			// Verify state was posted to webview
			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }))
		})

		test("saves current config when switching to mode without config", async () => {
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi
					.fn()
					.mockResolvedValue([{ name: "current-config", id: "current-id", apiProvider: "anthropic" }]),
				setModeConfig: vi.fn(),
			} as any

			// Mock the ContextProxy's getValue method to return the current config name
			const contextProxy = (provider as any).contextProxy
			const getValueSpy = vi.spyOn(contextProxy, "getValue")
			getValueSpy.mockImplementation((key: any) => {
				if (key === "currentApiConfigName") return "current-config"
				return undefined
			})

			// Switch to architect mode
			await provider.handleModeSwitch("architect")

			// Verify mode was updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "architect")

			// Verify current config was saved as default for new mode
			expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "current-id")

			// Verify state was posted to webview
			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }))
		})
	})

	describe("updateCustomMode", () => {
		test("updates both file and state when updating custom mode", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Mock CustomModesManager methods
			;(provider as any).customModesManager = {
				updateCustomMode: vi.fn().mockResolvedValue(undefined),
				getCustomModes: vi.fn().mockResolvedValue([
					{
						slug: "test-mode",
						name: "Test Mode",
						roleDefinition: "Updated role definition",
						groups: ["read"] as const,
					},
				]),
				dispose: vi.fn(),
			} as any

			// Test updating a custom mode
			await messageHandler({
				type: "updateCustomMode",
				modeConfig: {
					slug: "test-mode",
					name: "Test Mode",
					roleDefinition: "Updated role definition",
					groups: ["read"] as const,
				},
			})

			// Verify CustomModesManager.updateCustomMode was called
			expect(provider.customModesManager.updateCustomMode).toHaveBeenCalledWith(
				"test-mode",
				expect.objectContaining({
					slug: "test-mode",
					roleDefinition: "Updated role definition",
				}),
			)

			// Verify state was updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("customModes", [
				{ groups: ["read"], name: "Test Mode", roleDefinition: "Updated role definition", slug: "test-mode" },
			])

			// Verify state was posted to webview
			// Verify state was posted to webview with correct format
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "state",
					state: expect.objectContaining({
						customModes: [
							expect.objectContaining({
								slug: "test-mode",
								roleDefinition: "Updated role definition",
							}),
						],
					}),
				}),
			)
		})
	})

	describe("upsertApiConfiguration", () => {
		test("handles error in upsertApiConfiguration gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn().mockRejectedValue(new Error("Failed to update mode config")),
				listConfig: vi
					.fn()
					.mockResolvedValue([{ name: "test-config", id: "test-id", apiProvider: "anthropic" }]),
			} as any

			// Mock getState to provide necessary data
			vi.spyOn(provider, "getState").mockResolvedValue({
				mode: "code",
				currentApiConfigName: "test-config",
			} as any)

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: { apiProvider: "anthropic", apiKey: "test-key" },
			})

			// Verify error was logged and user was notified
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error create new api configuration"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.create_api_config")
		})

		test("handles successful upsertApiConfiguration", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn(),
				saveConfig: vi.fn().mockResolvedValue(undefined),
				listConfig: vi
					.fn()
					.mockResolvedValue([{ name: "test-config", id: "test-id", apiProvider: "anthropic" }]),
			} as any

			const testApiConfig = {
				apiProvider: "anthropic" as const,
				apiKey: "test-key",
			}

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: testApiConfig,
			})

			// Verify config was saved
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("test-config", testApiConfig)

			// Verify state updates
			expect(mockContext.globalState.update).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: "anthropic" },
			])
			expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "test-config")

			// Verify state was posted to webview
			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }))
		})

		test("handles successful saveApiConfiguration", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn(),
				saveConfig: vi.fn().mockResolvedValue(undefined),
				listConfig: vi
					.fn()
					.mockResolvedValue([{ name: "test-config", id: "test-id", apiProvider: "anthropic" }]),
			} as any

			const testApiConfig = {
				apiProvider: "anthropic" as const,
				apiKey: "test-key",
			}

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "saveApiConfiguration",
				text: "test-config",
				apiConfiguration: testApiConfig,
			})

			// Verify config was saved
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("test-config", testApiConfig)

			// Verify state updates
			expect(mockContext.globalState.update).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: "anthropic" },
			])
			expect(updateGlobalStateSpy).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: "anthropic" },
			])
		})
	})
})

describe("webviewMessageHandler no-floating-promises coverage", () => {
	const createProvider = (overrides: Record<string, unknown> = {}) =>
		Object.assign(
			{
				context: {
					secrets: {
						get: vi.fn().mockResolvedValue(undefined),
					},
				},
				contextProxy: {
					getValue: vi.fn(),
					setValue: vi.fn().mockResolvedValue(undefined),
				},
				postMessageToWebview: vi.fn().mockResolvedValue(true),
				postStateToWebview: vi.fn().mockResolvedValue(undefined),
				getCurrentTask: vi.fn(),
				getCurrentWorkspaceCodeIndexManager: vi.fn(),
				getMcpHub: vi.fn().mockReturnValue({
					getMcpSettingsFilePath: vi.fn().mockResolvedValue("/test/mcp.json"),
				}),
				providerSettingsManager: {
					listConfig: vi.fn().mockResolvedValue([]),
				},
				customModesManager: {
					getCustomModesFilePath: vi.fn().mockResolvedValue("/test/custom-modes.yaml"),
					exportModeWithRules: vi.fn(),
					importModeWithRules: vi.fn(),
					getCustomModes: vi.fn().mockResolvedValue([]),
					checkRulesDirectoryHasContent: vi.fn().mockResolvedValue(true),
				},
				exportTaskWithId: vi.fn().mockResolvedValue(undefined),
				showTaskWithId: vi.fn().mockResolvedValue(undefined),
				condenseTaskContext: vi.fn().mockResolvedValue(undefined),
				deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
				log: vi.fn(),
				cwd: "/test/workspace",
			},
			overrides,
		) as unknown as ClineProvider

	const createIndexManager = (overrides: Record<string, unknown> = {}) =>
		Object.assign(
			{
				setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
				setAutoEnableDefault: vi.fn().mockResolvedValue(undefined),
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				isWorkspaceEnabled: true,
				initialize: vi.fn().mockResolvedValue(undefined),
				state: "Standby",
				isInitialized: true,
				startIndexing: vi.fn().mockResolvedValue(undefined),
				stopIndexing: vi.fn(),
				clearIndexData: vi.fn().mockResolvedValue(undefined),
				getCurrentStatus: vi.fn().mockReturnValue({ systemStatus: "Standby" }),
			},
			overrides,
		)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("logs a detached indexing rejection without rejecting the handler", async () => {
		let rejectIndexing!: (error: Error) => void
		const indexingPromise = new Promise<void>((_, reject) => {
			rejectIndexing = reject
		})
		const manager = createIndexManager({
			startIndexing: vi.fn().mockReturnValue(indexingPromise),
		})
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexManager: vi.fn().mockReturnValue(manager),
		})

		await expect(webviewMessageHandler(provider, { type: "startIndexing" })).resolves.toBeUndefined()
		expect(manager.startIndexing).toHaveBeenCalledOnce()

		rejectIndexing(new Error("boom"))
		await Promise.resolve()
		await Promise.resolve()

		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: boom")
	})

	it("covers changed file, image, mention, settings, and TTS dispatch paths", async () => {
		const { openFile } = await import("../../../integrations/misc/open-file")
		const { openImage, saveImage } = await import("../../../integrations/misc/image-handler")
		const { openMention } = await import("../../mentions")
		const { playTts } = await import("../../../utils/tts")
		const provider = createProvider()

		await webviewMessageHandler(provider, { type: "openImage", text: "/test/image.png" })
		await webviewMessageHandler(provider, { type: "saveImage", dataUri: "invalid" })
		await webviewMessageHandler(provider, { type: "openFile", text: "/test/file.ts" })
		await webviewMessageHandler(provider, { type: "openMention", text: "file.ts" })
		await webviewMessageHandler(provider, { type: "openCustomModesSettings" })
		await webviewMessageHandler(provider, { type: "openMcpSettings" })
		await webviewMessageHandler(provider, { type: "playTts", text: "hello" })

		expect(openImage).toHaveBeenCalledWith("/test/image.png", { values: undefined })
		expect(saveImage).toHaveBeenCalledOnce()
		expect(openFile).toHaveBeenCalledTimes(3)
		expect(openMention).toHaveBeenCalledWith("/test/workspace", "file.ts")
		expect(playTts).toHaveBeenCalledOnce()
	})

	it("covers changed configuration and rules response paths", async () => {
		const provider = createProvider()

		await webviewMessageHandler(provider, { type: "getListApiConfiguration" })
		await webviewMessageHandler(provider, { type: "checkRulesDirectory", slug: "mode-1" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "listApiConfig", listApiConfig: [] })
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "checkRulesDirectoryResult",
			slug: "mode-1",
			hasContent: true,
		})
	})

	it("covers all changed export-mode response paths", async () => {
		const provider = createProvider()
		const exportModeWithRules = provider.customModesManager.exportModeWithRules as ReturnType<typeof vi.fn>
		const showSaveDialog = vi.mocked(vscode.window.showSaveDialog)

		exportModeWithRules.mockResolvedValueOnce({ success: true, yaml: "mode: one" })
		showSaveDialog.mockResolvedValueOnce({ fsPath: "/test/mode.yaml" } as vscode.Uri)
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		exportModeWithRules.mockResolvedValueOnce({ success: true, yaml: "mode: one" })
		showSaveDialog.mockResolvedValueOnce(undefined)
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		exportModeWithRules.mockResolvedValueOnce({ success: false, error: "invalid mode" })
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		exportModeWithRules.mockRejectedValueOnce(new Error("export failed"))
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", success: true }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", error: "Export cancelled" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", error: "invalid mode" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", error: "export failed" }),
		)
	})

	it("covers all changed import-mode response paths", async () => {
		const provider = createProvider()
		const importModeWithRules = provider.customModesManager.importModeWithRules as ReturnType<typeof vi.fn>
		const showOpenDialog = vi.mocked(vscode.window.showOpenDialog)
		const selectedFile = [{ fsPath: "/test/mode.yaml" } as vscode.Uri]

		showOpenDialog.mockResolvedValueOnce(selectedFile)
		importModeWithRules.mockResolvedValueOnce({ success: true, slug: "mode-1" })
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		showOpenDialog.mockResolvedValueOnce(selectedFile)
		importModeWithRules.mockResolvedValueOnce({ success: false, error: "invalid mode" })
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		showOpenDialog.mockResolvedValueOnce(undefined)
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		showOpenDialog.mockRejectedValueOnce(new Error("dialog failed"))
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", success: true }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", error: "invalid mode" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", error: "cancelled" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", error: "dialog failed" }),
		)
	})

	it("covers changed cloud sign-out and rate-limit error responses", async () => {
		const { CloudService } = await import("@roo-code/cloud")
		const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
		const provider = createProvider()

		vi.mocked(CloudService.hasInstance).mockReturnValueOnce(false)
		await webviewMessageHandler(provider, { type: "rooCloudSignOut" })
		await webviewMessageHandler(provider, { type: "rooCloudSignOut" })

		vi.mocked(openAiCodexOAuthManager.getAccessToken).mockRejectedValueOnce(new Error("token failed"))
		await webviewMessageHandler(provider, { type: "requestOpenAiCodexRateLimits" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiCodexRateLimits",
			error: "token failed",
		})
	})

	it("covers changed indexing status, secret, and missing-manager responses", async () => {
		const manager = createIndexManager()
		const getManager = vi.fn().mockReturnValueOnce(undefined).mockReturnValue(manager)
		const provider = createProvider({ getCurrentWorkspaceCodeIndexManager: getManager })

		await webviewMessageHandler(provider, { type: "requestIndexingStatus" })
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: expect.objectContaining({
				systemStatus: "Standby",
				message: "orchestrator.indexingRequiresWorkspace",
			}),
		})
		await webviewMessageHandler(provider, { type: "requestIndexingStatus" })
		await webviewMessageHandler(provider, { type: "requestCodeIndexSecretStatus" })
		getManager.mockReturnValueOnce(undefined)
		await webviewMessageHandler(provider, { type: "startIndexing" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "codeIndexSecretStatus" }),
		)
		expect(provider.log).toHaveBeenCalledWith("Cannot start indexing: No workspace folder open")
	})

	it("catches both start-indexing calls during error recovery", async () => {
		const manager = createIndexManager({
			isInitialized: false,
			startIndexing: vi
				.fn()
				.mockRejectedValueOnce(new Error("first failure"))
				.mockRejectedValueOnce(new Error("second failure")),
		})
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexManager: vi.fn().mockReturnValue(manager),
		})

		await webviewMessageHandler(provider, { type: "startIndexing" })
		await Promise.resolve()

		expect(manager.startIndexing).toHaveBeenCalledTimes(2)
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: first failure")
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: second failure")
	})

	it("covers changed stop, toggle, and detached toggle rejection paths", async () => {
		const manager = createIndexManager({
			startIndexing: vi.fn().mockRejectedValue(new Error("toggle failure")),
		})
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexManager: vi.fn().mockReturnValue(manager),
		})

		await webviewMessageHandler(provider, { type: "stopIndexing" })
		await webviewMessageHandler(provider, { type: "toggleWorkspaceIndexing", bool: true })
		await Promise.resolve()

		expect(manager.stopIndexing).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: toggle failure")
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "indexingStatusUpdate" }),
		)
	})

	it("catches auto-enabled indexing failures and posts the resulting status", async () => {
		const { CodeIndexManager } = await import("../../../services/code-index/manager")
		let workspaceEnabled = false
		const manager = createIndexManager({
			setAutoEnableDefault: vi.fn().mockImplementation(async () => {
				workspaceEnabled = true
			}),
			startIndexing: vi.fn().mockRejectedValue(new Error("auto-enable failure")),
		})
		Object.defineProperty(manager, "isWorkspaceEnabled", { get: () => workspaceEnabled })
		const getAllInstances = vi
			.spyOn(CodeIndexManager, "getAllInstances")
			.mockReturnValue([manager] as unknown as ReturnType<typeof CodeIndexManager.getAllInstances>)
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexManager: vi.fn().mockReturnValue(manager),
		})

		try {
			await webviewMessageHandler(provider, { type: "setAutoEnableDefault", bool: true })
			await Promise.resolve()

			expect(manager.startIndexing).toHaveBeenCalledOnce()
			expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: auto-enable failure")
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ type: "indexingStatusUpdate" }),
			)
		} finally {
			getAllInstances.mockRestore()
		}
	})

	it("covers changed clear-index response paths", async () => {
		const manager = createIndexManager()
		const getManager = vi.fn().mockReturnValueOnce(undefined).mockReturnValue(manager)
		const provider = createProvider({ getCurrentWorkspaceCodeIndexManager: getManager })

		await webviewMessageHandler(provider, { type: "clearIndexData" })
		await webviewMessageHandler(provider, { type: "clearIndexData" })
		manager.clearIndexData.mockRejectedValueOnce(new Error("clear failed"))
		await webviewMessageHandler(provider, { type: "clearIndexData" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: true },
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: false, error: "clear failed" },
		})
	})

	it("covers changed marketplace error and removal responses", async () => {
		const provider = createProvider()
		const item = {
			id: "item-1",
			name: "Item 1",
			description: "Test marketplace item",
			type: "mode",
			content: "slug: item-1",
		} satisfies NonNullable<WebviewMessage["mpItem"]>
		const options = { target: "project" } satisfies NonNullable<WebviewMessage["mpInstallOptions"]>
		const marketplaceManager = {
			installMarketplaceItem: vi.fn().mockRejectedValue(new Error("install failed")),
			removeInstalledMarketplaceItem: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("remove failed")),
		}
		const managerArgument = marketplaceManager as unknown as NonNullable<
			Parameters<typeof webviewMessageHandler>[2]
		>

		await webviewMessageHandler(
			provider,
			{ type: "installMarketplaceItem", mpItem: item, mpInstallOptions: options },
			managerArgument,
		)
		await webviewMessageHandler(
			provider,
			{ type: "removeInstalledMarketplaceItem", mpItem: item, mpInstallOptions: options },
			managerArgument,
		)
		await webviewMessageHandler(
			provider,
			{ type: "removeInstalledMarketplaceItem", mpItem: item, mpInstallOptions: options },
			managerArgument,
		)
		await webviewMessageHandler(provider, {
			type: "removeInstalledMarketplaceItem",
			mpItem: item,
			mpInstallOptions: options,
		})

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceInstallResult", success: false }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceRemoveResult", success: true }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceRemoveResult", error: "remove failed" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceRemoveResult", error: "Marketplace manager is not available" }),
		)
	})

	it("shows an installed marketplace config in the artifact pane", async () => {
		const showArtifact = vi.fn().mockResolvedValue(undefined)
		const provider = createProvider({ showArtifact })
		const item = {
			id: "item-1",
			name: "Item 1",
			description: "Test marketplace item",
			type: "mcp",
			url: "https://example.com/item-1",
			content: '{"command":"node"}',
		} satisfies NonNullable<WebviewMessage["mpItem"]>
		const marketplaceManager = {
			installMarketplaceItem: vi.fn().mockResolvedValue("/test/mcp.json"),
		} as unknown as NonNullable<Parameters<typeof webviewMessageHandler>[2]>

		await webviewMessageHandler(
			provider,
			{ type: "installMarketplaceItem", mpItem: item, mpInstallOptions: { target: "global" } },
			marketplaceManager,
		)

		expect(showArtifact).toHaveBeenCalledWith("/test/mcp.json")
	})
})

describe("Project MCP Settings", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any

	beforeEach(async () => {
		vi.clearAllMocks()
		const pathUtils = await import("../../../utils/path")
		vi.mocked(pathUtils.getWorkspacePath).mockReturnValue("")

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn(),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn(),
				store: vi.fn(),
				delete: vi.fn(),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()
		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn(),
			onDidChangeVisibility: vi.fn(),
		}
		;(vscode.window as any).activeTextEditor = undefined
		;(vscode.workspace.getWorkspaceFolder as any).mockReset()
		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
	})

	test("handles openProjectMcpSettings message", async () => {
		// Mock workspace folders first
		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/test/workspace" } }]
		const pathUtils = await import("../../../utils/path")
		vi.mocked(pathUtils.getWorkspacePath).mockReturnValue("/test/workspace")

		// Mock fs functions
		const fs = await import("fs/promises")
		const mockedFs = vi.mocked(fs)
		mockedFs.mkdir.mockClear()
		mockedFs.mkdir.mockResolvedValue(undefined)
		mockedFs.writeFile.mockClear()
		mockedFs.writeFile.mockResolvedValue(undefined)

		// Mock fileExistsAtPath to return false (file doesn't exist)
		const fsUtils = await import("../../../utils/fs")
		vi.spyOn(fsUtils, "fileExistsAtPath").mockResolvedValue(false)

		// Mock openFile
		const openFileModule = await import("../../../integrations/misc/open-file")
		const openFileSpy = vi.spyOn(openFileModule, "openFile").mockClear().mockResolvedValue(undefined)

		// Set up the webview
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Ensure the message handler is properly set up
		expect(messageHandler).toBeDefined()
		expect(typeof messageHandler).toBe("function")

		// Trigger openProjectMcpSettings through the message handler
		await messageHandler({
			type: "openProjectMcpSettings",
		})

		const expectedRooDir = path.join("/test/workspace", ".roo")
		const expectedMcpPath = path.join(expectedRooDir, "mcp.json")

		// Check that fs.mkdir was called with the correct path
		expect(mockedFs.mkdir).toHaveBeenCalledWith(expectedRooDir, { recursive: true })
		expect(pathUtils.getWorkspacePath).toHaveBeenCalled()

		// Verify file was created with default content
		expect(safeWriteJson).toHaveBeenCalledWith(expectedMcpPath, { mcpServers: {} }, { prettyPrint: true })

		// Check that openFile was called
		expect(openFileSpy).toHaveBeenCalledWith(expectedMcpPath)
	})

	test("handles openProjectMcpSettings when workspace is not open", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock no workspace folders
		;(vscode.workspace as any).workspaceFolders = []

		// Trigger openProjectMcpSettings
		await messageHandler({ type: "openProjectMcpSettings" })

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.no_workspace")
	})

	test("handles openProjectMcpSettings file creation error", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock workspace folders
		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/test/workspace" } }]
		const pathUtils = await import("../../../utils/path")
		vi.mocked(pathUtils.getWorkspacePath).mockReturnValue("/test/workspace")

		// Mock fs functions to fail
		const fs = await import("fs/promises")
		const mockedFs = vi.mocked(fs)
		mockedFs.mkdir.mockRejectedValue(new Error("Failed to create directory"))

		// Trigger openProjectMcpSettings
		await messageHandler({
			type: "openProjectMcpSettings",
		})

		// Verify the translated error key is surfaced in test mode
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.create_json")
	})
})

describe("getTelemetryProperties", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Initialize TelemetryService if not already initialized
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		// Setup basic mocks
		mockContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "mode") return "code"
					if (key === "apiProvider") return "anthropic"
					return undefined
				}),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalStorageUri: { fsPath: "/test/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
	})

	test("includes basic properties in telemetry", async () => {
		const properties = await provider.getTelemetryProperties()

		expect(properties).toHaveProperty("vscodeVersion")
		expect(properties).toHaveProperty("platform")
		expect(properties).toHaveProperty("appVersion", "1.0.0")
	})

	describe("cloud authentication telemetry", () => {
		beforeEach(() => {
			// Reset all mocks before each test
			vi.clearAllMocks()
		})

		test("includes cloud authentication property when user is authenticated", async () => {
			// Import the CloudService mock and update it
			const { CloudService } = await import("@roo-code/cloud")
			const mockCloudService = {
				isAuthenticated: vi.fn().mockReturnValue(true),
			}

			// Update the existing mock
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockReturnValue(mockCloudService),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			expect(properties).toHaveProperty("cloudIsAuthenticated", true)
		})

		test("includes cloud authentication property when user is not authenticated", async () => {
			// Import the CloudService mock and update it
			const { CloudService } = await import("@roo-code/cloud")
			const mockCloudService = {
				isAuthenticated: vi.fn().mockReturnValue(false),
			}

			// Update the existing mock
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockReturnValue(mockCloudService),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			expect(properties).toHaveProperty("cloudIsAuthenticated", false)
		})

		test("handles CloudService errors gracefully", async () => {
			// Import the CloudService mock and update it to throw an error
			const { CloudService } = await import("@roo-code/cloud")
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockImplementation(() => {
					throw new Error("CloudService not available")
				}),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			// Should still include basic telemetry properties
			expect(properties).toHaveProperty("vscodeVersion")
			expect(properties).toHaveProperty("platform")
			expect(properties).toHaveProperty("appVersion", "1.0.0")

			// Cloud property should be undefined when CloudService is not available
			expect(properties).toHaveProperty("cloudIsAuthenticated", undefined)
		})

		test("handles CloudService method errors gracefully", async () => {
			// Import the CloudService mock and update it
			const { CloudService } = await import("@roo-code/cloud")
			const mockCloudService = {
				isAuthenticated: vi.fn().mockImplementation(() => {
					throw new Error("Authentication check error")
				}),
			}

			// Update the existing mock
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockReturnValue(mockCloudService),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			// Should still include basic telemetry properties
			expect(properties).toHaveProperty("vscodeVersion")
			expect(properties).toHaveProperty("platform")
			expect(properties).toHaveProperty("appVersion", "1.0.0")

			// Property that errored should be undefined
			expect(properties).toHaveProperty("cloudIsAuthenticated", undefined)
		})
	})
})

describe("ClineProvider - Router Models", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any

	beforeEach(() => {
		vi.clearAllMocks()

		const globalState: Record<string, string | undefined> = {}
		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value)
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					return delete secrets[key]
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()
		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation((callback) => {
				callback()
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		}

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
	})

	test("handles requestRouterModels with successful responses", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock getState to return API configuration
		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				litellmApiKey: "litellm-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		} as any)

		const mockModels = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				description: "Test model 1",
				supportsPromptCache: false,
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				description: "Test model 2",
				supportsPromptCache: false,
			},
		}

		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({ type: "requestRouterModels" })

		// Verify getModels was called for each provider with correct options
		expect(getModels).toHaveBeenCalledWith({ provider: "openrouter" })
		expect(getModels).toHaveBeenCalledWith({ provider: "requesty", apiKey: "requesty-key" })
		expect(getModels).toHaveBeenCalledWith({ provider: "unbound" })
		expect(getModels).toHaveBeenCalledWith({ provider: "vercel-ai-gateway" })
		expect(getModels).toHaveBeenCalledWith({
			provider: "litellm",
			apiKey: "litellm-key",
			baseUrl: "http://localhost:4000",
		})
		// Opencode Go's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(getModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "opencode-go" }))
		// Kenari's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(getModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "kenari" }))
		// NanoGPT's detailed catalog is public and may be scoped by an optional key.
		expect(getModels).toHaveBeenCalledWith({ provider: "nanogpt", apiKey: undefined })

		// Verify response was sent
		expect(mockPostMessage).toHaveBeenCalledWith({
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

	test("handles requestRouterModels with individual provider failures", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				litellmApiKey: "litellm-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")

		// Mock some providers to succeed and others to fail
		vi.mocked(getModels)
			.mockResolvedValueOnce(mockModels) // openrouter success
			.mockRejectedValueOnce(new Error("Requesty API error")) // requesty fail
			.mockResolvedValueOnce(mockModels) // unbound success
			.mockResolvedValueOnce(mockModels) // vercel-ai-gateway success
			.mockResolvedValueOnce(mockModels) // octocode-gateway success
			.mockRejectedValueOnce(new Error("LiteLLM connection failed")) // litellm fail
			.mockResolvedValueOnce(mockModels) // opencode-go (public endpoint)
			.mockResolvedValueOnce(mockModels) // kenari (public endpoint)
			.mockResolvedValueOnce(mockModels) // nanogpt (public endpoint)

		await messageHandler({ type: "requestRouterModels" })

		// Verify main response includes successful providers and empty objects for failed ones
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: {},
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"octocode-gateway": mockModels,
				ollama: {},
				lmstudio: {},
				litellm: {},
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

		// Verify error messages were sent for failed providers
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Requesty API error",
			values: { provider: "requesty" },
		})

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "LiteLLM connection failed",
			values: { provider: "litellm" },
		})
	})

	test("handles requestRouterModels with LiteLLM values from message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock state without LiteLLM config
		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// No litellm config
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({
			type: "requestRouterModels",
			values: {
				litellmApiKey: "message-litellm-key",
				litellmBaseUrl: "http://message-url:4000",
			},
		})

		// Verify LiteLLM was called with values from message
		expect(getModels).toHaveBeenCalledWith({
			provider: "litellm",
			apiKey: "message-litellm-key",
			baseUrl: "http://message-url:4000",
		})
	})

	test("skips LiteLLM when neither config nor message values are provided", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// No litellm config
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({ type: "requestRouterModels" })

		// Verify LiteLLM was NOT called
		expect(getModels).not.toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "litellm",
			}),
		)

		// Verify response includes empty object for LiteLLM
		expect(mockPostMessage).toHaveBeenCalledWith({
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

	test("handles requestLmStudioModels with proper response", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				lmStudioModelId: "model-1",
				lmStudioBaseUrl: "http://localhost:1234",
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({
			type: "requestLmStudioModels",
		})

		expect(getModels).toHaveBeenCalledWith({
			provider: "lmstudio",
			baseUrl: "http://localhost:1234",
		})
	})
})

describe("ClineProvider - Comprehensive Edit/Delete Edge Cases", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "code",
			currentApiConfigName: "current-config",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value)
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					return delete secrets[key]
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation((callback) => {
				callback()
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		}

		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		// Mock getMcpHub method
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	describe("Edit Permissions and Authorization", () => {
		beforeEach(async () => {
			;(vscode.window.showInformationMessage as any) = vi.fn()
			await provider.resolveWebviewView(mockWebviewView)
		})

		describe("Malformed Requests and Invalid Formats", () => {
			beforeEach(async () => {
				await provider.resolveWebviewView(mockWebviewView)
			})

			test("handles malformed edit requests", async () => {
				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Test with missing value
				await messageHandler({
					type: "submitEditedMessage",
					editedMessageContent: "Edited message",
				})

				// Test with invalid value type
				await messageHandler({
					type: "submitEditedMessage",
					value: "invalid",
					editedMessageContent: "Edited message",
				})

				// Test with missing editedMessageContent
				await messageHandler({
					type: "submitEditedMessage",
					value: 2000,
				})

				// Should not show confirmation dialog for malformed requests
				expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			})

			test("handles invalid message formats", async () => {
				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Test with null message - should throw error
				await expect(messageHandler(null)).rejects.toThrow()

				// Test with undefined message - should throw error
				await expect(messageHandler(undefined)).rejects.toThrow()

				// Test with message missing type
				await expect(
					messageHandler({
						value: 2000,
						editedMessageContent: "Edited message",
					}),
				).resolves.toBeUndefined()

				// Should handle gracefully without errors
				expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			})
		})
	})

	describe("OctoCode auth profile sync", () => {
		beforeEach(async () => {
			const { getCachedOctoCodeToken } = await import("../../../services/octocode-auth")
			vi.mocked(getCachedOctoCodeToken).mockReturnValue("")
		})

		describe("handleOctoCodeCallback", () => {
			it("creates a OctoCode Gateway profile when none exists", async () => {
				vi.spyOn(provider, "getState").mockResolvedValue({
					apiConfiguration: { octoCodeGatewayModelId: "anthropic/claude-sonnet-4" },
				} as any)
				vi.spyOn(provider.contextProxy, "getProviderSettings").mockReturnValue({
					apiProvider: "anthropic",
				} as any)
				vi.spyOn(provider.contextProxy, "getValues").mockReturnValue({
					currentApiConfigName: "Anthropic",
				} as any)
				const upsertSpy = vi.spyOn(provider, "upsertProviderProfile").mockResolvedValue("profile-id")
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn().mockResolvedValue([]),
				}

				await provider.handleOctoCodeCallback("octo_ext_token")

				expect(postMessageSpy).toHaveBeenCalledWith({ type: "octoCodeGatewayCredentialsReady" })
				expect(upsertSpy).toHaveBeenCalledWith(
					"OctoCode Gateway",
					expect.objectContaining({
						apiProvider: "octocode-gateway",
						octoCodeSessionToken: "octo_ext_token",
						octoCodeGatewayBaseUrl: "https://www.octocode.dev/api/gateway/v1",
					}),
					false,
				)
			})

			it("updates every octocode-gateway profile and activates only the active one", async () => {
				vi.spyOn(provider, "getState").mockResolvedValue({
					apiConfiguration: { octoCodeGatewayModelId: "anthropic/claude-sonnet-4" },
				} as any)
				vi.spyOn(provider.contextProxy, "getProviderSettings").mockReturnValue({
					apiProvider: "octocode-gateway",
				} as any)
				vi.spyOn(provider.contextProxy, "getValues").mockReturnValue({
					currentApiConfigName: "OctoCode Gateway",
				} as any)
				const upsertSpy = vi.spyOn(provider, "upsertProviderProfile").mockResolvedValue("profile-id")
				const saveConfig = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn().mockResolvedValue([
						{ name: "OctoCode Gateway", apiProvider: "octocode-gateway" },
						{ name: "Backup OctoCode", apiProvider: "octocode-gateway" },
					]),
					getProfile: vi
						.fn()
						.mockResolvedValueOnce({
							apiProvider: "octocode-gateway",
							octoCodeSessionToken: "old-token",
							octoCodeGatewayBaseUrl: "https://old.example/api/gateway/v1",
						})
						.mockResolvedValueOnce({
							apiProvider: "octocode-gateway",
							octoCodeSessionToken: "old-token",
						}),
					saveConfig,
				}

				await provider.handleOctoCodeCallback("new-token")

				expect(upsertSpy).toHaveBeenCalledWith(
					"OctoCode Gateway",
					expect.objectContaining({
						octoCodeSessionToken: "new-token",
						octoCodeGatewayBaseUrl: "https://www.octocode.dev/api/gateway/v1",
					}),
					true,
				)
				expect(saveConfig).toHaveBeenCalledWith(
					"Backup OctoCode",
					expect.objectContaining({
						octoCodeSessionToken: "new-token",
						octoCodeGatewayBaseUrl: "https://www.octocode.dev/api/gateway/v1",
					}),
				)
			})

			it("logs and posts state when profile persistence fails", async () => {
				vi.spyOn(provider, "getState").mockRejectedValue(new Error("state unavailable"))
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn().mockResolvedValue([]),
				}

				await provider.handleOctoCodeCallback("octo_ext_token")

				expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
					expect.stringContaining("[handleOctoCodeCallback] Failed to save octocode-gateway profile"),
				)
				// State must still be refreshed even when profile persistence fails.
				expect(provider.postStateToWebview).toHaveBeenCalled()
			})
		})

		describe("ensureOctoCodeGatewayProfileSeeded", () => {
			it("does nothing when no cached auth token exists", async () => {
				const handleSpy = vi.spyOn(provider, "handleOctoCodeCallback").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn(),
				}

				await (provider as any).ensureOctoCodeGatewayProfileSeeded()

				expect(handleSpy).not.toHaveBeenCalled()
			})

			it("skips seeding when every octocode-gateway profile already has the current token and base URL", async () => {
				const { getCachedOctoCodeToken } = await import("../../../services/octocode-auth")
				vi.mocked(getCachedOctoCodeToken).mockReturnValue("current-token")
				const handleSpy = vi.spyOn(provider, "handleOctoCodeCallback").mockResolvedValue(undefined)
				const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi
						.fn()
						.mockResolvedValue([{ name: "OctoCode Gateway", apiProvider: "octocode-gateway" }]),
					getProfile: vi.fn().mockResolvedValue({
						octoCodeSessionToken: "current-token",
						octoCodeGatewayBaseUrl: "https://www.octocode.dev/api/gateway/v1",
					}),
				}

				await (provider as any).ensureOctoCodeGatewayProfileSeeded()

				expect(handleSpy).not.toHaveBeenCalled()
				expect(postMessageSpy).toHaveBeenCalledWith({ type: "octoCodeGatewayCredentialsReady" })
			})

			it("re-seeds when any octocode-gateway profile has a stale or missing token", async () => {
				const { getCachedOctoCodeToken } = await import("../../../services/octocode-auth")
				vi.mocked(getCachedOctoCodeToken).mockReturnValue("fresh-token")
				const handleSpy = vi.spyOn(provider, "handleOctoCodeCallback").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi
						.fn()
						.mockResolvedValue([{ name: "OctoCode Gateway", apiProvider: "octocode-gateway" }]),
					getProfile: vi.fn().mockResolvedValue({
						octoCodeSessionToken: "stale-token",
						octoCodeGatewayBaseUrl: "https://www.octocode.dev/api/gateway/v1",
					}),
				}

				await (provider as any).ensureOctoCodeGatewayProfileSeeded()

				expect(handleSpy).toHaveBeenCalledWith("fresh-token")
			})

			it("re-seeds when any octocode-gateway profile has a stale base URL", async () => {
				const { getCachedOctoCodeToken } = await import("../../../services/octocode-auth")
				vi.mocked(getCachedOctoCodeToken).mockReturnValue("current-token")
				const handleSpy = vi.spyOn(provider, "handleOctoCodeCallback").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi
						.fn()
						.mockResolvedValue([{ name: "OctoCode Gateway", apiProvider: "octocode-gateway" }]),
					getProfile: vi.fn().mockResolvedValue({
						octoCodeSessionToken: "current-token",
						octoCodeGatewayBaseUrl: "https://staging.octocode.dev/api/gateway/v1",
					}),
				}

				await (provider as any).ensureOctoCodeGatewayProfileSeeded()

				expect(handleSpy).toHaveBeenCalledWith("current-token")
			})
		})
	})
})
