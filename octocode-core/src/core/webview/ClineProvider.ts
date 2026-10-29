import EventEmitter from "events"
import fs from "fs/promises"
import { existsSync, realpathSync } from "node:fs"
import os from "os"
import * as path from "path"

import axios from "axios"
import delay from "delay"
import * as vscode from "vscode"

import { CloudService, getRooCodeApiUrl } from "@roo-code/cloud"
import { TelemetryService } from "@roo-code/telemetry"
import {
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES_AFTER_USER_EDITED,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_NEW_FILES,
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	DEFAULT_DIFF_FUZZY_THRESHOLD,
	DEFAULT_MODES,
	DEFAULT_WRITE_DELAY_MS,
	ORGANIZATION_ALLOW_ALL,
	RooCodeEventName,
	getModelId,
	isRetiredProvider,
	openRouterDefaultModelId,
	providerIdentifiers,
	requestyDefaultModelId,
	type CloudAppProperties,
	type CloudOrganizationMembership,
	type CloudUserInfo,
	type CodeActionId,
	type CodeActionName,
	type DynamicAppProperties,
	type ExtensionMessage,
	type ExtensionState,
	type GitProperties,
	type GlobalState,
	type MarketplaceInstalledMetadata,
	type ProviderName,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type RooCodeSettings,
	type RuntimeTask,
	type StaticAppProperties,
	type TaskProperties,
	type TaskProviderEvents,
	type TelemetryProperties,
	type TelemetryPropertiesProvider,
	type TerminalActionId,
	type TerminalActionPromptType,
} from "@roo-code/types"

import { findLast } from "../../shared/array"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { experimentDefault } from "../../shared/experiments"
import { DEFAULT_LANGUAGE } from "../../shared/language"
import { Mode, defaultModeSlug } from "../../shared/modes"
import { Package } from "../../shared/package"
import { supportPrompt } from "../../shared/support-prompt"
import { WebviewMessage } from "../../shared/WebviewMessage"

