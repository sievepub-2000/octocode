import type { Mock } from "vitest"
import * as vscode from "vscode"
import { ContextProxy } from "../../core/config/ContextProxy"
import { ClineProvider } from "../../core/webview/ClineProvider"

import {
	getVisibleProviderOrLog,
	openClineInNewTab,
	registerCommands,
	resetWorkbenchState,
	setPanel,
} from "../registerCommands"
import { runtimeEventTerminal } from "../runtimeEventTerminal"

// Shell mode is off for these suites: they assert the host-editor-group layout.
const shellModeForTest = vi.hoisted(() => ({ value: false }))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	ConfigurationTarget: { Global: 1 },
	Uri: {
		joinPath: vi.fn((_base: unknown, ..._pathSegments: string[]) => ({ path: _pathSegments.join("/") })),
	},
	ViewColumn: {
		One: 1,
		Two: 2,
		Three: 3,
	},
	// The execution terminal is hosted in the third editor group.
	TerminalLocation: {
		Editor: 0,
		Panel: 1,
	},
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		createTerminal: vi.fn().mockReturnValue({ dispose: vi.fn(), show: vi.fn() }),
		createWebviewPanel: vi.fn(),
		registerWebviewPanelSerializer: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		tabGroups: { all: [], close: vi.fn().mockResolvedValue(true) },
		visibleTextEditors: [],
	},
	workspace: {
		getConfiguration: vi.fn((section?: string) => ({
			get: vi.fn((key?: string) =>
				section === "octocode.shell" && key === "ownWindowChrome"
					? shellModeForTest.value
					: key !== "closeEmptyGroups",
			),
			update: vi.fn().mockResolvedValue(undefined),
		})),
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
	},
	commands: {
		registerCommand: vi.fn(),
		executeCommand: vi.fn(),
	},
}))

vi.mock("../../core/webview/ClineProvider")

vi.mock("../../shared/package", () => ({
	Package: {
		name: "octocode",
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTitleButtonClicked: vi.fn(),
		},
	},
}))

vi.mock("../../utils/focusPanel", () => ({
	focusPanel: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../handleTask", () => ({
	handleNewTask: vi.fn(),
}))

vi.mock("../../core/config/importExport", () => ({
	importSettingsWithFeedback: vi.fn(),
}))

vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../services/mdm/MdmService", () => ({
	MdmService: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../services/ripgrep/diagnostic", () => ({
	registerRipgrepDiagnosticCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
}))

describe("getVisibleProviderOrLog", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		vi.clearAllMocks()
	})

	it("returns the visible provider if found", () => {
		const mockProvider = {} as ClineProvider
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockProvider)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBe(mockProvider)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})

	it("logs and returns undefined if no provider found", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBeUndefined()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible OctoCode instances.")
	})
})

