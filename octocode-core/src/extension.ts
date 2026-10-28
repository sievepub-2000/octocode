import * as vscode from "vscode"
import * as dotenv from "dotenv"
import * as fs from "fs"
import * as path from "path"

import type { CloudUserInfo, AuthState } from "@roo-code/types"
import { CloudService } from "@roo-code/cloud"
import { TelemetryService, PostHogTelemetryClient } from "@roo-code/telemetry"
import { customToolRegistry } from "@roo-code/core"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { createOutputChannelLogger, createDualLogger } from "./utils/outputChannelLogger"
import { initializeNetworkProxy } from "./utils/networkProxy"

import { Package } from "./shared/package"
import { resolveActivationLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { ClineProvider } from "./core/webview/ClineProvider"
const DIFF_VIEW_URI_SCHEME = "cline-diff" // Existing document URI compatibility.
import { Terminal } from "./integrations/terminal/Terminal"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { openAiCodexOAuthManager } from "./integrations/openai-codex/oauth"
import { kimiCodeOAuthManager } from "./integrations/kimi-code/oauth"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { CodeIndexManager } from "./services/code-index/manager"
import { MdmService } from "./services/mdm/MdmService"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./utils/autoImportSettings"
import { ensureDefaultWorkspace } from "./utils/defaultWorkspace"
import { API } from "./extension/api"

import {
	handleUri,
	registerCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n } from "./i18n"
import { initOctoCodeAuth } from "./services/octocode-auth"
import { initializeOctoCodeRuntime } from "./services/octocode-runtime/OctoCodeRuntime"
import { WorkbenchMcpServer } from "./services/workbench-mcp/WorkbenchMcpServer"
import { createToolHub, isTrustedLocalMcpServer } from "./services/workbench-mcp/toolHub"
import { environmentManifest, getSharedEnvironmentProvisioner } from "./services/environments"
import { runtimeEventArtifactPath, runtimeEventTerminal } from "./activate/runtimeEventTerminal"
import { previewRuntimeArtifact } from "./activate/runtimeArtifactPreview"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext
let cloudService: CloudService | undefined

let authStateChangedHandler: ((data: { state: AuthState; previousState: AuthState }) => Promise<void>) | undefined
let settingsUpdatedHandler: (() => void) | undefined
let userInfoHandler: ((data: { userInfo: CloudUserInfo }) => Promise<void>) | undefined

/**
 * Check if we should auto-open the OctoCode sidebar after switching to a worktree.
 * This is called during extension activation to handle the worktree auto-open flow.
 */
async function checkWorktreeAutoOpen(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	try {
		const worktreeAutoOpenPath = context.globalState.get<string>("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return
		}

		const currentPath = workspaceFolders[0].uri.fsPath

		// Normalize paths for comparison
		const normalizePath = (p: string) => p.replace(/\/+$/, "").replace(/\\+/g, "/").toLowerCase()

		// Check if current workspace matches the worktree path
		if (normalizePath(currentPath) === normalizePath(worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			await context.globalState.update("worktreeAutoOpenPath", undefined)

			outputChannel.appendLine(`[Worktree] Auto-opening OctoCode sidebar for worktree: ${worktreeAutoOpenPath}`)

			// Open the OctoCode sidebar with a slight delay to ensure UI is ready
			setTimeout(async () => {
				try {
					await vscode.commands.executeCommand("octocode.plusButtonClicked")
				} catch (error) {
					outputChannel.appendLine(
						`[Worktree] Error auto-opening sidebar: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}, 500)
		}
	} catch (error) {
		outputChannel.appendLine(
			`[Worktree] Error checking worktree auto-open: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	// The extension-level .env is optional (not shipped in production builds).
	const envPath = path.join(__dirname, "..", ".env")
	if (fs.existsSync(envPath)) {
		try {
			dotenv.config({ path: envPath })
		} catch (e) {
			// Best-effort only: never fail extension activation due to optional env loading.
			console.warn("Failed to load environment variables:", e)
		}
	}

	extensionContext = context
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)

	/*
	 * Startup profile.
	 *
	 * Activation is a long serial chain and the window cannot finish opening until
	 * it ends, so when a cold start is slow the only useful question is which link
	 * is holding it. Measured on a running build, that answer was worth minutes:
	 * connecting MCP servers alone accounted for 1m36s of a 4-minute start, and
	 * nothing in the log said so. Each phase is timed and reported here.
	 */
	const activationStarted = Date.now()
	let phaseStarted = activationStarted
	const phase = (name: string) => {
		const now = Date.now()
		outputChannel.appendLine(`[startup] ${name} ${now - phaseStarted}ms (total ${now - activationStarted}ms)`)
		phaseStarted = now
	}
	context.subscriptions.push(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)
	const workbenchMcp = new WorkbenchMcpServer(
		outputChannel,
		async (file, line, column) => {
			const artifact = ClineProvider.getArtifactInstance()
			if (!artifact) throw new Error("Artifact view is not available")
			await artifact.showArtifact(file, line, column)
		},
		undefined,
		async (name, input) => {
			if (!vscode.lm.tools.some((tool) => tool.name === name)) {
				throw new Error(`Integrated browser tool is unavailable: ${name}`)
			}
			const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined })
			return result.content
		},
	)
	context.subscriptions.push(workbenchMcp)
	const octoRuntime = initializeOctoCodeRuntime(context, outputChannel, workbenchMcp)
	workbenchMcp.setHostCall((method, params) => octoRuntime.call(method, params))
	const warningListener = (warning: Error) => {
		outputChannel.appendLine(`[Node warning] ${warning.stack ?? warning.message}`)
		void octoRuntime
			.call("log.create", {
				category: "system",
				level: "warning",
				subsystem: "extension-host",
				message: warning.message,
				fields: { name: warning.name, stack: warning.stack },
			})
			.catch(() => undefined)
	}
	process.on("warning", warningListener)
	context.subscriptions.push({ dispose: () => process.off("warning", warningListener) })
	context.subscriptions.push(octoRuntime)

	// Initialize network proxy configuration early, before any network requests.
	// When proxyUrl is configured, all HTTP/HTTPS traffic will be routed through it.
	// Only applied in debug mode (F5).
	await initializeNetworkProxy(context, outputChannel)
	phase("network proxy")

	// Set extension path for custom tool registry to find bundled esbuild
	customToolRegistry.setExtensionPath(context.extensionPath)

	// Migrate old settings to new
	await migrateSettings(context, outputChannel)
	phase("migrate settings")

	// Initialize telemetry service.
	const telemetryService = TelemetryService.createInstance()

	if (process.env.POSTHOG_API_KEY) {
		telemetryService.register(new PostHogTelemetryClient())
	}

	// Create logger for cloud services.
	const cloudLogger = createDualLogger(createOutputChannelLogger(outputChannel))

	// Initialize MDM service
	const mdmService = await MdmService.createInstance(cloudLogger)
	phase("MDM service")

	// VS Code's native Configure Display Language is authoritative after restart.
	const resolvedLanguage = resolveActivationLanguage(context.globalState.get("language"), vscode.env.language)
	if (resolvedLanguage.shouldPersist) {
		await context.globalState.update("language", resolvedLanguage.language)
	}
	initializeI18n(resolvedLanguage.language)

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Initialize OpenAI Codex OAuth manager for ChatGPT subscription-based access.
	openAiCodexOAuthManager.initialize(context, (message) => outputChannel.appendLine(message))
	// Kimi Code OAuth tokens live only in VS Code SecretStorage, outside provider profile JSON/cloud sync.
	kimiCodeOAuthManager.initialize(context)

	// Initialize OctoCode auth service for extension session token management.
	await initOctoCodeAuth(context)
	phase("auth")

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		context.globalState.update("allowedCommands", defaultCommands)
	}

	const contextProxy = await ContextProxy.getInstance(context)
	phase("context proxy")

	// Initialize code index managers for all workspace folders.
	const codeIndexManagers: CodeIndexManager[] = []

	if (vscode.workspace.workspaceFolders) {
		for (const folder of vscode.workspace.workspaceFolders) {
			const manager = CodeIndexManager.getInstance(context, folder.uri.fsPath)

			if (manager) {
				codeIndexManagers.push(manager)

				// Initialize in background; do not block extension activation
				void manager.initialize(contextProxy).catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(manager)
			}
		}
	}

	// Initialize the provider *before* the Roo Code Cloud service.
	const provider = new ClineProvider(context, outputChannel, "sidebar", contextProxy, mdmService)
	workbenchMcp.setToolHub(
		createToolHub({
			getMcpHub: () => provider.getMcpHub(),
			getSkillsManager: () => provider.getSkillsManager(),
			getModes: () => provider.getModes(),
			getNativeTools: () => vscode.lm.tools,
			invokeNativeTool: async (name, input) =>
				(await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined })).content,
			isTrustedMcpServer: (server) =>
				isTrustedLocalMcpServer(
					server,
					process.env.OCTOCODE_ENVIRONMENTS ? [process.env.OCTOCODE_ENVIRONMENTS] : [],
				),
			getEnvironments: async () => {
				const provisioner = getSharedEnvironmentProvisioner()
				if (!provisioner) return []
				return Promise.all(
					environmentManifest.map(async (env) => ({
						id: env.id,
						label: env.label,
						purpose: env.purpose,
						installed: await provisioner.isInstalled(env.id),
					})),
				)
			},
			provisionEnvironment: async (id) => {
				const provisioner = getSharedEnvironmentProvisioner()
				if (!provisioner) throw new Error("Runtime environments are only available in the installed product")
				const result = await provisioner.ensure(id)
				// The provisioner's `installed` means "installed by this call"; the agent read
				// `installed:false` on an environment that was already there as "not installed".
				return {
					id: result.id,
					available: await provisioner.isInstalled(id),
					installedNow: result.installed,
					pathEntries: result.pathEntries,
				}
			},
		}),
	)
	workbenchMcp.setAskUser((task, question, options) => octoRuntime.requestUserInput(task, question, options))
	context.subscriptions.push(
		octoRuntime.onEvent((event) => {
			runtimeEventTerminal.accept(event)
			const artifactPath = runtimeEventArtifactPath(event)
			const artifact = artifactPath ? ClineProvider.getArtifactInstance() : undefined
			if (artifactPath && artifact) {
				void previewRuntimeArtifact(
					artifactPath,
					(filePath) => artifact.showArtifact(filePath),
					(name) => runtimeEventTerminal.reportArtifactFailure(name, event.session_id),
				).catch(() => outputChannel.appendLine("[Artifact] Execution terminal unavailable"))
			}
			for (const instance of ClineProvider.getAllInstances()) {
				void instance.postMessageToWebview({ type: "agentEvent", payload: event })
			}
		}),
	)
	const supervised = new Set<string>()
	const attempting = new Set<string>()
	const attempts = new Map<string, number[]>()
	const supervisionPath = context.globalStorageUri?.fsPath
		? path.join(context.globalStorageUri.fsPath, "harness-runtime", "daemon", "supervision.json")
		: undefined
	const checkSupervision = () => {
		if (!supervisionPath) return
		let snapshot: {
			at?: string
			active?: { session_id: string; needs_new_session?: boolean }[]
			recovery_pending?: string[]
		}
		try {
			snapshot = JSON.parse(fs.readFileSync(supervisionPath, "utf8"))
		} catch {
			return
		}
		if (!snapshot.at || Date.now() - Date.parse(snapshot.at) > 90_000) return
		const sessions = [
			...(snapshot.active ?? []).filter((task) => task.needs_new_session).map((task) => task.session_id),
			...(snapshot.recovery_pending ?? []),
		]
		for (const sessionId of new Set(sessions)) {
			const recentAttempts = (attempts.get(sessionId) ?? []).filter((at) => Date.now() - at < 600_000)
			if (supervised.has(sessionId) || attempting.has(sessionId) || recentAttempts.length >= 3) continue
			const provider = ClineProvider.getVisibleInstance() ?? ClineProvider.getAllInstances()[0]
			if (!provider) continue
			attempting.add(sessionId)
			void provider
				.rolloverRuntimeSession(sessionId)
				.then((started) => {
					if (started) supervised.add(sessionId)
				})
				.catch((error) => outputChannel.appendLine(`[OctoCode supervision] ${sessionId}: ${String(error)}`))
				.finally(() => {
					attempts.set(sessionId, [...recentAttempts, Date.now()])
					attempting.delete(sessionId)
				})
		}
	}
	if (supervisionPath) {
		const supervisionTimer = setInterval(checkSupervision, 30_000)
		context.subscriptions.push(new vscode.Disposable(() => clearInterval(supervisionTimer)))
		checkSupervision()
	}

	// Initialize Roo Code Cloud service.
	const postStateListener = () => ClineProvider.getVisibleInstance()?.postStateToWebviewWithoutClineMessages()

	authStateChangedHandler = async (_data: { state: AuthState; previousState: AuthState }) => {
		postStateListener()
	}

	settingsUpdatedHandler = async () => {
		postStateListener()
	}

	userInfoHandler = async ({ userInfo }: { userInfo: CloudUserInfo }) => {
		postStateListener()
	}

	try {
		cloudService = await CloudService.createInstance(context, cloudLogger, {
			"auth-state-changed": authStateChangedHandler,
			"settings-updated": settingsUpdatedHandler,
			"user-info": userInfoHandler,
		})

		// Add to subscriptions for proper cleanup on deactivate.
		context.subscriptions.push(cloudService)
	} catch (error) {
		cloudService = undefined
		outputChannel.appendLine(
			`[CloudService] Initialization failed; continuing without cloud startup dependencies: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Finish initializing the provider.
	TelemetryService.instance.setProvider(provider)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// Check for worktree auto-open path (set when switching to a worktree)
	phase("cloud service")
	await checkWorktreeAutoOpen(context, outputChannel)
	phase("worktree auto-open")

	// Auto-import configuration if specified in settings.
	try {
		await autoImportSettings(outputChannel, {
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
			customModesManager: provider.customModesManager,
		})
	} catch (error) {
		outputChannel.appendLine(
			`[AutoImport] Error during auto-import: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	try {
		await provider.installDefaultMarketplaceItems()
		phase("marketplace defaults")
	} catch (error) {
		outputChannel.appendLine(
			`[Defaults] Failed to install bundled defaults: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	registerCommands({ context, outputChannel, provider })

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
	 *
	 * This API allows you to create readonly documents in VSCode from arbitrary
	 * sources, and works by claiming an uri-scheme for which your provider then
	 * returns text contents. The scheme must be provided when registering a
	 * provider and cannot change afterwards.
	 *
	 * Note how the provider doesn't create uris for virtual documents - its role
	 * is to provide contents given such an uri. In return, content providers are
	 * wired into the open document logic so that providers are always considered.
	 *
	 * https://code.visualstudio.com/api/extension-guides/virtual-documents
	 */
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
	)

	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register code actions provider.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider({ pattern: "**/*" }, new CodeActionProvider(), {
			providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
		}),
	)

	registerCodeActions(context)
	registerTerminalActions(context)

	// Allows other extensions to activate once Roo is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `RooCodeAPI` interface.
	const socketPath = process.env.ROO_CODE_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host.
	if (process.env.NODE_ENV === "development") {
		const watchPaths = [
			{ path: context.extensionPath, pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/telemetry"), pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "node_modules/@roo-code/cloud"), pattern: "**/*" },
		]

		console.log(
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			console.log(`♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				console.log(`♻️ Reloading host after debounce delay...`)
				vscode.commands.executeCommand("workbench.action.reloadWindow")
			}, DEBOUNCE_DELAY)
		}

		watchPaths.forEach(({ path: watchPath, pattern }) => {
			const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
			const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)

			// Listen to all change types to ensure symlinked file updates trigger reloads.
			watcher.onDidChange(debouncedReload)
			watcher.onDidCreate(debouncedReload)
			watcher.onDidDelete(debouncedReload)

			context.subscriptions.push(watcher)
		})

		// Clean up the timeout on deactivation
		context.subscriptions.push({
			dispose: () => {
				if (reloadTimeout) {
					clearTimeout(reloadTimeout)
				}
			},
		})
	}

	if (!process.env.ROO_CLI_RUNTIME) {
		await ensureDefaultWorkspace(context, outputChannel)
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("octocode.workspace.path")) {
					void ensureDefaultWorkspace(context, outputChannel).catch((error: unknown) => {
						void vscode.window.showErrorMessage(`工作区配置无效：${String(error)}`)
					})
				}
			}),
		)
		phase("default workspace")
		/*
		 * Look for an update, if the user asked us to.
		 *
		 * Detached and swallowed: a slow or unreachable update channel must not
		 * hold up activation, and must never be the reason the window fails to
		 * open. UpdateService returns early unless a manifest URL is configured
		 * and the mode says to check at startup.
		 */
		void import("./services/update/UpdateService")
			.then(({ UpdateService }) =>
				new UpdateService(context, (message) => outputChannel.appendLine(message)).checkOnStartup(),
			)
			.catch((error) => outputChannel.appendLine(`[update] startup check skipped: ${error}`))
		const openTabs = new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label)))
		const hasChat = openTabs.has("OctoCode")
		const hasArtifact = openTabs.has("多模态预览")
		const hasTerminal = openTabs.has("OctoCode 执行")

		if (!hasChat && !hasArtifact && !hasTerminal) {
			await vscode.commands.executeCommand("octocode.openInNewTab")
		} else {
			if (!hasChat) await vscode.commands.executeCommand("octocode.openChatPanel")
			if (!hasArtifact) await vscode.commands.executeCommand("octocode.openArtifactPanel")
			if (!hasTerminal) await vscode.commands.executeCommand("octocode.openRuntimeTerminal")
		}
	}

	phase("open shell")

	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	if (cloudService && CloudService.hasInstance()) {
		try {
			if (authStateChangedHandler) {
				CloudService.instance.off("auth-state-changed", authStateChangedHandler)
			}

			if (settingsUpdatedHandler) {
				CloudService.instance.off("settings-updated", settingsUpdatedHandler)
			}

			if (userInfoHandler) {
				CloudService.instance.off("user-info", userInfoHandler)
			}

			outputChannel.appendLine("CloudService event handlers cleaned up")
		} catch (error) {
			outputChannel.appendLine(
				`Failed to clean up CloudService event handlers: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	await McpServerManager.cleanup(extensionContext)

	try {
		await TelemetryService.instance.shutdown()
	} catch (error) {
		outputChannel.appendLine(
			`Failed to shut down telemetry service: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	Terminal.setTerminalProfile(undefined)
	TerminalRegistry.cleanup()
}