import { extractTextFromFile, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import { Terminal } from "../../integrations/terminal/Terminal"
import { runtimeEventTerminal } from "../../activate/runtimeEventTerminal"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import { CodeIndexManager } from "../../services/code-index/manager"
import { MarketplaceManager } from "../../services/marketplace"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { MdmService } from "../../services/mdm/MdmService"
import { assertOctoCodeAuthenticationAllowed } from "../../services/octocode-auth"
import { SkillsManager } from "../../services/skills/SkillsManager"

import { OrganizationAllowListViolationError } from "../../utils/errors"
import { getWorkspaceGitInfo } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"
import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"

import { setPanel } from "../../activate/registerCommands"

import { t } from "../../i18n"

import { ContextProxy } from "../config/ContextProxy"
import { hasRuntimeEvent } from "./runtimeEventExists"
import { CustomModesManager } from "../config/CustomModesManager"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"

import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { webviewMessageHandler } from "./webviewMessageHandler"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

/**
 * The operating-system account this window is running as.
 *
 * `os.userInfo()` throws when the process has no passwd entry — containers and
 * some service accounts — so the environment is tried first and an empty string
 * is an acceptable answer: the account entry falls back to a generic label
 * rather than the UI failing to render.
 */
function currentOsUserName(): string {
	const fromEnv = process.env.USERNAME || process.env.USER
	if (fromEnv) return fromEnv
	try {
		return os.userInfo().username
	} catch {
		return ""
	}
}

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	public static readonly artifactPanelId = `${Package.name}.TabPanelProvider.artifacts`
	private static activeInstances: Set<ClineProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private readonly logChannels = new Map<"system" | "developer", vscode.OutputChannel>()
	private webviewDisposables: vscode.Disposable[] = []
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: CodeIndexManager
	private readonly pendingCodeIndexWork = new Set<Promise<void>>()
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	private marketplaceManager: MarketplaceManager
	private mdmService?: MdmService
	private currentWorkspacePath: string | undefined
	private static activeRuntimeTaskId?: string
	private static activeRuntimeSessionId?: string
	private static activeRuntimeWorkingDirectory?: string
	private readonly artifactsBySession = new Map<string, ExtensionMessage>()
	private _disposed = false // 5 seconds
	public static readonly PENDING_OPERATION_TIMEOUT_MS = 30000 // 30 seconds
	private providerProfileMutationQueue = Promise.resolve()

	private enqueueProviderProfileMutation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController()
		// Run fn after either outcome so a rejected mutation never poisons the queue.
		const run = this.providerProfileMutationQueue.then(
			() => fn(controller.signal),
			() => fn(controller.signal),
		)
		const callerResult = this.withProviderProfileMutationTimeout(run, () => {
			controller.abort()
			this.log("Provider profile mutation timed out; aborting in-flight mutation")
		})

		void run.then(
			() => {
				if (controller.signal.aborted) {
					this.log("Provider profile mutation completed after cancellation")
				}
			},
			(error) => {
				if (controller.signal.aborted) {
					this.log(
						`Provider profile mutation errored after cancellation: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			},
		)

		// Advance from the timeout-bounded result. Each fn checks its AbortSignal before
		// writing state, so advancing the queue on timeout cannot produce stale overwrites.
		this.providerProfileMutationQueue = callerResult.then(
			() => undefined,
			() => undefined,
		)
		return callerResult
	}

	private withProviderProfileMutationTimeout<T>(operation: Promise<T>, onTimeout: () => void): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				onTimeout()
				reject(new Error("Provider profile mutation timed out"))
			}, ClineProvider.PENDING_OPERATION_TIMEOUT_MS)
			void operation.then(
				(value) => {
					clearTimeout(timeoutId)
					resolve(value)
				},
				(error) => {
					clearTimeout(timeoutId)
					reject(error)
				},
			)
		})
	}

	private cloudOrganizationsCache: CloudOrganizationMembership[] | null = null
	private cloudOrganizationsCacheTimestamp: number | null = null
	private static readonly CLOUD_ORGANIZATIONS_CACHE_DURATION_MS = 5 * 1000

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "aug-2026-v3.78.0-models-nanogpt-reliability" // v3.78.0 new models, NanoGPT, and provider/task reliability
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" | "artifact" = "sidebar",
		public readonly contextProxy: ContextProxy,
		mdmService?: MdmService,
	) {
		super()
		this.currentWorkspacePath = getWorkspacePath()

		ClineProvider.activeInstances.add(this)

		this.mdmService = mdmService
		void this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		// Register this provider with the telemetry service to enable it to add
		// properties like mode and provider.
		TelemetryService.instance.setProvider(this)

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutClineMessages()
		})

		// Initialize MCP Hub through the singleton manager
		McpServerManager.getInstance(this.context, this)
			.then((hub) => {
				if (!this._disposed && !hub.disposed) this.mcpHub = hub
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})

		// Initialize Skills Manager for skill discovery
		this.skillsManager = new SkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		this.marketplaceManager = new MarketplaceManager(this.context, this.customModesManager)
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	/**
	 * Initialize cloud profile synchronization
	 */
	private async initializeCloudProfileSync() {
		this.log("Cloud profile synchronization is disabled in compatibility mode")
	}

	/**
	 * Handle cloud settings updates
	 */
	private handleCloudSettingsUpdate = async () => {
		this.log("Ignoring cloud settings update because cloud profile synchronization is disabled")
	}

	/**
	 * Synchronize cloud profiles with local profiles.
	 */
	private async syncCloudProfiles() {
		this.log("Skipping cloud profile synchronization because it is disabled")
	}

	/**
	 * Initialize cloud profile synchronization when CloudService is ready
	 * This method is called externally after CloudService has been initialized
	 */
	public async initializeCloudProfileSyncWhenReady(): Promise<void> {
		this.log("Cloud profile synchronization is disabled in compatibility mode")
	}
	public async evictCurrentTask(): Promise<void> {
		ClineProvider.activeRuntimeSessionId = undefined
		ClineProvider.activeRuntimeTaskId = undefined
		ClineProvider.activeRuntimeWorkingDirectory = undefined
		ClineProvider.syncCodeIndexSelection()
		runtimeEventTerminal.setActiveSession(undefined)
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	private clearWebviewResources() {
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true
		this.mcpHub = undefined
		this.log("Disposing ClineProvider...")

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.log("Disposed webview")
		}

		this.clearWebviewResources()
		await Promise.all(this.pendingCodeIndexWork)

		// Clean up cloud service event listener
		if (CloudService.hasInstance()) {
			CloudService.instance.off("settings-updated", this.handleCloudSettingsUpdate)
		}

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		try {
			await McpServerManager.releaseProvider(this)
		} finally {
			await this.skillsManager?.dispose()
			this.skillsManager = undefined
			await this.marketplaceManager?.cleanup()
			this.customModesManager?.dispose()
			this.log("Disposed all disposables")
			ClineProvider.activeInstances.delete(this)

			// Clean up any event listeners attached to this provider
			this.removeAllListeners()
		}
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(
			Array.from(this.activeInstances),
			(instance) => instance.view?.visible === true && instance.renderContext !== "artifact",
		)
	}

	public static getAllInstances(): ClineProvider[] {
		return Array.from(this.activeInstances)
	}

	public static setActiveRuntimeSession(sessionId: string, taskId: string, workingDirectory?: string): void {
		const directory =
			workingDirectory && path.isAbsolute(workingDirectory) ? path.normalize(workingDirectory) : undefined
		const changed = this.activeRuntimeSessionId !== sessionId || this.activeRuntimeWorkingDirectory !== directory
		if (workingDirectory) runtimeEventTerminal.setSessionWorkingDirectory(sessionId, workingDirectory)
		this.activeRuntimeSessionId = sessionId
		this.activeRuntimeTaskId = taskId
		this.activeRuntimeWorkingDirectory = directory
		if (changed) this.syncCodeIndexSelection()
		void this.getArtifactInstance()?.replayCurrentArtifact()
		runtimeEventTerminal.setActiveSession(sessionId)
	}

	public static getActiveRuntimeTask(): { sessionId: string; taskId: string } | undefined {
		return this.activeRuntimeSessionId && this.activeRuntimeTaskId
			? { sessionId: this.activeRuntimeSessionId, taskId: this.activeRuntimeTaskId }
			: undefined
	}

	public static clearActiveRuntimeSession(sessionId: string): boolean {
		if (this.activeRuntimeSessionId !== sessionId) return false
		this.activeRuntimeSessionId = undefined
		this.activeRuntimeTaskId = undefined
		this.activeRuntimeWorkingDirectory = undefined
		this.syncCodeIndexSelection()
		this.getArtifactInstance()?.artifactsBySession.delete(sessionId)
		void this.getArtifactInstance()?.replayCurrentArtifact()
		runtimeEventTerminal.releaseSession(sessionId)
		return true
	}

	public static getArtifactInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.renderContext === "artifact")
	}

	public static async getInstance(): Promise<ClineProvider | undefined> {
		let visibleProvider = ClineProvider.getVisibleInstance()

		// If no visible provider, try to show the sidebar view
		if (!visibleProvider) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// Wait briefly for the view to become visible
			await delay(100)
			visibleProvider = ClineProvider.getVisibleInstance()
		}

		// If still no visible provider, return
		if (!visibleProvider) {
			return
		}

		return visibleProvider
	}
	public static async isActiveTask(): Promise<boolean> {
		return !!this.activeRuntimeTaskId
	}

	public async installDefaultMarketplaceItems(): Promise<void> {
		if (this._disposed || !(await this.marketplaceManager.installDefaultItemsOnce())) {
			return
		}
		if (this._disposed) return
		const hub = await McpServerManager.getInstance(this.context, this)
		if (this._disposed || hub.disposed) return
		this.mcpHub = hub

		/*
		 * Connect in the background.
		 *
		 * Activation used to await this, which meant the window could not finish
		 * opening until every configured MCP server had either connected or timed
		 * out. Measured on a running build: 3m40s of a cold start was spent here,
		 * against 8 seconds for the host itself to render.
		 *
		 * Nothing in activation needs a connected server: tools appear as each one
		 * becomes ready, and the servers view already renders their connecting and
		 * failed states. A server that never answers now costs its own timeout and
		 * nobody else's.
		 */
		void hub.refreshAllConnections().catch((error) => {
			this.log(
				`[installDefaultMarketplaceItems] MCP connections failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		})
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | any[]>,
	): Promise<void> {
		// Capture telemetry for code action usage
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()

		// TODO: Improve type safety for promptType.
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "addToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.startRuntimeTask(prompt)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | any[]>,
	): Promise<void> {
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "terminalAddToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		try {
			await visibleProvider.startRuntimeTask(prompt)
		} catch (error) {
			if (error instanceof OrganizationAllowListViolationError) {
				// Errors from terminal commands seem to get swallowed / ignored.
				vscode.window.showErrorMessage(error.message)
			}

			throw error
		}
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.view = webviewView
		const inTabMode = "onDidChangeViewState" in webviewView

		if (inTabMode && this.renderContext === "editor") {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}

		// Set up webview options with proper resource roots
		const resourceRoots = [this.contextProxy.extensionUri]

		// Add workspace folders to allow access to workspace files
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: resourceRoots,
		}

		webviewView.webview.html =
			this.contextProxy.extensionMode === vscode.ExtensionMode.Development &&
			existsSync(path.join(this.contextProxy.extensionUri.fsPath, "..", "webview-ui", "package.json"))
				? await this.getHMRHtmlContent(webviewView.webview)
				: await this.getHtmlContent(webviewView.webview)

		// Initialize out-of-scope variables that need to receive persistent
		// global state values.
		await this.getState().then(
			({
				terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
				terminalShellIntegrationDisabled = false,
				terminalCommandDelay = 0,
				terminalZshClearEolMark = true,
				terminalZshOhMy = false,
				terminalZshP10k = false,
				terminalPowershellCounter = false,
				terminalZdotdir = false,
				terminalProfile,
				ttsEnabled,
				ttsSpeed,
			}) => {
				Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
				Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
				Terminal.setCommandDelay(terminalCommandDelay)
				Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
				Terminal.setTerminalZshOhMy(terminalZshOhMy)
				Terminal.setTerminalZshP10k(terminalZshP10k)
				Terminal.setPowershellCounter(terminalPowershellCounter)
				Terminal.setTerminalZdotdir(terminalZdotdir)
				Terminal.setTerminalProfile(terminalProfile)
				setTtsEnabled(ttsEnabled ?? false)
				setTtsSpeed(ttsSpeed ?? 1)
			},
		)

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received.
		this.setWebviewMessageListener(webviewView.webview)

		// Initialize code index status subscription for the current workspace.
		this.updateCodeIndexStatusSubscription()

		// Listen for active editor changes to update code index status for the
		// current workspace.
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			// Update subscription when workspace might have changed.
			this.updateCodeIndexStatusSubscription()
		})
		this.webviewDisposables.push(activeEditorSubscription)

		// Listen for when the panel becomes visible.
		// https://github.com/microsoft/vscode-discussions/discussions/840
		if ("onDidChangeViewState" in webviewView) {
			// WebviewView and WebviewPanel have all the same properties except
			// for this visibility listener panel.
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.view?.visible) {
					void this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				} else {
					this.logWebviewHiddenDiagnostics()
				}
			})

			this.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			// sidebar
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.view?.visible) {
					void this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				} else {
					this.logWebviewHiddenDiagnostics()
				}
			})

			this.webviewDisposables.push(visibilityDisposable)
		}

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				if (inTabMode) {
					this.log("Disposing ClineProvider instance for tab view")
					await this.dispose()
				} else {
					this.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					// Reset current workspace manager reference when view is disposed
					this.codeIndexManager = undefined
				}
			},
			null,
			this.disposables,
		)

		// Listen for when color changes
		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e && e.affectsConfiguration("workbench.colorTheme")) {
				// Sends latest theme name to webview
				await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.webviewDisposables.push(configDisposable)

		// Ensure octocode-gateway profile is seeded for users who signed in before this feature existed.
		// Without this, users with a valid cached token but no octocode-gateway profile would need to
		// re-authenticate to use OctoCode Gateway. Fire-and-forget to avoid blocking webview init.
		void this.ensureOctoCodeGatewayProfileSeeded().catch((err) => {
			this.log(`[ensureOctoCodeGatewayProfileSeeded] Error: ${err instanceof Error ? err.message : String(err)}`)
		})
	}

	/**
	 * Seeds the octocode-gateway provider profile for users who have a cached auth token
	 * but no profile (e.g., users who signed in before OctoCode Gateway was added), or
	 * who have an empty/imported profile without a token.
	 * Called once per webview init; handleOctoCodeCallback is idempotent so repeated calls are safe.
	 */
	private async ensureOctoCodeGatewayProfileSeeded(): Promise<void> {
		const { getCachedOctoCodeToken, getOctoCodeBaseUrl } = await import("../../services/octocode-auth")
		const token = getCachedOctoCodeToken()
		if (!token) return
		const expectedGatewayBaseUrl = `${getOctoCodeBaseUrl()}/api/gateway/v1`

		// Check ALL octocode-gateway profiles — only skip seeding if every profile has the current token.
		// Using .find() would miss stale tokens in duplicate/renamed profiles since handleOctoCodeCallback
		// uses .filter() and updates all of them — the early-return guard must match.
		const allProfiles = await this.providerSettingsManager.listConfig()
		const octoCodeGatewayProfiles = allProfiles.filter((p) => p.apiProvider === providerIdentifiers.octoCodeGateway)

		if (octoCodeGatewayProfiles.length === 0) {
			this.log("[ensureOctoCodeGatewayProfileSeeded] No octocode-gateway profile found, creating one")
		} else {
			let allUpToDate = true

			for (const entry of octoCodeGatewayProfiles) {
				try {
					const fullProfile = await this.providerSettingsManager.getProfile({ name: entry.name })
					if (
						fullProfile.octoCodeSessionToken !== token ||
						fullProfile.octoCodeGatewayBaseUrl !== expectedGatewayBaseUrl
					) {
						allUpToDate = false
						this.log(
							"[ensureOctoCodeGatewayProfileSeeded] Existing octocode-gateway profile is stale, updating",
						)
						break
					}
				} catch {
					allUpToDate = false
					this.log("[ensureOctoCodeGatewayProfileSeeded] Failed to read existing profile, will re-seed")
					break
				}
			}

			if (allUpToDate) {
				const { postOctoCodeGatewayCredentialsReady } =
					await import("../../services/octocode-gateway-credentials-sync")
				postOctoCodeGatewayCredentialsReady((message) => this.postMessageToWebview(message))
				return
			}
		}

		// User has token but either no profile, some profiles without token, or stale tokens — seed all
		await this.handleOctoCodeCallback(token)
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		let localPort = "5173"

		try {
			const fs = require("fs")
			const path = require("path")
			const portFilePath = path.resolve(__dirname, "../../.vite-port")

			if (fs.existsSync(portFilePath)) {
				localPort = fs.readFileSync(portFilePath, "utf8").trim()
				console.log(`[ClineProvider:Vite] Using Vite server port from ${portFilePath}: ${localPort}`)
			} else {
				console.log(
					`[ClineProvider:Vite] Port file not found at ${portFilePath}, using default port: ${localPort}`,
				)
			}
		} catch (err) {
			console.error("[ClineProvider:Vite] Failed to read Vite port file:", err)
		}

		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			vscode.window.showErrorMessage(t("common:errors.hmr_not_running"))
			return this.getHtmlContent(webview)
		}

		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		const file = "src/index.tsx"
		const scriptUri = `http://${localServerUrl}/${file}`

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://localhost:${localPort}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com https://avatars.githubusercontent.com https://lh3.googleusercontent.com data:`,
			`media-src ${webview.cspSource}`,
			`script-src 'unsafe-eval' ${webview.cspSource} https://*.posthog.com http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} ${openRouterDomain} https://* https://*.posthog.com ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
					</script>
					<title>OctoCode</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private async getHtmlContent(webview: vscode.Webview): Promise<string> {
		// Get the local path to main script run in the webview,
		// then convert it to a uri we can use in the webview.

		// The CSS file from the React build output
		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.mjs",
		])
		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		// Use a nonce to only allow a specific script to be run.
		/*
		content security policy of your webview to only allow scripts that have a specific nonce
		create a content security policy meta tag so that only loading scripts with a nonce is allowed
		As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicitly allow for these resources. E.g.
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

		in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
		*/
		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com https://avatars.githubusercontent.com https://lh3.googleusercontent.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' 'strict-dynamic'; connect-src ${webview.cspSource} ${openRouterDomain} https://api.requesty.ai https://us.i.posthog.com;">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
			</script>
            <title>OctoCode</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		const onReceiveMessage = async (message: WebviewMessage) =>
			webviewMessageHandler(this, message, this.marketplaceManager)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 * @param targetTask The task whose in-memory mode should be updated. Defaults to the
	 * current task. Pass null to apply only global mode/profile effects for a pending child.
	 */
	public async handleModeSwitch(newMode: Mode) {
		return this.enqueueProviderProfileMutation((signal) => this.handleModeSwitchUnlocked(newMode, signal))
	}

	private async handleModeSwitchUnlocked(newMode: Mode, signal?: AbortSignal): Promise<void> {
		await this.updateGlobalState("mode", newMode)

		this.emit(RooCodeEventName.ModeChanged, newMode)

		// If workspace lock is on, keep the current API config — don't load mode-specific config
		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await this.postStateToWebview()
			return
		}

		if (signal?.aborted) return

		// Load the saved API config for the new mode if it exists.
		const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
		const listApiConfig = await this.providerSettingsManager.listConfig()

		if (signal?.aborted) return

		// Update listApiConfigMeta first to ensure UI has latest data.
		await this.updateGlobalState("listApiConfigMeta", listApiConfig)

		// If this mode has a saved config, use it.
		if (savedConfigId) {
			const profile = listApiConfig.find(({ id }) => id === savedConfigId)

			if (profile?.name) {
				// Check if the profile has actual API configuration (not just an id).
				// In CLI mode, the ProviderSettingsManager may return empty default profiles
				// that only contain 'id' and 'name' fields. Activating such a profile would
				// overwrite the CLI's working API configuration with empty settings.
				// Skip activation if the profile has no apiProvider set - this indicates
				// an unconfigured/empty profile.
				const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
				const hasActualSettings = !!fullProfile.apiProvider

				if (hasActualSettings) {
					await this.activateProviderProfileUnlocked({ name: profile.name }, undefined, signal)
				} else {
					// The task will continue with the current/default configuration.
				}
			} else {
				// The task will continue with the current/default configuration.
			}
		} else {
			// If no saved config for this mode, save current config as default.
			const currentApiConfigNameAfter = this.getGlobalState("currentApiConfigName")

			if (currentApiConfigNameAfter) {
				const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)

				if (config?.id) {
					await this.providerSettingsManager.setModeConfig(newMode, config.id)
				}
			}
		}

		await this.postStateToWebview()
	}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			return await this.enqueueProviderProfileMutation(async (signal) => {
				// TODO: Do we need to be calling `activateProfile`? It's not
				// clear to me what the source of truth should be; in some cases
				// we rely on the `ContextProxy`'s data store and in other cases
				// we rely on the `ProviderSettingsManager`'s data store. It might
				// be simpler to unify these two.
				const id = await this.providerSettingsManager.saveConfig(name, providerSettings)

				if (signal.aborted) return id

				if (activate) {
					const { mode } = await this.getState()

					// These promises do the following:
					// 1. Adds or updates the list of provider profiles.
					// 2. Sets the current provider profile.
					// 3. Sets the current mode's provider profile.
					// 4. Copies the provider settings to the context.
					//
					// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
					// this.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
					// We should probably switch to that and verify that it works.
					// I left the original implementation in just to be safe.
					await Promise.all([
						this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
						this.updateGlobalState("currentApiConfigName", name),
						this.providerSettingsManager.setModeConfig(mode, id),
						this.contextProxy.setProviderSettings(providerSettings),
					])
				} else {
					await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
				}

				await this.postStateToWebview()
				return id
			})
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.postStateToWebview()
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: {
			persistModeConfig?: boolean
			persistTaskHistory?: boolean
			skipCurrentTaskRebuild?: boolean
		},
	) {
		return this.enqueueProviderProfileMutation((signal) =>
			this.activateProviderProfileUnlocked(args, options, signal),
		)
	}

	/**
	 * Per-chat model identity. A chat that already runs on a session keeps its
	 * own profile in the Host store (`session-profile:<sessionId>`), so switching
	 * the model in one conversation never flips the profile every other
	 * conversation in the window reads from the global state.
	 */
	private static sessionProfileKey(sessionId: string): string {
		return `session-profile:${sessionId}`
	}

	async setSessionProfile(sessionId: string, args: { name: string } | { id: string }): Promise<void> {
		// Resolve read-only: activating the profile here would rewrite the global
		// currentApiConfigName in the profile store and flip the model that every
		// OTHER conversation and new chat reads — exactly the cross-chat leak this
		// per-chat scoping exists to prevent.
		let profileId: string | undefined
		try {
			const profile = await this.providerSettingsManager.getProfile(args)
			profileId = profile?.id
		} catch {
			profileId = undefined
		}
		if (!profileId) throw new Error("Profile has no stable identity; cannot scope it to a conversation")
		const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
		await getOctoCodeRuntime().call("setting.set", {
			key: ClineProvider.sessionProfileKey(sessionId),
			value: profileId,
		})
		await this.postStateToWebview()
	}

	async getSessionProfileId(sessionId: string): Promise<string | undefined> {
		const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
		const value = await getOctoCodeRuntime().call<string | null>("setting.get", {
			key: ClineProvider.sessionProfileKey(sessionId),
		})
		return typeof value === "string" && value ? value : undefined
	}

	/** The profile a session actually runs on: its override first, then the global pick. */
	async resolveSessionProfile(
		sessionId: string | undefined,
	): Promise<{ profileId?: string; settings?: ProviderSettings; name?: string }> {
		const overrideId = sessionId ? await this.getSessionProfileId(sessionId).catch(() => undefined) : undefined
		if (overrideId) {
			try {
				const profile = await this.providerSettingsManager.getProfile({ id: overrideId })
				return { profileId: profile.id, settings: profile, name: profile.name }
			} catch {
				// The override points at a deleted profile; fall through to the global pick.
			}
		}
		const name = this.contextProxy.getValues().currentApiConfigName
		if (!name) return {}
		try {
			const profile = await this.providerSettingsManager.getProfile({ name })
			return { profileId: profile.id, settings: profile, name: profile.name }
		} catch {
			return {}
		}
	}

	private async activateProviderProfileUnlocked(
		args: { name: string } | { id: string },
		options?: {
			persistModeConfig?: boolean
			persistTaskHistory?: boolean
			skipCurrentTaskRebuild?: boolean
		},
		signal?: AbortSignal,
	): Promise<void> {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		if (signal?.aborted) return

		const persistModeConfig = options?.persistModeConfig ?? true
		const skipCurrentTaskRebuild = options?.skipCurrentTaskRebuild ?? false

		if (!skipCurrentTaskRebuild) {
			// See `upsertProviderProfile` for a description of what this is doing.
			await Promise.all([
				this.contextProxy.setValue("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
				this.contextProxy.setValue("currentApiConfigName", name),
				this.contextProxy.setProviderSettings(providerSettings),
			])
		}

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.providerSettingsManager.setModeConfig(mode, id)
		}

		if (!skipCurrentTaskRebuild) {
			await this.postStateToWebview()
		}

		if (providerSettings.apiProvider && !skipCurrentTaskRebuild) {
			this.emit(RooCodeEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		const { getSystemToolDirectory } = await import("../../services/environments/tools")
		const systemRoot = getSystemToolDirectory("mcp")
		if (systemRoot) {
			await fs.mkdir(systemRoot, { recursive: true })
			return systemRoot
		}
		if (process.env.OCTOCODE_DATA) {
			const mcpServersDir = path.join(process.env.OCTOCODE_DATA, "mcp")
			await fs.mkdir(mcpServersDir, { recursive: true })
			return mcpServersDir
		}
		// Get platform-specific application data directory
		let mcpServersDir: string
		if (process.platform === "win32") {
			// Windows: %APPDATA%\Roo-Code\MCP
			mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "Roo-Code", "MCP")
		} else if (process.platform === "darwin") {
			// macOS: ~/Documents/Cline/MCP
			mcpServersDir = path.join(os.homedir(), "Documents", "Cline", "MCP")
		} else {
			// Linux: ~/.local/share/Cline/MCP
			mcpServersDir = path.join(os.homedir(), ".local", "share", "Roo-Code", "MCP")
		}

		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			// Fallback to a relative path if directory creation fails
			return path.join(os.homedir(), ".roo-code", "mcp")
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const { getSettingsDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		return getSettingsDirectoryPath(globalStoragePath)
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		const { apiConfiguration, currentApiConfigName = "default" } = await this.getState()

		let apiKey: string

		try {
			const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
			// Extract the base domain for the auth endpoint.
			const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"
			const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, { code })

			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			this.log(
				`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			throw error
		}

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "openrouter",
			openRouterApiKey: apiKey,
			openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
		}

		await this.upsertProviderProfile(currentApiConfigName, newConfiguration)
	}

	// OctoCode Auth

	async handleOctoCodeCallback(token: string) {
		// Auth mutation (token storage, subscription check, success toast) was already
		// performed by handleAuthCallback() in handleUri.ts before this method was called.
		// Save the octocode-gateway provider profile with the session token so that
		// OctoCodeGatewayHandler can authenticate without any manual user input.
		//
		// activate: true ONLY if OctoCode Gateway is already the active profile — this pushes
		// the new token to the in-memory handler so the current task picks it up immediately.
		// Otherwise activate: false — do NOT switch providers mid-conversation. The user
		// must explicitly select OctoCode Gateway in settings if they want to use it.
		try {
			const { apiConfiguration } = await this.getState()
			const currentSettings = this.contextProxy.getProviderSettings()
			const currentApiConfigName = this.contextProxy.getValues().currentApiConfigName

			// Derive the gateway base URL from OCTOCODE_BASE_URL so that non-prod environments
			// (staging, local dev) route completions to the correct backend instead of always
			// hard-coding production. An already-set value in the profile is NOT preserved here —
			// it must always align with the auth server the user just authenticated against.
			const { getOctoCodeBaseUrl } = await import("../../services/octocode-auth")
			const derivedGatewayBaseUrl = `${getOctoCodeBaseUrl()}/api/gateway/v1`

			// Check if OctoCode Gateway is the currently active profile by apiProvider identity,
			// not by profile name (profile names are user-renameable).
			const isOctoCodeGatewayActive = currentSettings.apiProvider === providerIdentifiers.octoCodeGateway

			// Always scan ALL profiles and update every octocode-gateway profile with the new token.
			// This ensures renamed profiles, duplicate profiles, and inactive profiles all stay
			// in sync. The model lookup in requestRouterModels uses .find() which returns the
			// first octocode-gateway profile it finds — if that profile has a stale token, requests fail.
			const allProfiles = await this.providerSettingsManager.listConfig()
			const zooProfiles = allProfiles.filter((p) => p.apiProvider === providerIdentifiers.octoCodeGateway)

			if (zooProfiles.length === 0) {
				// No existing octocode-gateway profile — create the canonical default.
				const newConfiguration: ProviderSettings = {
					apiProvider: "octocode-gateway",
					octoCodeSessionToken: token,
					octoCodeGatewayModelId: apiConfiguration.octoCodeGatewayModelId,
					octoCodeGatewayBaseUrl: derivedGatewayBaseUrl,
				}
				// Activate only if octocode-gateway was the active provider (shouldn't happen if
				// no profiles exist, but defensive).
				await this.upsertProviderProfile("OctoCode Gateway", newConfiguration, isOctoCodeGatewayActive)
			} else {
				// Update every existing octocode-gateway profile with the new token and the
				// derived base URL so that environment-specific routing stays consistent.
				for (const entry of zooProfiles) {
					const isActiveProfile = isOctoCodeGatewayActive && entry.name === currentApiConfigName
					const existing = await this.providerSettingsManager.getProfile({ name: entry.name })
					const updated: ProviderSettings = {
						...existing,
						octoCodeSessionToken: token,
						octoCodeGatewayBaseUrl: derivedGatewayBaseUrl,
					}
					if (isActiveProfile) {
						// Use upsertProviderProfile with activate: true so the in-memory handler
						// picks up the new token immediately for the current task.
						await this.upsertProviderProfile(entry.name, updated, true)
					} else {
						// Non-active profiles just need the token saved to disk.
						await this.providerSettingsManager.saveConfig(entry.name, updated)
					}
				}
			}
		} catch (error) {
			this.log(
				`[handleOctoCodeCallback] Failed to save octocode-gateway profile: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
		await this.postStateToWebview()
		const { postOctoCodeGatewayCredentialsReady } = await import("../../services/octocode-gateway-credentials-sync")
		postOctoCodeGatewayCredentialsReady((message) => this.postMessageToWebview(message))
	}

	// Requesty

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		const { apiConfiguration } = await this.getState()

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "requesty",
			requestyApiKey: code,
			requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
		}

		// set baseUrl as undefined if we don't provide one
		// or if it is the default requesty url
		if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
			newConfiguration.requestyBaseUrl = undefined
		} else {
			newConfiguration.requestyBaseUrl = baseUrl
		}

		const profileName = `Requesty (${new Date().toLocaleString()})`
		await this.upsertProviderProfile(profileName, newConfiguration)
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebview()
	}
	async postStateToWebview() {
		await this.postMessageToWebview({ type: "state", state: await this.getStateToPostToWebview() })
	}
	async postStateToWebviewWithoutTaskHistory() {
		await this.postStateToWebview()
	}
	async postStateToWebviewWithoutClineMessages() {
		await this.postStateToWebview()
	}

	/**
	 * Fetches marketplace data on demand to avoid blocking main state updates
	 */
	async fetchMarketplaceData() {
		try {
			const [marketplaceResult, marketplaceInstalledMetadata] = await Promise.all([
				this.marketplaceManager.getMarketplaceItems().catch((error) => {
					console.error("Failed to fetch marketplace items:", error)
					return { organizationMcps: [], marketplaceItems: [], errors: [error.message] }
				}),
				this.marketplaceManager.getInstallationMetadata().catch((error) => {
					console.error("Failed to fetch installation metadata:", error)
					return { project: {}, global: {} } as MarketplaceInstalledMetadata
				}),
			])

			// Send marketplace data separately
			await this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: marketplaceResult.organizationMcps || [],
				marketplaceItems: marketplaceResult.marketplaceItems || [],
				marketplaceInstalledMetadata: marketplaceInstalledMetadata || { project: {}, global: {} },
				errors: marketplaceResult.errors,
			})
		} catch (error) {
			console.error("Failed to fetch marketplace data:", error)

			// Send empty data on error to prevent UI from hanging
			await this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: [],
				marketplaceItems: [],
				marketplaceInstalledMetadata: { project: {}, global: {} },
				errors: [error instanceof Error ? error.message : String(error)],
			})

			// Show user-friendly error notification for network issues
			if (error instanceof Error && error.message.includes("timeout")) {
				vscode.window.showWarningMessage(
					"Marketplace data could not be loaded due to network restrictions. Core functionality remains available.",
				)
			}
		}
	}

	/**
	 * Merges allowed commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
	}

	/**
	 * Merges denied commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("deniedCommands", "denied", globalStateCommands)
	}

	/**
	 * Common utility for merging command lists from global state and workspace configuration.
	 * Implements the Command Denylist feature's merging strategy with proper validation.
	 *
	 * @param configKey - VSCode workspace configuration key
	 * @param commandType - Type of commands for error logging
	 * @param globalStateCommands - Commands from global state
	 * @returns Merged and deduplicated command list
	 */
	private mergeCommandLists(
		configKey: "allowedCommands" | "deniedCommands",
		commandType: "allowed" | "denied",
		globalStateCommands?: string[],
	): string[] {
		try {
			// Validate and sanitize global state commands
			const validGlobalCommands = Array.isArray(globalStateCommands)
				? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Get workspace configuration commands
			const workspaceCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>(configKey) || []

			// Validate and sanitize workspace commands
			const validWorkspaceCommands = Array.isArray(workspaceCommands)
				? workspaceCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			// Combine and deduplicate commands
			// Global state takes precedence over workspace configuration
			const mergedCommands = [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]

			return mergedCommands
		} catch (error) {
			console.error(`Error merging ${commandType} commands:`, error)
			// Return empty array as fallback to prevent crashes
			return []
		}
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected,
			alwaysAllowExecute,
			destructiveCommandGuardEnabled,
			allowedCommands,
			deniedCommands,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext,
			autoCondenseContextPercent,
			soundEnabled,
			ttsEnabled,
			ttsSpeed,
			enableCheckpoints,
			checkpointTimeout,
			soundVolume,
			writeDelayMs,
			diffFuzzyThreshold,
			terminalShellIntegrationTimeout,
			terminalShellIntegrationDisabled,
			terminalCommandDelay,
			terminalPowershellCounter,
			terminalZshClearEolMark,
			terminalZshOhMy,
			terminalZshP10k,
			terminalZdotdir,
			terminalProfile,
			mcpEnabled,
			currentApiConfigName,
			listApiConfigMeta,
			pinnedApiConfigs,
			mode,
			customModePrompts,
			customSupportPrompts,
			enhancementApiConfigId,
			autoApprovalEnabled,
			permissionProfile,
			customModes,
			experiments,
			maxOpenTabsContext,
			maxWorkspaceFiles,
			disabledTools,
			telemetrySetting,
			showRooIgnoredFiles,
			enableSubfolderRules,
			language,
			maxImageFileSize,
			maxTotalImageSize,
			historyPreviewCollapsed,
			reasoningBlockCollapsed,
			chatFontSize,
			enterBehavior,
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexConfig,
			codebaseIndexModels,
			profileThresholds,
			alwaysAllowFollowupQuestions,
			followupAutoApproveTimeoutMs,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			includeTaskHistoryInEnhance,
			includeCurrentTime,
			includeCurrentCost,
			maxGitStatusFiles,
			taskSyncEnabled,
			lockApiConfigAcrossModes,
			autoCloseOctoCodeOpenedFiles,
			autoCloseOctoCodeOpenedFilesAfterUserEdited,
			autoCloseOctoCodeOpenedNewFiles,
		} = await this.getState()

		// The per-chat model override must NOT rewrite the shared state fields:
		// the settings screen and every other consumer read the global profile
		// from here, and a session-scoped value leaking into them made the
		// settings screen flag phantom edits ("discard changes?" on navigation).
		// The override travels as its own field; the chat composer consumes it.
		const sessionProfile = ClineProvider.activeRuntimeSessionId
			? await this.resolveSessionProfile(ClineProvider.activeRuntimeSessionId)
			: undefined

		let cloudOrganizations: CloudOrganizationMembership[] = []

		try {
			if (!CloudService.instance.isCloudAgent) {
				const now = Date.now()

				if (
					this.cloudOrganizationsCache !== null &&
					this.cloudOrganizationsCacheTimestamp !== null &&
					now - this.cloudOrganizationsCacheTimestamp < ClineProvider.CLOUD_ORGANIZATIONS_CACHE_DURATION_MS
				) {
					cloudOrganizations = this.cloudOrganizationsCache!
				} else {
					cloudOrganizations = await CloudService.instance.getOrganizationMemberships()
					this.cloudOrganizationsCache = cloudOrganizations
					this.cloudOrganizationsCacheTimestamp = now
				}
			}
		} catch (error) {
			// Ignore this error.
		}

		const telemetryKey = process.env.POSTHOG_API_KEY
		const machineId = vscode.env.machineId
		const mergedAllowedCommands = this.mergeAllowedCommands(allowedCommands)
		const mergedDeniedCommands = this.mergeDeniedCommands(deniedCommands)
		const cwd = this.cwd
		let octoCodeState: {
			octoCodeIsAuthenticated: boolean
			octoCodeUserName: string | undefined
			octoCodeUserEmail: string | undefined
			octoCodeUserImage: string | undefined
			octoCodeBaseUrl: string
			deviceName: string
			osUserName: string
		} = {
			octoCodeIsAuthenticated: false,
			octoCodeUserName: undefined,
			octoCodeUserEmail: undefined,
			octoCodeUserImage: undefined,
			octoCodeBaseUrl: "https://www.octocode.dev",
			deviceName: os.hostname(),
			osUserName: currentOsUserName(),
		}

		try {
			const { isOctoCodeAuthenticated, getCachedOctoCodeUserInfo, getOctoCodeBaseUrl } =
				await import("../../services/octocode-auth")
			const userInfo = getCachedOctoCodeUserInfo()
			octoCodeState = {
				octoCodeIsAuthenticated: await isOctoCodeAuthenticated(),
				octoCodeUserName: userInfo.name,
				octoCodeUserEmail: userInfo.email,
				octoCodeUserImage: userInfo.image,
				octoCodeBaseUrl: getOctoCodeBaseUrl(),
				deviceName: os.hostname(),
				osUserName: currentOsUserName(),
			}
		} catch {
			// Keep the default unauthenticated state if the optional OctoCode auth service is unavailable.
		}

		let desktop: { version?: string; commit?: string } | undefined
		try {
			desktop = JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"))
		} catch {
			// An extension running outside the packaged desktop has no product metadata.
		}
		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			desktopVersion: desktop?.version,
			desktopCommit: desktop?.commit,
			apiConfiguration,
			customInstructions,
			alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: alwaysAllowExecute ?? false,
			destructiveCommandGuardEnabled,
			alwaysAllowMcp: alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: alwaysAllowSubtasks ?? false,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext: autoCondenseContext ?? true,
			autoCondenseContextPercent: autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
			uriScheme: vscode.env.uriScheme,
			soundEnabled: soundEnabled ?? false,
			ttsEnabled: ttsEnabled ?? false,
			ttsSpeed: ttsSpeed ?? 1.0,
			enableCheckpoints: enableCheckpoints ?? true,
			checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			shouldShowAnnouncement:
				telemetrySetting !== "unset" && lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands: mergedAllowedCommands,
			deniedCommands: mergedDeniedCommands,
			soundVolume: soundVolume ?? 0.5,
			writeDelayMs: writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			diffFuzzyThreshold: diffFuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD,
			terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: terminalCommandDelay ?? 0,
			terminalPowershellCounter: terminalPowershellCounter ?? false,
			terminalZshClearEolMark: terminalZshClearEolMark ?? true,
			terminalZshOhMy: terminalZshOhMy ?? false,
			terminalZshP10k: terminalZshP10k ?? false,
			terminalZdotdir: terminalZdotdir ?? false,
			terminalProfile,
			mcpEnabled: mcpEnabled ?? true,
			currentApiConfigName: currentApiConfigName ?? "default",
			sessionApiConfigName: sessionProfile?.name,
			sessionApiConfiguration: sessionProfile?.settings,
			listApiConfigMeta: listApiConfigMeta ?? [],
			pinnedApiConfigs: pinnedApiConfigs ?? {},
			mode: mode ?? defaultModeSlug,
			customModePrompts: customModePrompts ?? {},
			customSupportPrompts: customSupportPrompts ?? {},
			enhancementApiConfigId,
			autoApprovalEnabled: autoApprovalEnabled ?? false,
			permissionProfile: permissionProfile ?? "full",
			customModes,
			experiments: experiments ?? experimentDefault,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			maxOpenTabsContext: maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: maxWorkspaceFiles ?? 200,
			cwd,
			codeIndexWorkspacePath: this.codeIndexWorkspacePath,
			disabledTools,
			telemetrySetting,
			telemetryKey,
			machineId,
			showRooIgnoredFiles: showRooIgnoredFiles ?? false,
			enableSubfolderRules: enableSubfolderRules ?? false,
			language: language ?? DEFAULT_LANGUAGE,
			renderContext: this.renderContext,
			maxImageFileSize: maxImageFileSize ?? 5,
			maxTotalImageSize: maxTotalImageSize ?? 20,
			settingsImportedAt: this.settingsImportedAt,
			historyPreviewCollapsed: historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
			chatFontSize,
			enterBehavior: enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated: cloudIsAuthenticated ?? false,
			cloudAuthSkipModel: this.context.globalState.get<boolean>("roo-auth-skip-model") ?? false,
			cloudOrganizations,
			sharingEnabled: sharingEnabled ?? false,
			publicSharingEnabled: publicSharingEnabled ?? false,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt,
			codebaseIndexModels: codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl: codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider: codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension: codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider: codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			// Phase 1 cloud removal: do not let Cloud-auth MDM enforcement force login-only UI flows.
			mdmCompliant: undefined,
			profileThresholds: profileThresholds ?? {},
			cloudApiUrl: getRooCodeApiUrl(),
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
			lockApiConfigAcrossModes: lockApiConfigAcrossModes ?? false,
			alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: followupAutoApproveTimeoutMs ?? 60000,
			includeDiagnosticMessages: includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: includeCurrentTime ?? true,
			includeCurrentCost: includeCurrentCost ?? true,
			maxGitStatusFiles: maxGitStatusFiles ?? 0,
			taskSyncEnabled,
			autoCloseOctoCodeOpenedFiles: autoCloseOctoCodeOpenedFiles ?? DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES,
			autoCloseOctoCodeOpenedFilesAfterUserEdited:
				autoCloseOctoCodeOpenedFilesAfterUserEdited ??
				DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES_AFTER_USER_EDITED,
			autoCloseOctoCodeOpenedNewFiles:
				autoCloseOctoCodeOpenedNewFiles ?? DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_NEW_FILES,
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			kimiCodeIsAuthenticated: await (async () => {
				try {
					const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
					return await kimiCodeOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			kimiCodeOAuthState: await (async () => {
				try {
					const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
					return kimiCodeOAuthManager.getState()
				} catch {
					return undefined
				}
			})(),
			...octoCodeState,
			platform: process.platform,
			arch: process.arch,
			debug: vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false),
		}
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<
		Omit<
			ExtensionState,
			"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
		>
	> {
		const stateValues = this.contextProxy.getValues()
		const customModes = await this.customModesManager.getCustomModes()

		/*
		 * No provider until someone names one.
		 *
		 * This used to fall back to Anthropic whenever the setting was empty, which
		 * made an unconfigured install look configured: the UI showed a provider the
		 * user had never chosen, and calls failed against credentials that were
		 * never entered. Undefined is the honest answer, and the surfaces that read
		 * this already handle it — they show the provider settings instead.
		 */
		const apiProvider: ProviderName | undefined =
			stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider) ? stateValues.apiProvider : undefined

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		if (!providerSettings.apiProvider && apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		let organizationAllowList = ORGANIZATION_ALLOW_ALL
		let cloudUserInfo: CloudUserInfo | null = null
		let cloudIsAuthenticated: boolean = false

		if (CloudService.hasInstance()) {
			try {
				organizationAllowList = await CloudService.instance.getAllowList()
			} catch (error) {
				console.error(
					`[getState] failed to get organization allow list: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			try {
				cloudUserInfo = CloudService.instance.getUserInfo()
			} catch (error) {
				console.error(
					`[getState] failed to get cloud user info: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			try {
				cloudIsAuthenticated = CloudService.instance.isAuthenticated()
			} catch (error) {
				console.error(
					`[getState] failed to get cloud authentication state: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		const sharingEnabled: boolean = false

		const publicSharingEnabled: boolean = false

		let organizationSettingsVersion: number = -1

		try {
			if (CloudService.hasInstance()) {
				const settings = CloudService.instance.getOrganizationSettings()
				organizationSettingsVersion = settings?.version ?? -1
			}
		} catch (error) {
			console.error(
				`[getState] failed to get organization settings version: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		const taskSyncEnabled: boolean = false

		// Return the same structure as before.
		return {
			apiConfiguration: providerSettings,
			lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
			customInstructions: stateValues.customInstructions,
			apiModelId: stateValues.apiModelId,
			alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
			destructiveCommandGuardEnabled:
				stateValues.destructiveCommandGuardEnabled ?? DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
			alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: stateValues.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
			alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
			diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
			allowedMaxRequests: stateValues.allowedMaxRequests,
			allowedMaxCost: stateValues.allowedMaxCost,
			autoCondenseContext: stateValues.autoCondenseContext ?? true,
			autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
			allowedCommands: stateValues.allowedCommands,
			deniedCommands: stateValues.deniedCommands,
			soundEnabled: stateValues.soundEnabled ?? false,
			ttsEnabled: stateValues.ttsEnabled ?? false,
			ttsSpeed: stateValues.ttsSpeed ?? 1.0,
			enableCheckpoints: stateValues.enableCheckpoints ?? true,
			checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			diffFuzzyThreshold: stateValues.diffFuzzyThreshold ?? DEFAULT_DIFF_FUZZY_THRESHOLD,
			terminalShellIntegrationTimeout:
				stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
			terminalPowershellCounter: stateValues.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: stateValues.terminalZshClearEolMark ?? true,
			terminalZshOhMy: stateValues.terminalZshOhMy ?? false,
			terminalZshP10k: stateValues.terminalZshP10k ?? false,
			terminalZdotdir: stateValues.terminalZdotdir ?? false,
			terminalProfile: stateValues.terminalProfile,
			mode: stateValues.mode ?? defaultModeSlug,
			language: stateValues.language ?? DEFAULT_LANGUAGE,
			mcpEnabled: stateValues.mcpEnabled ?? true,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			currentApiConfigName: stateValues.currentApiConfigName ?? "default",
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
			modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
			customModePrompts: stateValues.customModePrompts ?? {},
			customSupportPrompts: stateValues.customSupportPrompts ?? {},
			enhancementApiConfigId: stateValues.enhancementApiConfigId,
			experiments: stateValues.experiments ?? experimentDefault,
			autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
			customModes,
			maxOpenTabsContext: stateValues.maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? 200,
			disabledTools: stateValues.disabledTools,
			telemetrySetting: stateValues.telemetrySetting || "disabled",
			showRooIgnoredFiles: stateValues.showRooIgnoredFiles ?? false,
			enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
			maxImageFileSize: stateValues.maxImageFileSize ?? 5,
			maxTotalImageSize: stateValues.maxTotalImageSize ?? 20,
			historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
			chatFontSize: stateValues.chatFontSize,
			enterBehavior: stateValues.enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt: stateValues.customCondensingPrompt,
			codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: stateValues.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: stateValues.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			taskSyncEnabled,
			autoCloseOctoCodeOpenedFiles: stateValues.autoCloseOctoCodeOpenedFiles,
			autoCloseOctoCodeOpenedFilesAfterUserEdited: stateValues.autoCloseOctoCodeOpenedFilesAfterUserEdited,
			autoCloseOctoCodeOpenedNewFiles: stateValues.autoCloseOctoCodeOpenedNewFiles,
		}
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof RooCodeSettings>(key: K, value: RooCodeSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof RooCodeSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: RooCodeSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		// Log out from cloud if authenticated
		if (CloudService.hasInstance()) {
			try {
				await CloudService.instance.logout()
			} catch (error) {
				this.log(
					`Failed to logout from cloud during reset: ${error instanceof Error ? error.message : String(error)}`,
				)
				// Continue with reset even if logout fails
			}
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.evictCurrentTask()
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		this.outputChannel.appendLine(message)
		console.log(message)
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	public getMcpHub(): McpHub | undefined {
		return this.mcpHub
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Check if the current state is compliant with MDM policy
	 * @returns true if compliant or no MDM policy exists, false if MDM policy exists and user is non-compliant
	 */
	public checkMdmCompliance(): boolean {
		if (!this.mdmService) {
			return true // No MDM service, allow operation
		}

		const compliance = this.mdmService.isCompliant()

		if (!compliance.compliant) {
			return false
		}

		return true
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		const directory = this.codeIndexWorkspacePath
		return directory ? CodeIndexManager.getInstance(this.context, directory) : undefined
	}

	public get codeIndexWorkspacePath(): string | undefined {
		const directory = ClineProvider.activeRuntimeSessionId
			? ClineProvider.activeRuntimeWorkingDirectory
			: getWorkspacePath()
		if (!directory) return undefined
		try {
			// Match the manager's canonical path before applying workspace ownership checks in the UI.
			return realpathSync.native(directory)
		} catch {
			return directory
		}
	}

	private static syncCodeIndexSelection(): void {
		for (const provider of this.activeInstances) {
			if (provider._disposed || !provider.view) continue
			provider.updateCodeIndexStatusSubscription()
			provider.trackCodeIndexWork(provider.postStateToWebview())
		}
	}

	private trackCodeIndexWork(work: Promise<unknown>): void {
		const settled = work
			.then(() => undefined)
			.catch((error) => {
				if (!this._disposed) this.log(`Failed to synchronize code index: ${String(error)}`)
			})
		this.pendingCodeIndexWork.add(settled)
		void settled.finally(() => this.pendingCodeIndexWork.delete(settled))
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	private updateCodeIndexStatusSubscription(): void {
		// Get the current workspace manager
		const currentManager = this.getCurrentWorkspaceCodeIndexManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.codeIndexManager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.codeIndexStatusSubscription) {
			this.codeIndexStatusSubscription.dispose()
			this.codeIndexStatusSubscription = undefined
		}

		// Update the current workspace manager reference
		this.codeIndexManager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.trackCodeIndexWork(currentManager.initialize(this.contextProxy))
			this.codeIndexStatusSubscription = currentManager.onProgressUpdate((update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.getCurrentWorkspaceCodeIndexManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					const fullStatus = currentManager.getCurrentStatus()
					void this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			void this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}
	private logWebviewHiddenDiagnostics(): void {
		if (ClineProvider.activeRuntimeTaskId) this.log("OctoCode task continues while its view is hidden")
	}

	public async startRuntimeTask(
		text: string,
		images: string[] = [],
		requestedSessionId?: string,
		configuration: RooCodeSettings = {},
		projectId?: string,
		isCurrent?: () => boolean,
		attachmentPaths?: string[],
	) {
		assertOctoCodeAuthenticationAllowed()
		await ClineProvider.applyTaskConfiguration(this, configuration)
		const { apiConfiguration, permissionProfile } = await this.getStateToPostToWebview()
		const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
		const runtime = getOctoCodeRuntime()
		let task: Awaited<ReturnType<typeof runtime.prepareTask>> | undefined
		try {
			task = await runtime.prepareTask(text, apiConfiguration, requestedSessionId, undefined, images, projectId)
			// Attachments become full-file copies inside the session directory
			// (the agent's cwd) before the agent starts; the prompt only names them.
			// A copy failure must not discard the user's turn: degrade to sending
			// without the attachments and tell the user, instead of throwing away
			// the message (it is not persisted anywhere else at this point).
			const { prepareAttachmentPrompt } = await import("../../services/octocode-runtime/attachments")
			if (task.workingDirectory && attachmentPaths?.length) {
				try {
					text = await prepareAttachmentPrompt(attachmentPaths, task.workingDirectory, text)
				} catch (error) {
					vscode.window.showWarningMessage(
						`附件复制失败，本次发送未包含附件：${error instanceof Error ? error.message : String(error)}`,
					)
				}
			} else if (attachmentPaths?.length) {
				vscode.window.showWarningMessage("会话工作目录不可用，本次发送未包含附件")
			}
			if (isCurrent && !isCurrent()) {
				await runtime.transitionTask(task, "cancelled")
				return { sessionId: task.sessionId, taskId: task.taskId }
			}
			ClineProvider.setActiveRuntimeSession(task.sessionId, task.taskId, task.workingDirectory)
			await this.postMessageToWebview({
				type: "runtimeTaskStarted",
				payload: { sessionId: task.sessionId, taskId: task.taskId, prompt: text, images },
			})
			if (isCurrent && !isCurrent()) {
				await runtime.transitionTask(task, "cancelled")
				return { sessionId: task.sessionId, taskId: task.taskId }
			}
			await runtime.runPreparedAgentTask(task, text, images, false, permissionProfile ?? "full")
			return { sessionId: task.sessionId, taskId: task.taskId }
		} catch (error) {
			if (task) await this.reportRuntimeFailure(task, error)
			else await this.postMessageToWebview({ type: "runtimeTaskFailed", payload: { resetSession: true } })
			throw error
		}
	}

	public async rolloverRuntimeSession(
		sourceSessionId: string,
		allowCompleted = false,
		requestedSourceTask?: RuntimeTask,
	): Promise<boolean> {
		const activeAtEntry = ClineProvider.getActiveRuntimeTask()
		const requested = requestedSourceTask ?? activeAtEntry
		const sourceTask =
			requested?.sessionId === sourceSessionId && typeof requested.taskId === "string" && requested.taskId
				? { sessionId: requested.sessionId, taskId: requested.taskId }
				: undefined
		const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
		const runtime = getOctoCodeRuntime()
		let handoff: Awaited<ReturnType<typeof runtime.prepareHandoff>>
		const notify = async (kind: string, payload: Record<string, unknown>, targetTask?: RuntimeTask) => {
			for (const instance of ClineProvider.getAllInstances()) {
				await instance.postMessageToWebview({
					type: "agentEvent",
					runtimeHandoff: { source: sourceTask, target: targetTask },
					payload: {
						task_id: sourceTask?.taskId ?? sourceSessionId,
						session_id: sourceSessionId,
						kind,
						payload,
					},
				})
			}
		}
		await notify("runtime.rollover_started", {})
		try {
			const task = await runtime.prepareHandoff(sourceSessionId, allowCompleted)
			if (!task) {
				await notify("runtime.rollover_aborted", {})
				return false
			}
			handoff = task
			await runtime.runPreparedAgentTask(task, task.prompt, task.images, false, task.permissionProfile)
			const currentActiveTask = ClineProvider.getActiveRuntimeTask()
			if (
				sourceTask &&
				activeAtEntry?.sessionId === sourceTask.sessionId &&
				activeAtEntry.taskId === sourceTask.taskId &&
				currentActiveTask?.sessionId === sourceTask.sessionId &&
				currentActiveTask.taskId === sourceTask.taskId
			) {
				ClineProvider.setActiveRuntimeSession(task.sessionId, task.taskId, task.workingDirectory)
			}
			const targetTask = { sessionId: task.sessionId, taskId: task.taskId }
			await notify("runtime.rollover_ready", { newSessionId: task.sessionId }, targetTask)
			for (const instance of ClineProvider.getAllInstances()) {
				await instance.postMessageToWebview({
					type: "runtimeTaskStarted",
					runtimeHandoff: { source: sourceTask, target: targetTask },
					payload: {
						sessionId: task.sessionId,
						taskId: task.taskId,
						prompt: task.displayPrompt,
						images: task.images,
					},
				})
			}
			return true
		} catch (error) {
			if (handoff) {
				try {
					const target = await runtime.call<{ status: string } | null>("session.get", {
						id: handoff.sessionId,
					})
					if (target && ["prepared", "failed"].includes(target.status)) {
						if (!(await hasRuntimeEvent(runtime, handoff.sessionId, "agent.started"))) {
							const result = await runtime.call<{ deleted: boolean }>("session.delete", {
								id: handoff.sessionId,
								expected_unstarted_task: handoff.taskId,
							})
							if (result?.deleted !== true) throw new Error("Guarded handoff cleanup refused")
						}
					}
				} catch (cleanupError) {
					this.log(`OctoCode handoff cleanup failed: ${String(cleanupError)}`)
				}
			}
			await notify("runtime.rollover_failed", { message: error instanceof Error ? error.message : String(error) })
			throw error
		}
	}

	public async reportRuntimeFailure(task: { sessionId: string; taskId: string }, error: unknown): Promise<void> {
		await this.postMessageToWebview({
			type: "agentEvent",
			payload: {
				task_id: task.taskId,
				session_id: task.sessionId,
				kind: "agent.error",
				payload: { message: error instanceof Error ? error.message : String(error) },
			},
		})
	}

	public async cancelRuntimeTask(): Promise<boolean> {
		if (!ClineProvider.activeRuntimeTaskId) return false
		const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
		const cancelled = await getOctoCodeRuntime().cancelTask(ClineProvider.activeRuntimeTaskId)
		ClineProvider.activeRuntimeTaskId = undefined
		ClineProvider.activeRuntimeSessionId = undefined
		ClineProvider.activeRuntimeWorkingDirectory = undefined
		ClineProvider.syncCodeIndexSelection()
		runtimeEventTerminal.setActiveSession(undefined)
		return cancelled
	}

	private static async applyTaskConfiguration(
		provider: ClineProvider,
		configuration: RooCodeSettings,
	): Promise<void> {
		await provider.setValues(configuration)
		const settings = vscode.workspace.getConfiguration(Package.name)
		if (configuration.allowedCommands) {
			await settings.update("allowedCommands", configuration.allowedCommands, vscode.ConfigurationTarget.Global)
		}
		if (configuration.deniedCommands) {
			await settings.update("deniedCommands", configuration.deniedCommands, vscode.ConfigurationTarget.Global)
		}
		if (configuration.commandExecutionTimeout !== undefined) {
			await settings.update(
				"commandExecutionTimeout",
				configuration.commandExecutionTimeout,
				vscode.ConfigurationTarget.Global,
			)
		}
		if (configuration.currentApiConfigName) {
			await provider.setProviderProfile(configuration.currentApiConfigName)
		}
		for (const mode of configuration.customModes ?? []) {
			await provider.customModesManager.updateCustomMode(mode.slug, mode)
		}
	}
	public async cancelTask(): Promise<void> {
		await this.cancelRuntimeTask()
	}
	public async clearTask(): Promise<void> {
		await this.evictCurrentTask()
		await this.postStateToWebview()
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		try {
			const customModes = await this.customModesManager.getCustomModes()
			return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
		} catch (error) {
			return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
		}
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	// Telemetry

	private _appProperties?: StaticAppProperties
	private _gitProperties?: GitProperties

	private getAppProperties(): StaticAppProperties {
		if (!this._appProperties) {
			const packageJSON = this.context.extension?.packageJSON

			this._appProperties = {
				appName: packageJSON?.name ?? Package.name,
				appVersion: packageJSON?.version ?? Package.version,
				releaseChannel: Package.releaseChannel,
				vscodeVersion: vscode.version,
				platform: process.platform,
				editorName: vscode.env.appName,
			}
		}

		return this._appProperties
	}

	public get appProperties(): StaticAppProperties {
		return this._appProperties ?? this.getAppProperties()
	}

	private getCloudProperties(): CloudAppProperties {
		let cloudIsAuthenticated: boolean | undefined

		try {
			if (CloudService.hasInstance()) {
				cloudIsAuthenticated = CloudService.instance.isAuthenticated()
			}
		} catch (error) {
			// Silently handle errors to avoid breaking telemetry collection.
			this.log(`[getTelemetryProperties] Failed to get cloud auth state: ${error}`)
		}

		return {
			cloudIsAuthenticated,
		}
	}
	private async getTaskProperties(): Promise<DynamicAppProperties & TaskProperties> {
		const { language = "en", mode, apiConfiguration } = await this.getState()
		const apiProvider = apiConfiguration?.apiProvider
		return {
			language,
			mode,
			taskId: ClineProvider.activeRuntimeSessionId,
			apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId: getModelId(apiConfiguration),
		}
	}

	private async getGitProperties(): Promise<GitProperties> {
		if (!this._gitProperties) {
			this._gitProperties = await getWorkspaceGitInfo()
		}

		return this._gitProperties
	}

	public get gitProperties(): GitProperties | undefined {
		return this._gitProperties
	}

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		return {
			...this.getAppProperties(),
			...this.getCloudProperties(),
			...(await this.getTaskProperties()),
			...(await this.getGitProperties()),
		}
	}

	public get cwd() {
		return getWorkspacePath()
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			const error = new Error("No webview available for URI conversion")
			console.error(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				console.error("Invalid file path provided for URI conversion:", error)
			} else {
				console.error("Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}

	public async showArtifact(
		filePath: string,
		line = 1,
		column = 1,
		sessionId = ClineProvider.activeRuntimeSessionId ?? "",
	): Promise<void> {
		if (sessionId !== (ClineProvider.activeRuntimeSessionId ?? "")) return
		const extension = path.extname(filePath).slice(1).toLowerCase()
		const mediaKinds: Record<string, "audio" | "image" | "model" | "pdf" | "video"> = {
			flac: "audio",
			glb: "model",
			gltf: "model",
			jpeg: "image",
			jpg: "image",
			m4a: "audio",
			mov: "video",
			mp3: "audio",
			mp4: "video",
			ogg: "audio",
			pdf: "pdf",
			png: "image",
			svg: "image",
			wav: "audio",
			webm: "video",
			webp: "image",
		}
		const kind = mediaKinds[extension]
		if (kind) {
			this.allowWebviewResource(filePath)
			if (this.view && "reveal" in this.view) this.view.reveal(vscode.ViewColumn.Two, true)
			const artifact: ExtensionMessage = {
				type: "artifactSelected",
				text: sessionId,
				payload: { kind, path: filePath, uri: this.convertToWebviewUri(filePath) },
			}
			this.artifactsBySession.set(sessionId, artifact)
			if (sessionId === (ClineProvider.activeRuntimeSessionId ?? "")) await this.postMessageToWebview(artifact)
			return
		}
		if (getSupportedBinaryFormats().includes(`.${extension}`)) {
			const artifact: ExtensionMessage = {
				type: "artifactSelected",
				text: sessionId,
				payload: { kind: "code", path: filePath, content: await extractTextFromFile(filePath) },
			}
			this.artifactsBySession.set(sessionId, artifact)
			if (sessionId === (ClineProvider.activeRuntimeSessionId ?? "")) await this.postMessageToWebview(artifact)
			return
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
		if (sessionId !== (ClineProvider.activeRuntimeSessionId ?? "")) return
		await vscode.window.showTextDocument(document, {
			preview: false,
			selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1),
			viewColumn: vscode.ViewColumn.Two,
		})
	}

	public async replayCurrentArtifact(): Promise<void> {
		await this.postMessageToWebview(
			this.artifactsBySession.get(ClineProvider.activeRuntimeSessionId ?? "") ?? {
				type: "artifactSelected",
				text: ClineProvider.activeRuntimeSessionId ?? "",
			},
		)
	}

	public async showLogsInTerminal(records: unknown[], category: "system" | "developer"): Promise<boolean> {
		let channel = this.logChannels.get(category)
		if (!channel) {
			channel = vscode.window.createOutputChannel(
				category === "system" ? "OctoCode 系统日志" : "OctoCode 开发日志",
			)
			this.logChannels.set(category, channel)
			this.disposables.push(channel)
		}
		channel.clear()
		for (const record of records) channel.appendLine(JSON.stringify(record))
		channel.show(true)
		return true
	}

	public allowWebviewResource(filePath: string): void {
		if (!this.view?.webview) return
		const options = this.view.webview.options
		const target = path.resolve(filePath)
		if (
			options.localResourceRoots?.some((root) => {
				const relative = path.relative(path.resolve(root.fsPath), target)
				return (
					relative === "" ||
					(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
				)
			})
		) {
			return
		}
		const directory = vscode.Uri.file(path.dirname(filePath))
		this.view.webview.options = {
			...options,
			localResourceRoots: [...(options.localResourceRoots ?? []), directory],
		}
	}
}