describe("registerCommands handlers", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockContext: vscode.ExtensionContext
	let mockVisibleProvider: { postMessageToWebview: Mock }
	let mockProvider: { postMessageToWebview: Mock }
	let handlers: Record<string, (...args: unknown[]) => unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		resetWorkbenchState()
		;(vscode.window.tabGroups as unknown as { all: vscode.TabGroup[] }).all = []
		handlers = {}

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}

		mockContext = {
			subscriptions: [],
			extensionUri: { path: "/mock/ext" },
		} as unknown as vscode.ExtensionContext

		mockVisibleProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}

		mockProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockVisibleProvider)
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				handlers[id] = cb
				return { dispose: vi.fn() }
			},
		)

		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: mockProvider as unknown as ClineProvider,
		})
	})

	afterEach(() => {
		// Reset module-level panel state to prevent leakage between tests.
		setPanel(undefined, "sidebar")
		setPanel(undefined, "tab")
	})

	it("registers the ripgrep diagnostic command and stores its disposable in context.subscriptions", async () => {
		const { registerRipgrepDiagnosticCommand } = await import("../../services/ripgrep/diagnostic")
		const mock = vi.mocked(registerRipgrepDiagnosticCommand)
		const disposable = mock.mock.results[0]?.value
		expect(mock).toHaveBeenCalled()
		expect(mockContext.subscriptions).toContain(disposable)
	})

	it("migrates the old preserved-empty-group setting so closing panes releases their space", () => {
		const settings = (vscode.workspace.getConfiguration as Mock).mock.results.at(-1)!.value
		expect(vscode.workspace.getConfiguration).toHaveBeenLastCalledWith("workbench.editor")
		expect(settings.update).toHaveBeenCalledWith("closeEmptyGroups", true, vscode.ConfigurationTarget.Global)
	})

	it("registers serializers for chat and artifact panels", () => {
		expect(vscode.window.registerWebviewPanelSerializer).toHaveBeenCalledWith(
			"octocode.TabPanelProvider",
			expect.any(Object),
		)
		expect(vscode.window.registerWebviewPanelSerializer).toHaveBeenCalledWith(
			"octocode.TabPanelProvider.artifacts",
			expect.any(Object),
		)
	})

	it("announces becoming visible only on a real hidden -> visible transition", async () => {
		/*
		 * The event also fires when the panel stops being the *active* editor while
		 * staying on screen, which happens every time focus moves to a neighbouring
		 * group. The webview answers this message by focusing the chat box, so
		 * firing it then made the conversation snatch focus straight back: selecting
		 * the terminal from the management rail put the caret in the terminal and
		 * then returned it to the chat.
		 */
		let onViewState:
			| ((event: { webviewPanel: { visible: boolean; webview: { postMessage: Mock } } }) => void)
			| undefined
		const webview = { postMessage: vi.fn() }
		const panel = {
			dispose: vi.fn(),
			visible: true,
			onDidChangeViewState: vi.fn((handler) => {
				onViewState = handler
			}),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview,
		}
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue(panel)

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		webview.postMessage.mockClear()

		// Focus moves to a sibling group: still visible, never hidden.
		onViewState?.({ webviewPanel: { visible: true, webview } })
		expect(webview.postMessage).not.toHaveBeenCalled()

		// Actually hidden, then shown again.
		onViewState?.({ webviewPanel: { visible: false, webview } })
		onViewState?.({ webviewPanel: { visible: true, webview } })
		expect(webview.postMessage).toHaveBeenCalledWith({ type: "action", action: "didBecomeVisible" })
	})

	it("keeps the execution terminal closed until explicitly reopened", async () => {
		const panel = {
			dispose: vi.fn(),
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		}
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue(panel)
		let terminalPty: vscode.Pseudoterminal | undefined
		const terminal = { dispose: vi.fn(), show: vi.fn() }
		;(vscode.window.createTerminal as Mock).mockImplementation((options: vscode.ExtensionTerminalOptions) => {
			terminalPty = options.pty
			return terminal
		})

		await handlers["octocode.openChatPanel"]()
		await handlers["octocode.openArtifactPanel"]()
		await handlers["octocode.openBrowserPanel"]()
		await handlers["octocode.openRuntimeTerminal"]()

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"octocode.TabPanelProvider",
			"OctoCode",
			vscode.ViewColumn.One,
			expect.any(Object),
		)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"octocode.TabPanelProvider.artifacts",
			"common:ui.artifactPreview",
			vscode.ViewColumn.Two,
			expect.any(Object),
		)
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.browser.open", {
			relocateExisting: true,
			viewColumn: vscode.ViewColumn.Two,
		})
		expect(terminal.show).toHaveBeenCalledWith(true)

		terminalPty!.close!()
		await Promise.resolve()
		expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)

		panel.dispose.mockClear()
		await handlers["octocode.openRuntimeTerminal"]()
		expect(vscode.window.createTerminal).toHaveBeenCalledTimes(2)
		expect(panel.dispose).not.toHaveBeenCalled()
	})

	it("does not recreate a chat panel while the extension is shutting down", async () => {
		let close: (() => void) | undefined
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue({
			dispose: vi.fn(),
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn((callback: () => void) => (close = callback)),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		})

		await handlers["octocode.openChatPanel"]()
		mockContext.subscriptions[0].dispose()
		close!()
		await Promise.resolve()

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it("does not recreate the execution terminal while the extension is shutting down", async () => {
		let close: (() => void) | undefined
		;(vscode.window.createTerminal as Mock).mockImplementation((options: vscode.ExtensionTerminalOptions) => {
			close = options.pty.close
			return { dispose: vi.fn(), show: vi.fn() }
		})

		runtimeEventTerminal.reopen(vscode.ViewColumn.Three)
		mockContext.subscriptions[0].dispose()
		close!()
		await Promise.resolve()

		expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1)
	})

	it("restores serialized chat and artifact panels without creating duplicates", async () => {
		const serializers = new Map(
			(vscode.window.registerWebviewPanelSerializer as Mock).mock.calls.map(([id, serializer]) => [
				id,
				serializer as vscode.WebviewPanelSerializer,
			]),
		)
		const panel = () =>
			({
				onDidDispose: vi.fn(),
				reveal: vi.fn(),
				webview: { postMessage: vi.fn() },
			}) as unknown as vscode.WebviewPanel
		const chat = panel()
		const artifact = panel()

		await serializers.get("octocode.TabPanelProvider")!.deserializeWebviewPanel(chat, {})
		await serializers.get("octocode.TabPanelProvider.artifacts")!.deserializeWebviewPanel(artifact, {})
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
		expect(chat.reveal).toHaveBeenCalledWith(vscode.ViewColumn.One, true)
		expect(artifact.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Two, true)
	})

	it("closes an inactive persisted duplicate while restoring the active panel", async () => {
		const active = { input: { viewType: "octocode.TabPanelProvider.artifacts" }, isActive: true } as vscode.Tab
		const stale = { input: { viewType: "octocode.TabPanelProvider.artifacts" }, isActive: false } as vscode.Tab
		;(vscode.window.tabGroups as unknown as { all: vscode.TabGroup[] }).all = [
			{ tabs: [active, stale] },
		] as unknown as vscode.TabGroup[]
		const restored = {
			dispose: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		} as unknown as vscode.WebviewPanel
		const serializer = (vscode.window.registerWebviewPanelSerializer as Mock).mock.calls.find(
			([id]) => id === "octocode.TabPanelProvider.artifacts",
		)?.[1] as vscode.WebviewPanelSerializer

		await serializer.deserializeWebviewPanel(restored, {})

		expect(vscode.window.tabGroups.close).toHaveBeenCalledWith([stale])
	})

	it.each([
		["octocode.openChatPanel", "octocode.TabPanelProvider"],
		["octocode.openArtifactPanel", "octocode.TabPanelProvider.artifacts"],
	])("disposes a duplicate restored panel after %s has already opened", async (command, serializerId) => {
		const active = {
			dispose: vi.fn(),
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		} as unknown as vscode.WebviewPanel
		const restored = {
			dispose: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		} as unknown as vscode.WebviewPanel
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue(active)

		await handlers[command]()
		const serializer = (vscode.window.registerWebviewPanelSerializer as Mock).mock.calls.find(
			([id]) => id === serializerId,
		)?.[1] as vscode.WebviewPanelSerializer
		await serializer.deserializeWebviewPanel(restored, {})

		expect(restored.dispose).toHaveBeenCalledTimes(1)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it.each([
		["chat", "octocode.TabPanelProvider"],
		["artifact", "octocode.TabPanelProvider.artifacts"],
	])("disposes a concurrently restored duplicate %s panel", async (_kind, serializerId) => {
		const panel = () =>
			({
				dispose: vi.fn(),
				onDidDispose: vi.fn(),
				reveal: vi.fn(),
				webview: { postMessage: vi.fn() },
			}) as unknown as vscode.WebviewPanel
		const first = panel()
		const duplicate = panel()
		const serializer = (vscode.window.registerWebviewPanelSerializer as Mock).mock.calls.find(
			([id]) => id === serializerId,
		)?.[1] as vscode.WebviewPanelSerializer

		await Promise.all([
			serializer.deserializeWebviewPanel(first, {}),
			serializer.deserializeWebviewPanel(duplicate, {}),
		])

		expect(first.dispose).not.toHaveBeenCalled()
		expect(duplicate.dispose).toHaveBeenCalledTimes(1)
	})

	it.each([
		["octocode.openChatPanel", "octocode.TabPanelProvider"],
		["octocode.openArtifactPanel", "octocode.TabPanelProvider.artifacts"],
	])("reuses a panel restored while %s is opening", async (command, serializerId) => {
		let release!: (value: unknown) => void
		;(ContextProxy.getInstance as Mock).mockReturnValue(
			new Promise((resolve) => {
				release = resolve
			}),
		)
		const restored = {
			dispose: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		} as unknown as vscode.WebviewPanel
		const serializer = (vscode.window.registerWebviewPanelSerializer as Mock).mock.calls.find(
			([id]) => id === serializerId,
		)?.[1] as vscode.WebviewPanelSerializer

		const restoring = serializer.deserializeWebviewPanel(restored, {})
		const opening = handlers[command]() as Promise<unknown>
		await vi.waitFor(() => expect(ContextProxy.getInstance).toHaveBeenCalledTimes(2))
		release(undefined)
		await Promise.all([restoring, opening])

		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
		expect(restored.dispose).not.toHaveBeenCalled()
	})

	it("reopens a restored chat panel with its welcome view after close", async () => {
		const serializers = new Map(
			(vscode.window.registerWebviewPanelSerializer as Mock).mock.calls.map(([id, serializer]) => [
				id,
				serializer as vscode.WebviewPanelSerializer,
			]),
		)
		let dispose: (() => void) | undefined
		const restored = {
			onDidDispose: vi.fn((callback: () => void) => (dispose = callback)),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		} as unknown as vscode.WebviewPanel
		const reopened = {
			dispose: vi.fn(),
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			webview: {},
		} as unknown as vscode.WebviewPanel
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue(reopened)

		await serializers.get("octocode.TabPanelProvider")!.deserializeWebviewPanel(restored, {})
		dispose!()
		await vi.waitFor(() => expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1))

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"octocode.TabPanelProvider",
			"OctoCode",
			vscode.ViewColumn.One,
			expect.objectContaining({ enableScripts: true }),
		)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("setContext", "octocode.chatSlotClosed", true)
	})

	it("settingsButtonClicked posts both settingsButtonClicked and didBecomeVisible actions", () => {
		handlers["octocode.settingsButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "settingsButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledTimes(2)
	})

	it("settingsButtonClicked is a no-op when no visible provider", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		handlers["octocode.settingsButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("marketplaceButtonClicked posts marketplaceButtonClicked action", () => {
		handlers["octocode.marketplaceButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "marketplaceButtonClicked",
		})
	})

	it("acceptInput posts acceptInput message", () => {
		handlers["octocode.acceptInput"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "acceptInput",
		})
	})

	it("toggleAutoApprove awaits postMessage with toggleAutoApprove action", async () => {
		// Deferred-promise pattern: pin that the handler actually awaits
		// postMessageToWebview rather than fire-and-forgetting it. If `await`
		// were dropped in the handler, handlerPromise would resolve before
		// resolvePost() is called and `settled` would flip true at the
		// microtask flush below, failing the pending-state assertion.
		let resolvePost!: () => void
		const postPromise = new Promise<void>((resolve) => {
			resolvePost = resolve
		})
		mockVisibleProvider.postMessageToWebview.mockReturnValueOnce(postPromise)

		const handlerPromise = handlers["octocode.toggleAutoApprove"]() as Promise<unknown>
		let settled = false
		void handlerPromise.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)

		resolvePost()
		await handlerPromise

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "toggleAutoApprove",
		})
	})

	it("focusInput awaits postMessage on the registered provider when a sidebar panel is active", async () => {
		const fakeSidebar = {} as vscode.WebviewView
		setPanel(fakeSidebar, "sidebar")

		// Same deferred-promise pattern as above. focusInput first awaits
		// focusPanel() (mocked to resolve sync) and then awaits
		// provider.postMessageToWebview — so we flush two microtasks before
		// asserting the pending state, to let the handler advance past the
		// focusPanel await and suspend on the deferred postPromise.
		let resolvePost!: () => void
		const postPromise = new Promise<void>((resolve) => {
			resolvePost = resolve
		})
		mockProvider.postMessageToWebview.mockReturnValueOnce(postPromise)

		const handlerPromise = handlers["octocode.focusInput"]() as Promise<unknown>
		let settled = false
		void handlerPromise.then(() => {
			settled = true
		})
		await Promise.resolve()
		await Promise.resolve()
		expect(settled).toBe(false)

		resolvePost()
		await handlerPromise

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
	})

	it("focusInput does not post when no sidebar panel is active", async () => {
		await handlers["octocode.focusInput"]()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	// Representative coverage for the .catch arm on all four void-prefixed
	// postMessageToWebview sites in registerCommands.ts (settingsButtonClicked
	// posts twice, plus marketplaceButtonClicked and acceptInput). Each handler is synchronous, so the .catch arm runs on a
	// microtask; setImmediate ensures all microtasks are flushed before we assert. The
	// log messages carry a `[<handlerName>]` prefix so multi-failure logs
	// remain unambiguous; the prefix is per-handler, not per-call (both of
	// settingsButtonClicked's posts share the same prefix).
	it.each([
		{ command: "octocode.settingsButtonClicked", prefix: "settingsButtonClicked", expectedCalls: 2 },
		{ command: "octocode.marketplaceButtonClicked", prefix: "marketplaceButtonClicked", expectedCalls: 1 },
		{ command: "octocode.acceptInput", prefix: "acceptInput", expectedCalls: 1 },
	])(
		"$command logs to outputChannel when postMessageToWebview rejects",
		async ({ command, prefix, expectedCalls }) => {
			const boom = new Error("boom")
			mockVisibleProvider.postMessageToWebview.mockReset()
			mockVisibleProvider.postMessageToWebview.mockRejectedValue(boom)

			handlers[command]()

			// Flush microtasks so the chained .catch arm runs.
			await new Promise((resolve) => setImmediate(resolve))

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(expectedCalls)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				`[${prefix}] postMessageToWebview failed: ${boom}`,
			)
		},
	)

	it("toggleAutoApprove logs to outputChannel when postMessageToWebview rejects", async () => {
		// toggleAutoApprove is `async` and awaits postMessageToWebview inside a
		// try/catch (rather than relying on a `.catch` microtask like the
		// void-prefixed sites), so awaiting the handler itself is sufficient to
		// observe the appendLine call.
		const boom = new Error("boom")
		mockVisibleProvider.postMessageToWebview.mockReset()
		mockVisibleProvider.postMessageToWebview.mockRejectedValue(boom)

		await handlers["octocode.toggleAutoApprove"]()

		expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(1)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			`[toggleAutoApprove] postMessageToWebview failed: ${boom}`,
		)
	})

	it("plusButtonClicked calls evictCurrentTask on the visible provider", async () => {
		const evictCurrentTask = vi.fn().mockResolvedValue(undefined)
		const refreshWorkspace = vi.fn().mockResolvedValue(undefined)
		;(mockVisibleProvider as any).evictCurrentTask = evictCurrentTask
		;(mockVisibleProvider as any).refreshWorkspace = refreshWorkspace

		await handlers["octocode.plusButtonClicked"]()

		expect(evictCurrentTask).toHaveBeenCalledTimes(1)
	})

	it("plusButtonClicked is a no-op when no visible provider", async () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		// Should not throw even with no visible provider
		await handlers["octocode.plusButtonClicked"]()
	})
})

