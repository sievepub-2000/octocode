import * as vscode from "vscode"

import type { CommandId } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { ClineProvider } from "../core/webview/ClineProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { shellOwnsWindow } from "../utils/shellMode"
import { handleNewTask } from "./handleTask"
import { CodeIndexManager } from "../services/code-index/manager"
import { importSettingsWithFeedback } from "../core/config/importExport"
import { MdmService } from "../services/mdm/MdmService"
import { registerRipgrepDiagnosticCommand } from "../services/ripgrep/diagnostic"
import { t } from "../i18n"
import { applyOctoCodeWorkbenchLayout } from "./workbenchLayout"
import { runtimeEventTerminal } from "./runtimeEventTerminal"

/**
 * Helper to get the visible ClineProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ClineProvider | undefined {
	const visibleProvider = ClineProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible OctoCode instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined
let artifactPanel: vscode.WebviewPanel | undefined
let tabProvider: ClineProvider | undefined
let artifactProvider: ClineProvider | undefined
let openingWorkbench: Promise<ClineProvider> | undefined
let keepInitialWindows = true

function reopenWelcomePanel(
	panel: "chat" | "artifact",
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): void {
	if (!keepInitialWindows || panel !== "chat") return
	queueMicrotask(() => {
		if (!keepInitialWindows) return
		const reopen = panel === "chat" ? openChatPanel : openArtifactPanel
		void reopen({ context, outputChannel }).catch((error: unknown) =>
			outputChannel.appendLine(`[workbench] Failed to reopen ${panel} panel: ${error}`),
		)
	})
}

export function resetWorkbenchState(): void {
	sidebarPanel = undefined
	tabPanel = undefined
	artifactPanel = undefined
	tabProvider = undefined
	artifactProvider = undefined
	openingWorkbench = undefined
	runtimeEventTerminal.setOnDidClose(undefined)
	// The terminal is cached on its singleton, so leaving it behind would hand the
	// next test an instance it never created and cannot observe.
	runtimeEventTerminal.forget()
	keepInitialWindows = true
}

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ClineProvider
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context, outputChannel } = options
	const editorSettings = vscode.workspace.getConfiguration("workbench.editor")
	if (editorSettings.get<boolean>("closeEmptyGroups") !== true) {
		void editorSettings
			.update("closeEmptyGroups", true, vscode.ConfigurationTarget.Global)
			.then(undefined, (error: unknown) =>
				outputChannel.appendLine(`[workbench] Failed to enable closing empty editor groups: ${error}`),
			)
	}
	keepInitialWindows = true
	runtimeEventTerminal.setOnDidClose(undefined)
	context.subscriptions.push({
		dispose: () => {
			keepInitialWindows = false
			runtimeEventTerminal.setOnDidClose(undefined)
		},
	})

	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}

	context.subscriptions.push(registerRipgrepDiagnosticCommand())
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(ClineProvider.tabPanelId, {
			deserializeWebviewPanel: (panel) => restoreWorkbenchPanel(panel, "editor", context, outputChannel),
		}),
		vscode.window.registerWebviewPanelSerializer(ClineProvider.artifactPanelId, {
			deserializeWebviewPanel: (panel) => restoreWorkbenchPanel(panel, "artifact", context, outputChannel),
		}),
	)
}

async function restoreWorkbenchPanel(
	panel: vscode.WebviewPanel,
	renderContext: "editor" | "artifact",
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const existing = renderContext === "editor" ? tabPanel : artifactPanel
	if (existing && existing !== panel) {
		panel.dispose()
		return
	}
	await closeDuplicateWorkbenchTabs()
	const contextProxy = await ContextProxy.getInstance(context)
	let mdmService: MdmService | undefined
	try {
		mdmService = MdmService.getInstance()
	} catch {
		mdmService = undefined
	}
	const restored = renderContext === "editor" ? tabPanel : artifactPanel
	if (restored && restored !== panel) {
		panel.dispose()
		return
	}
	const provider = new ClineProvider(context, outputChannel, renderContext, contextProxy, mdmService)
	if (renderContext === "editor") {
		tabProvider = provider
		setPanel(panel, "tab")
		panel.onDidDispose(() => {
			if (tabPanel === panel) {
				tabPanel = undefined
				tabProvider = undefined
				reopenWelcomePanel("chat", context, outputChannel)
			}
		})
	} else {
		artifactProvider = provider
		artifactPanel = panel
		panel.title = t("common:ui.artifactPreview")
		panel.onDidDispose(() => {
			if (artifactPanel === panel) {
				artifactPanel = undefined
				artifactProvider = undefined
				reopenWelcomePanel("artifact", context, outputChannel)
			}
		})
	}
	await provider.resolveWebviewView(panel)
}

// `showRipgrepDiagnostic` is registered separately by
// `registerRipgrepDiagnosticCommand` (above), which owns the OutputChannel
// lifecycle alongside the command registration, so it's intentionally
// excluded from this map.
//
type CommandCallback = Parameters<typeof vscode.commands.registerCommand>[1]
const getCommandsMap = ({
	context,
	outputChannel,
	provider,
}: RegisterCommandOptions): Record<Exclude<CommandId, "showRipgrepDiagnostic">, CommandCallback> => ({
	activationCompleted: () => {},
	plusButtonClicked: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("plus")

		await visibleProvider.evictCurrentTask()
		await visibleProvider.refreshWorkspace()
		await visibleProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		// Send focusInput action immediately after chatButtonClicked
		// This ensures the focus happens after the view has switched
		await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
	},
	popoutButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("popout")

		return openClineInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openClineInNewTab({ context, outputChannel }),
	openChatPanel: () => openChatPanel({ context, outputChannel }),
	openArtifactPanel: () => openArtifactPanel({ context, outputChannel }),
	openBrowserPanel: () => openBrowserPanel(),
	openRuntimeTerminal: () => openRuntimeTerminal(),
	restoreWorkbenchLayout: async () => {
		await applyOctoCodeWorkbenchLayout(
			(command, ...args) => vscode.commands.executeCommand(command, ...args),
			shellOwnsWindow(),
			true,
		)
		return openClineInNewTab({ context, outputChannel })
	},
	/*
	 * Updates for the extension layer.
	 *
	 * Private releases use the user's GitHub login; custom channels are supported.
	 */
	checkForUpdate: async () => {
		const { UpdateService } = await import("../services/update/UpdateService")
		await new UpdateService(context, (message) => outputChannel.appendLine(message)).run(true)
	},
	recoverDesktopUpdate: async () => {
		const { UpdateService } = await import("../services/update/UpdateService")
		await new UpdateService(context, (message) => outputChannel.appendLine(message)).recoverDesktop()
	},
	settingsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		void visibleProvider
			.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
			.catch((error) => outputChannel.appendLine(`[settingsButtonClicked] postMessageToWebview failed: ${error}`))
		// Also explicitly post the visibility message to trigger scroll reliably
		void visibleProvider
			.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			.catch((error) => outputChannel.appendLine(`[settingsButtonClicked] postMessageToWebview failed: ${error}`))
	},
	marketplaceButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		void visibleProvider
			.postMessageToWebview({ type: "action", action: "marketplaceButtonClicked" })
			.catch((error) =>
				outputChannel.appendLine(`[marketplaceButtonClicked] postMessageToWebview failed: ${error}`),
			)
	},
	newTask: handleNewTask,
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	importSettings: async (filePath?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}

		await importSettingsWithFeedback(
			{
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
				customModesManager: visibleProvider.customModesManager,
				provider: visibleProvider,
			},
			filePath,
		)
	},
	focusInput: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)

			// Send focus input message only for sidebar panels
			if (sidebarPanel && getPanel() === sidebarPanel) {
				await provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	focusPanel: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)
		} catch (error) {
			outputChannel.appendLine(`Error focusing panel: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		void visibleProvider
			.postMessageToWebview({ type: "acceptInput" })
			.catch((error) => outputChannel.appendLine(`[acceptInput] postMessageToWebview failed: ${error}`))
	},
	toggleAutoApprove: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		try {
			await visibleProvider.postMessageToWebview({
				type: "action",
				action: "toggleAutoApprove",
			})
		} catch (error) {
			outputChannel.appendLine(`[toggleAutoApprove] postMessageToWebview failed: ${error}`)
		}
	},
})

async function providerDependencies(context: vscode.ExtensionContext): Promise<{
	contextProxy: ContextProxy
	mdmService: MdmService | undefined
}> {
	const contextProxy = await ContextProxy.getInstance(context)
	CodeIndexManager.getInstance(context)
	let mdmService: MdmService | undefined
	try {
		mdmService = MdmService.getInstance()
	} catch {
		mdmService = undefined
	}
	return { contextProxy, mdmService }
}

async function openChatPanel({
	context,
	outputChannel,
}: Omit<RegisterCommandOptions, "provider">): Promise<ClineProvider> {
	await applyOctoCodeWorkbenchLayout(
		(command, ...args) => vscode.commands.executeCommand(command, ...args),
		shellOwnsWindow(),
	)
	if (!tabPanel || !tabProvider) {
		const { contextProxy, mdmService } = await providerDependencies(context)
		if (tabPanel && tabProvider) {
			tabPanel.reveal(vscode.ViewColumn.One, true)
			return tabProvider
		}
		const provider = new ClineProvider(context, outputChannel, "editor", contextProxy, mdmService)
		const panel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "OctoCode", vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri],
		})
		panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
		}
		tabProvider = provider
		setPanel(panel, "tab")
		await provider.resolveWebviewView(panel)
		/*
		 * Announce only a genuine hidden -> visible transition.
		 *
		 * This event also fires when the panel merely stops being the *active*
		 * editor while staying on screen, which is what happens every time focus
		 * moves to a neighbouring group. The webview answers `didBecomeVisible` by
		 * focusing the chat box, so treating "still visible" as "became visible"
		 * made the conversation snatch focus straight back: selecting the terminal
		 * from the management rail put the caret in the terminal and then returned
		 * it to the chat, and the keystrokes that followed went to the wrong place.
		 * Observed on a running build.
		 */
		let wasVisible = panel.visible
		panel.onDidChangeViewState(
			({ webviewPanel }) => {
				const becameVisible = webviewPanel.visible && !wasVisible
				wasVisible = webviewPanel.visible
				if (becameVisible) void webviewPanel.webview.postMessage({ type: "action", action: "didBecomeVisible" })
			},
			null,
			context.subscriptions,
		)
		panel.onDidDispose(
			() => {
				if (tabPanel === panel) {
					tabPanel = undefined
					tabProvider = undefined
					reopenWelcomePanel("chat", context, outputChannel)
				}
			},
			null,
			context.subscriptions,
		)
	}
	tabPanel!.reveal(vscode.ViewColumn.One, true)
	return tabProvider!
}

async function openArtifactPanel({
	context,
	outputChannel,
}: Omit<RegisterCommandOptions, "provider">): Promise<ClineProvider> {
	await applyOctoCodeWorkbenchLayout(
		(command, ...args) => vscode.commands.executeCommand(command, ...args),
		shellOwnsWindow(),
	)
	if (!artifactPanel || !artifactProvider) {
		const { contextProxy, mdmService } = await providerDependencies(context)
		if (artifactPanel && artifactProvider) {
			artifactPanel.reveal(vscode.ViewColumn.Two, true)
			await runtimeEventTerminal.restorePosition()
			return artifactProvider
		}
		const provider = new ClineProvider(context, outputChannel, "artifact", contextProxy, mdmService)
		const panel = vscode.window.createWebviewPanel(
			ClineProvider.artifactPanelId,
			t("common:ui.artifactPreview"),
			vscode.ViewColumn.Two,
			{ enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [context.extensionUri] },
		)
		panel.iconPath = tabPanel?.iconPath ?? {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
		}
		artifactProvider = provider
		artifactPanel = panel
		await provider.resolveWebviewView(panel)
		panel.onDidDispose(
			() => {
				if (artifactPanel === panel) {
					artifactPanel = undefined
					artifactProvider = undefined
					reopenWelcomePanel("artifact", context, outputChannel)
				}
			},
			null,
			context.subscriptions,
		)
	}
	artifactPanel!.reveal(vscode.ViewColumn.Two, true)
	await runtimeEventTerminal.restorePosition()
	return artifactProvider!
}

async function openBrowserPanel(): Promise<void> {
	await applyOctoCodeWorkbenchLayout(
		(command, ...args) => vscode.commands.executeCommand(command, ...args),
		shellOwnsWindow(),
	)
	await vscode.commands.executeCommand("workbench.action.browser.open", {
		viewColumn: vscode.ViewColumn.Two,
		relocateExisting: true,
	})
	await runtimeEventTerminal.restorePosition()
}

async function closeDuplicateWorkbenchTabs(): Promise<void> {
	const supported = new Set([ClineProvider.tabPanelId, ClineProvider.artifactPanelId])
	const grouped = new Map<string, vscode.Tab[]>()
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const inputViewType = (tab.input as { viewType?: unknown } | undefined)?.viewType
			const viewType =
				typeof inputViewType === "string" && supported.has(inputViewType)
					? inputViewType
					: tab.label === "OctoCode"
						? ClineProvider.tabPanelId
						: ["多模态预览", "Artifact preview", t("common:ui.artifactPreview")].includes(tab.label)
							? ClineProvider.artifactPanelId
							: undefined
			if (!viewType) continue
			grouped.set(viewType, [...(grouped.get(viewType) ?? []), tab])
		}
	}
	const duplicates = [...grouped.values()].flatMap((tabs) => {
		const keep = tabs.find((tab) => tab.isActive) ?? tabs[0]
		return tabs.filter((tab) => tab !== keep)
	})
	if (duplicates.length) await vscode.window.tabGroups.close(duplicates)
}

async function openRuntimeTerminal(): Promise<void> {
	await applyOctoCodeWorkbenchLayout(
		(command, ...args) => vscode.commands.executeCommand(command, ...args),
		shellOwnsWindow(),
	)
	await runtimeEventTerminal.show()
}

const openWorkbench = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	/*
	 * The three-pane window, whether or not OctoCode draws its own chrome.
	 *
	 * The shell replaces the host's activity bar and side bar — not its editor
	 * grid. The grid is what puts the preview upper-right and the execution
	 * terminal directly below it; an earlier revision moved the terminal to the
	 * bottom panel instead, which stretched it across the whole window.
	 */
	await applyOctoCodeWorkbenchLayout(
		(command, ...args) => vscode.commands.executeCommand(command, ...args),
		shellOwnsWindow(),
	)
	await closeDuplicateWorkbenchTabs()
	const provider = await openChatPanel({ context, outputChannel })
	await openArtifactPanel({ context, outputChannel })
	await openBrowserPanel()
	await runtimeEventTerminal.show()
	await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup")
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")
	return provider
}

export const openClineInNewTab = (options: Omit<RegisterCommandOptions, "provider">): Promise<ClineProvider> => {
	openingWorkbench ??= openWorkbench(options).finally(() => {
		openingWorkbench = undefined
	})
	return openingWorkbench
}