describe("openClineInNewTab", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()
		resetWorkbenchState()
		;(vscode.window.tabGroups as unknown as { all: vscode.TabGroup[] }).all = []

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}

		mockContext = {
			subscriptions: [],
			extensionUri: { path: "/mock/ext" },
		} as unknown as vscode.ExtensionContext

		const mockPanel = {
			webview: { postMessage: vi.fn() },
			reveal: vi.fn(),
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		}
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue(mockPanel)

		// Reset module-level panel state.
		setPanel(undefined, "sidebar")
		setPanel(undefined, "tab")
	})

	it("creates a webview panel with title 'OctoCode'", async () => {
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"octocode.TabPanelProvider",
			"OctoCode",
			expect.any(Number),
			expect.objectContaining({
				enableScripts: true,
				retainContextWhenHidden: true,
			}),
		)
	})

	it("starts the execution terminal when restoring the workbench", async () => {
		const terminal = runtimeEventTerminal.open(vscode.ViewColumn.Three)
		vi.mocked(terminal.show).mockClear()

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(terminal.show).toHaveBeenCalledWith(true)
	})

	it("reuses chat and artifact panels on repeated opens", async () => {
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("closes persisted duplicate workbench tabs while keeping the active tab of each type", async () => {
		const tab = (viewType: string, isActive: boolean) => ({ input: { viewType }, isActive }) as vscode.Tab
		const activeChat = tab("octocode.TabPanelProvider", true)
		const staleChat = tab("octocode.TabPanelProvider", false)
		const activeArtifact = tab("octocode.TabPanelProvider.artifacts", true)
		const staleArtifact = tab("octocode.TabPanelProvider.artifacts", false)
		const unresolved = { input: undefined, isActive: false, label: "其他标签" } as unknown as vscode.Tab
		const lazyArtifact = { input: undefined, isActive: false, label: "多模态预览" } as unknown as vscode.Tab
		;(vscode.window.tabGroups as unknown as { all: vscode.TabGroup[] }).all = [
			{ tabs: [unresolved, staleChat, activeChat] },
			{ tabs: [activeArtifact, staleArtifact, lazyArtifact] },
		] as unknown as vscode.TabGroup[]

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.window.tabGroups.close).toHaveBeenCalledWith([staleChat, staleArtifact, lazyArtifact])
	})

	it("relocates existing browser tabs to the upper-right group when restoring the workbench", async () => {
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.browser.open", {
			viewColumn: vscode.ViewColumn.Two,
			relocateExisting: true,
		})
	})

	it.each([
		["chat", "octocode.TabPanelProvider", "OctoCode", vscode.ViewColumn.One, 0],
		["artifact", "octocode.TabPanelProvider.artifacts", "多模态预览", vscode.ViewColumn.Two, 1],
	])("preserves the chat but respects closing the %s editor group", async (_kind, viewType, title, column, index) => {
		const disposals: Array<() => void> = []
		;(vscode.window.createWebviewPanel as Mock).mockImplementation(() => ({
			dispose: vi.fn(),
			iconPath: undefined,
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn((callback: () => void) => disposals.push(callback)),
			reveal: vi.fn(),
			webview: { postMessage: vi.fn() },
		}))

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		disposals[index]()
		if (_kind === "artifact") {
			await Promise.resolve()
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
			return
		}
		await vi.waitFor(() => expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(3))

		expect(vscode.window.createWebviewPanel).toHaveBeenLastCalledWith(
			viewType,
			title,
			column,
			expect.objectContaining({ enableScripts: true }),
		)
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"setContext",
			`octocode.${_kind}SlotClosed`,
			true,
		)
	})
})
