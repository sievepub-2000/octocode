import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { readEventPages } from "./runtimeHistory"
import { getGlobalRooDirectory } from "../../services/roo-config/index.js"
import { safeWriteJson } from "../../utils/safeWriteJson"

import { CloudService } from "@roo-code/cloud"
import { TelemetryService } from "@roo-code/telemetry"
import {
	type EditQueuedMessagePayload,
	type ExtensionRequest,
	ExperimentId,
	type GlobalState,
	type Language,
	type ModelRecord,
	RooCodeSettings,
	type Command as SlashCommand,
	TelemetryEventName,
	type TelemetrySetting,
	type WebviewMessage,
	providerIdentifiers,
} from "@roo-code/types"

import { importLegacyHistory } from "../../services/octocode-runtime/importLegacyHistory"

import { changeLanguage, t } from "../../i18n"
import { focusArtifactSlot, showTextDocumentInArtifactSlot } from "../../integrations/misc/artifactSlot"
import { LanguagePackStore } from "../../services/language-packs/LanguagePackStore"
import { openWorkbenchBrowser } from "../../services/workbench-mcp/WorkbenchMcpServer"
import { type RouterName, toRouterName } from "../../shared/api"
import { Package } from "../../shared/package"
import type { ClineProvider } from "./ClineProvider"
import { MessageEnhancer } from "./messageEnhancer"
import { handleRequestProviderModels } from "./providerModelList"
import {
	handleCreateRule,
	handleDeleteRule,
	handleOpenRuleFile,
	handleOpenRulesDirectory,
	handleRequestRules,
} from "./rulesMessageHandler"
import {
	handleCreateSkill,
	handleDeleteSkill,
	handleMoveSkill,
	handleOpenSkillFile,
	handleRequestSkills,
	handleUpdateSkillModes,
} from "./skillsMessageHandler"

import { getLMStudioModels } from "../../api/providers/fetchers/lmstudio"
import { flushModels, getModels } from "../../api/providers/fetchers/modelCache"
import { getOpenAiModelInfo, getOpenAiModels } from "../../api/providers/openai"
import { getVsCodeLmModels } from "../../api/providers/vscode-lm"
import { openImage, saveImage } from "../../integrations/misc/image-handler"
import { openFile } from "../../integrations/misc/open-file"
import { selectImages } from "../../integrations/misc/process-images"
import { Terminal } from "../../integrations/terminal/Terminal"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { getTheme } from "../../integrations/theme/getTheme"
import { CodeIndexManager } from "../../services/code-index/manager"
import { searchWorkspaceFiles } from "../../services/search/file-search"
import { GetModelsOptions } from "../../shared/api"
import { checkExistKey } from "../../shared/checkExistApiConfig"
import { experimentDefault } from "../../shared/experiments"
import { Mode, defaultModeSlug } from "../../shared/modes"
import { getCommand } from "../../utils/commands"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { fileExistsAtPath } from "../../utils/fs"
import { searchCommits } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { playTts, setTtsEnabled, setTtsSpeed, stopTts } from "../../utils/tts"
import { exportSettings, importSettingsWithFeedback } from "../config/importExport"
import { getRouterRemovalMessage, getRouterUnavailableSignInMessage } from "../config/routerRemoval"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { openMention } from "../mentions"
import { resolveImageMentions } from "../mentions/resolveImageMentions"
import { generateSystemPrompt } from "./generateSystemPrompt"

const ALLOWED_VSCODE_SETTINGS = new Set(["terminal.integrated.inheritEnv"])

/**
 * Where each pane the management rail can select sits in the editor grid.
 *
 * Selecting a pane means *focusing* it, which is what clicking its tab used to
 * do. Nothing here opens anything: both panes reopen themselves when closed, so
 * they are always on screen.
 *
 * The host command is OctoCode's own rather than
 * `workbench.action.focusNthEditorGroup`, because the rail lives in a webview and
 * a focused webview holds the browser's focus: the stock command marks the group
 * active — the window title changes — while every keystroke still goes to the
 * chat box. Measured on a running build. OctoCode's command releases the
 * webview's hold first.
 *
 * A fixed map rather than a command name passed through the webview: the webview
 * may only reach the panes this product owns, not any command the host happens
 * to register.
 */
const OCTOCODE_FOCUS_GROUP_COMMAND = "workbench.action.octocode.focusEditorGroupByPosition"
const WORKBENCH_PANE_POSITIONS: Record<string, number> = {
	preview: 1,
	terminal: 2,
}

import { MarketplaceItemType, MarketplaceManager } from "../../services/marketplace"
import {
	handleCheckBranchWorktreeInclude,
	handleCheckoutBranch,
	handleCreateWorktree,
	handleCreateWorktreeInclude,
	handleDeleteWorktree,
	handleGetAvailableBranches,
	handleGetWorktreeDefaults,
	handleGetWorktreeIncludeStatus,
	handleListWorktrees,
	handleSwitchWorktree,
} from "./worktree"

let runtimeViewRequest = 0

/**
 * Search the product's extension gallery (Open VSX) from the extension host, so
 * the component market can list VS Code extensions without opening the
 * workbench's Extensions view as an extra column.
 */
async function searchOpenVsx(
	query: string,
): Promise<{ id: string; name: string; description?: string; downloads?: number }[]> {
	const url = `https://open-vsx.org/api/-/search?query=${encodeURIComponent(query)}&size=20`
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
	if (!response.ok) throw new Error(`Open VSX search failed: HTTP ${response.status}`)
	const body = (await response.json()) as {
		extensions?: {
			namespace: string
			name: string
			displayName?: string
			description?: string
			downloadCount?: number
		}[]
	}
	return (body.extensions ?? []).map((extension) => ({
		id: `${extension.namespace}.${extension.name}`,
		name: extension.displayName ?? extension.name,
		description: extension.description,
		downloads: extension.downloadCount,
	}))
}

/** A running extension stays in `vscode.extensions.all` until reload; hide what was removed. */
const uninstalledThisSession = new Set<string>()

/**
 * The install command resolves before the extension host registers the new
 * extension, so an immediate re-list still showed it as not installed. Wait
 * (bounded) for the registration.
 */
async function extensionRegistered(id: string, timeoutMs = 15_000): Promise<void> {
	if (vscode.extensions.getExtension(id)) return
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, timeoutMs)
		const subscription = vscode.extensions.onDidChange(() => vscode.extensions.getExtension(id) && done())
		function done() {
			clearTimeout(timer)
			subscription.dispose()
			resolve()
		}
	})
}

export const webviewMessageHandler = async (
	provider: ClineProvider,
	message: WebviewMessage,
	marketplaceManager?: MarketplaceManager,
) => {
	// Utility functions provided for concise get/update of global state via contextProxy API.
	const getGlobalState = <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key)
	const updateGlobalState = async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
		await provider.contextProxy.setValue(key, value)

	const getCurrentCwd = () => {
		return provider.cwd
	}

	const isCloudServiceAvailable = () => CloudService.hasInstance()

	const showCloudUnavailableMessage = () => {
		vscode.window.showInformationMessage(getRouterUnavailableSignInMessage())
	}

	const getCurrentMode = async (): Promise<string> => {
		try {
			const state = await provider.getState()
			if (typeof state.mode === "string" && state.mode.length > 0) {
				return state.mode
			}
		} catch (error) {
			provider.log(
				`Error resolving global mode for command discovery: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}

		return defaultModeSlug
	}

	const getDiscoveredCommands = async (): Promise<SlashCommand[]> => {
		const { getCommands } = await import("../../services/command/commands")
		const commands = await getCommands(getCurrentCwd())

		const commandList: SlashCommand[] = commands.map((command) => ({
			name: command.name,
			source: command.source,
			filePath: command.filePath,
			description: command.description,
			argumentHint: command.argumentHint,
		}))

		const existingCommandNames = new Set(commandList.map((command) => command.name))
		const skillsManager = provider.getSkillsManager()

		if (!skillsManager) {
			return commandList
		}

		const currentMode = await getCurrentMode()
		const availableSkills = skillsManager.getSkillsForMode(currentMode)

		for (const skill of availableSkills) {
			if (existingCommandNames.has(skill.name)) {
				continue
			}

			existingCommandNames.add(skill.name)
			commandList.push({
				name: skill.name,
				source: skill.source,
				filePath: skill.path,
				description: skill.description,
			})
		}

		return commandList
	}

	/**
	 * Resolves image file mentions in incoming messages.
	 * Matches read_file behavior: respects size limits and model capabilities.
	 */
	const resolveIncomingImages = async (payload: { text?: string; images?: string[] }) => {
		const text = payload.text ?? ""
		const images = payload.images
		const state = await provider.getState()
		const resolved = await resolveImageMentions({
			text,
			images,
			cwd: getCurrentCwd(),
			maxImageFileSize: state.maxImageFileSize,
			maxTotalImageSize: state.maxTotalImageSize,
		})
		return resolved
	}

	switch (message.type) {
		case "webviewDidLaunch":
			// Load custom modes first
			const customModes = await provider.customModesManager.getCustomModes()
			await updateGlobalState("customModes", customModes)

			await provider.postStateToWebview()
			void provider.workspaceTracker
				?.initializeFilePaths()
				.catch((err) => provider.log(`Workspace initialization error: ${err}`)) // Don't await.

			await getTheme().then((theme) =>
				provider.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) }),
			)

			// If MCP Hub is already initialized, update the webview with
			// current server list.
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				await provider.postMessageToWebview({ type: "mcpServers", mcpServers: mcpHub.getAllServers() })
			}

			try {
				const listApiConfig = await provider.providerSettingsManager.listConfig()
				if (!listApiConfig) {
					break
				}

				if (listApiConfig.length === 1) {
					// Check if first time init then sync with exist config.
					if (!checkExistKey(listApiConfig[0])) {
						const { apiConfiguration } = await provider.getState()

						// Only save if the current configuration has meaningful settings
						// (e.g., API keys). This prevents saving a default "anthropic"
						// fallback when no real config exists, which can happen during
						// CLI initialization before provider settings are applied.
						if (checkExistKey(apiConfiguration)) {
							await provider.providerSettingsManager.saveConfig(
								listApiConfig[0].name ?? "default",
								apiConfiguration,
							)

							listApiConfig[0].apiProvider = apiConfiguration.apiProvider
						}
					}
				}

				const savedName = getGlobalState("currentApiConfigName")
				const activeName =
					savedName && (await provider.providerSettingsManager.hasConfig(savedName))
						? savedName
						: listApiConfig[0]?.name

				if (activeName) {
					const profile = await provider.providerSettingsManager.getProfile({ name: activeName })
					if (checkExistKey(profile)) {
						await provider.activateProviderProfile({ name: activeName })
					}
				}

				await Promise.all([
					updateGlobalState("listApiConfigMeta", listApiConfig),
					provider.postMessageToWebview({ type: "listApiConfig", listApiConfig }),
				])
			} catch (error) {
				provider.log(
					`Error list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}

			// Local-first default: telemetry is active only after explicit opt-in.
			await provider.getStateToPostToWebview().then((state) => {
				const { telemetrySetting } = state
				const isOptedIn = telemetrySetting === "enabled"
				TelemetryService.instance.updateTelemetryState(isOptedIn)
			})

			provider.isViewLaunched = true
			await provider.replayCurrentArtifact()
			break
		case "newTask":
			runtimeViewRequest++
			try {
				const resolved = await resolveIncomingImages({ text: message.text, images: message.images })
				await provider.startRuntimeTask(resolved.text, resolved.images, message.taskId)
			} catch (error) {
				vscode.window.showErrorMessage(
					`Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		case "newRuntimeSession":
			if (message.taskId?.trim()) {
				try {
					await provider.rolloverRuntimeSession(message.taskId.trim(), true, message.sourceTask)
				} catch (error) {
					vscode.window.showErrorMessage(
						`Failed to continue task in a new session: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			break
		case "continueRuntimeTask":
			runtimeViewRequest++
			let runtimeTask: { sessionId: string; taskId: string } | undefined
			try {
				const resolved = await resolveIncomingImages({ text: message.text, images: message.images })
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				const runtime = getOctoCodeRuntime()
				if (runtime.replyUserInput(message.taskId ?? "", resolved.text)) break
				const state = await provider.getStateToPostToWebview()
				const task = await runtime.prepareContinuation(
					message.taskId ?? "",
					resolved.text,
					state.apiConfiguration,
					resolved.images,
				)
				runtimeTask = task
				const { ClineProvider } = await import("./ClineProvider")
				ClineProvider.setActiveRuntimeSession(task.sessionId, task.taskId)
				await provider.postMessageToWebview({
					type: "runtimeTaskStarted",
					payload: {
						sessionId: task.sessionId,
						taskId: task.taskId,
						prompt: resolved.text,
						images: resolved.images,
					},
				})
				await runtime.runPreparedAgentTask(
					task,
					resolved.text,
					resolved.images,
					true,
					state.permissionProfile ?? "full",
				)
			} catch (error) {
				if (runtimeTask) await provider.reportRuntimeFailure(runtimeTask, error)
				else
					await provider.postMessageToWebview({
						type: "runtimeTaskFailed",
						payload: { resetSession: false },
					})
				vscode.window.showErrorMessage(
					`Failed to continue task: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		case "customInstructions":
			await provider.updateCustomInstructions(message.text)
			break

		case "updateSettings":
			if (message.updatedSettings) {
				if (message.updatedSettings.destructiveCommandGuardEnabled === true) {
					try {
						const { ensureDcgInstalled } = await import("../../services/destructive-command-guard")
						const binaryPath = await ensureDcgInstalled(provider.context.globalStorageUri.fsPath)
						if (!binaryPath) {
							message.updatedSettings.destructiveCommandGuardEnabled = false
							vscode.window.showErrorMessage(t("common:errors.destructiveCommandGuard.unavailable"))
						}
					} catch (error) {
						message.updatedSettings.destructiveCommandGuardEnabled = false
						vscode.window.showErrorMessage(
							t("common:errors.destructiveCommandGuard.enableFailed", {
								error: error instanceof Error ? error.message : String(error),
							}),
						)
					}
				}

				for (const [key, value] of Object.entries(message.updatedSettings)) {
					let newValue = value

					if (key === "language") {
						newValue = value ?? "en"
						changeLanguage(newValue as Language)
					} else if (key === "allowedCommands") {
						const commands = value ?? []

						newValue = Array.isArray(commands)
							? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
							: []

						await vscode.workspace
							.getConfiguration(Package.name)
							.update("allowedCommands", newValue, vscode.ConfigurationTarget.Global)
					} else if (key === "deniedCommands") {
						const commands = value ?? []

						newValue = Array.isArray(commands)
							? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
							: []

						await vscode.workspace
							.getConfiguration(Package.name)
							.update("deniedCommands", newValue, vscode.ConfigurationTarget.Global)
					} else if (key === "ttsEnabled") {
						newValue = value ?? true
						setTtsEnabled(newValue as boolean)
					} else if (key === "ttsSpeed") {
						newValue = value ?? 1.0
						setTtsSpeed(newValue as number)
					} else if (key === "terminalShellIntegrationTimeout") {
						if (value !== undefined) {
							Terminal.setShellIntegrationTimeout(value as number)
						}
					} else if (key === "terminalShellIntegrationDisabled") {
						if (value !== undefined) {
							Terminal.setShellIntegrationDisabled(value as boolean)
						}
					} else if (key === "terminalCommandDelay") {
						if (value !== undefined) {
							Terminal.setCommandDelay(value as number)
						}
					} else if (key === "terminalPowershellCounter") {
						if (value !== undefined) {
							Terminal.setPowershellCounter(value as boolean)
						}
					} else if (key === "terminalZshClearEolMark") {
						if (value !== undefined) {
							Terminal.setTerminalZshClearEolMark(value as boolean)
						}
					} else if (key === "terminalZshOhMy") {
						if (value !== undefined) {
							Terminal.setTerminalZshOhMy(value as boolean)
						}
					} else if (key === "terminalZshP10k") {
						if (value !== undefined) {
							Terminal.setTerminalZshP10k(value as boolean)
						}
					} else if (key === "terminalZdotdir") {
						if (value !== undefined) {
							Terminal.setTerminalZdotdir(value as boolean)
						}
					} else if (key === "terminalProfile") {
						const previousProfile = Terminal.getTerminalProfile()
						Terminal.setTerminalProfile(typeof value === "string" ? value : undefined)
						newValue = Terminal.getTerminalProfile()

						if (newValue !== previousProfile) {
							// Discard idle terminals so the next command gets a fresh
							// terminal using the new profile's shell instead of reusing
							// a stale one from the previous profile.
							TerminalRegistry.closeIdleTerminals()
						}
					} else if (key === "execaShellPath") {
						Terminal.setExecaShellPath(value as string | undefined)
					} else if (key === "mcpEnabled") {
						newValue = value ?? true
					} else if (key === "experiments") {
						if (!value) {
							continue
						}

						newValue = {
							...(getGlobalState("experiments") ?? experimentDefault),
							...(value as Record<ExperimentId, boolean>),
						}
					} else if (key === "customSupportPrompts") {
						if (!value) {
							continue
						}
					}

					await provider.contextProxy.setValue(key as keyof RooCodeSettings, newValue)
					if (key === "mcpEnabled") {
						await provider.getMcpHub()?.handleMcpEnabledChange(newValue as boolean)
					}
				}

				await provider.postStateToWebview()
			}

			break
		case "clearTask":
			runtimeViewRequest++
			// Clear task resets the current session. Delegation flows are
			// handled via metadata; parent resumption occurs through
			// reopenParentFromDelegation, not via finishSubTask.
			await provider.clearTask()
			await provider.postStateToWebview()
			{
				const { ClineProvider } = await import("./ClineProvider")
				await Promise.all(
					ClineProvider.getAllInstances().map((instance) =>
						instance.postMessageToWebview({ type: "invoke", invoke: "newChat" }),
					),
				)
			}
			break
		case "didShowAnnouncement":
			await updateGlobalState("lastShownAnnouncementId", provider.latestAnnouncementId)
			await provider.postStateToWebview()
			break
		case "selectFiles": {
			try {
				const files = await vscode.window.showOpenDialog({
					canSelectMany: true,
					canSelectFolders: false,
					openLabel: t("common:ui.addFiles"),
				})
				if (!files?.length) break
				/*
				 * One picker for everything the composer can carry.
				 *
				 * Pictures and documents travel differently — a picture has to reach
				 * the model as a data URL, a document is read into the prompt as text
				 * — but that is a fact about the model, not a choice a person should
				 * have to make before the dialog opens. So the composer offers one
				 * attach control and the split happens here, by extension.
				 *
				 * `bool` is the composer saying whether the current model takes
				 * images at all; when it does not, a chosen picture is reported
				 * rather than read as text, which would put binary into the prompt.
				 */
				const { IMAGE_EXTENSIONS, readImagesAsDataUrls } =
					await import("../../integrations/misc/process-images")
				const chosen = files.map((file) => file.fsPath)
				const images = chosen.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
				const documents = chosen.filter((file) => !images.includes(file))
				const attachments = documents.length
					? await (
							await import("../../services/octocode-runtime/attachments")
						).readAttachmentRecords(documents)
					: []
				if (images.length && message.bool === false) {
					void vscode.window.showWarningMessage(t("common:ui.imagesNotSupported"))
				} else if (images.length) {
					await provider.postMessageToWebview({
						type: "selectedImages",
						images: await readImagesAsDataUrls(images),
						context: message.context,
						messageTs: message.messageTs,
					})
				}
				if (attachments.length) {
					await provider.postMessageToWebview({ type: "selectedFiles", attachments })
				}
			} catch (error) {
				void vscode.window.showErrorMessage(
					t("common:ui.attachmentFailed", { error: error instanceof Error ? error.message : String(error) }),
				)
			}
			break
		}
		case "selectImages":
			const images = await selectImages()
			await provider.postMessageToWebview({
				type: "selectedImages",
				images,
				context: message.context,
				messageTs: message.messageTs,
			})
			break
		case "selectArtifact": {
			const [file] =
				(await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Open in Artifacts" })) ?? []
			if (!file) break
			const filePath = file.fsPath
			await provider.showArtifact(filePath)
			break
		}
		case "cancelRuntimeTask": {
			const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
			let result: { cancelled?: boolean; error?: string }
			try {
				result = { cancelled: await getOctoCodeRuntime().cancelTask(message.text ?? "") }
			} catch (error) {
				result = { error: error instanceof Error ? error.message : String(error) }
			}
			await provider.postMessageToWebview({
				type: "agentEvent",
				payload: {
					task_id: message.text,
					session_id: message.taskId ?? "",
					kind: "agent.cancel_requested",
					payload: result,
				},
			})
			break
		}
		case "openRuntimeSession": {
			const sessionId = message.text?.trim()
			if (!sessionId) break
			const request = ++runtimeViewRequest
			await provider.postMessageToWebview({ type: "runtimeSessionLoading", payload: { sessionId } })
			try {
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				const runtime = getOctoCodeRuntime()
				const requestedTurns = (message.payload as { historyTurns?: unknown } | undefined)?.historyTurns
				const historyTurns =
					typeof requestedTurns === "number" && Number.isInteger(requestedTurns)
						? Math.max(3, Math.min(10000, requestedTurns))
						: 3
				const [session, window, messages] = await Promise.all([
					runtime.call("session.get", { id: sessionId }),
					runtime.call<{ after: number; skipped_turns: number }>("event.history_start", {
						session_id: sessionId,
						turns: historyTurns,
					}),
					runtime.call("message.list", { session_id: sessionId }),
				])
				const rows: [number, string, unknown][] = []
				for await (const page of readEventPages(runtime, sessionId, window.after, true)) {
					if (request !== runtimeViewRequest) return
					rows.push(...page)
				}
				if (
					!session ||
					typeof session !== "object" ||
					Array.isArray(session) ||
					!Array.isArray(rows) ||
					!Array.isArray(messages)
				) {
					throw new Error("Runtime session is unavailable")
				}
				const record = session as Record<string, unknown>
				const userMessages = messages.flatMap((message) => {
					if (!message || typeof message !== "object" || Array.isArray(message)) return []
					const value = message as Record<string, unknown>
					return value.role === "user" && typeof value.content === "string" ? [value.content] : []
				})
				let taskId = sessionId
				let continuationIndex = window.skipped_turns
				let firstTurn = true
				let initialImages: string[] = []
				const events = rows.flatMap((row) => {
					if (!Array.isArray(row) || typeof row[1] !== "string") return []
					const payload = row[2]
					const data =
						payload && typeof payload === "object" && !Array.isArray(payload)
							? (payload as Record<string, unknown>)
							: {}
					const images = Array.isArray(data.images)
						? data.images.filter(
								(image): image is string =>
									typeof image === "string" && image.startsWith("data:image/"),
							)
						: []
					const turnBoundary = ["harness.prepared", "harness.continued", "legacy.turn"].includes(row[1])
					const initialTurn = turnBoundary && firstTurn
					if (initialTurn) {
						initialImages = images
						firstTurn = false
						continuationIndex++
					}
					if (
						(row[1] === "harness.prepared" || row[1] === "harness.continued" || row[1] === "legacy.turn") &&
						payload &&
						typeof payload === "object" &&
						!Array.isArray(payload) &&
						typeof (payload as Record<string, unknown>).task_id === "string"
					) {
						taskId = (payload as Record<string, unknown>).task_id as string
					}
					const event = { task_id: taskId, session_id: sessionId, kind: row[1], payload: row[2] }
					const legacyContinuation =
						row[1] === "legacy.turn" &&
						payload &&
						typeof payload === "object" &&
						!Array.isArray(payload) &&
						Number((payload as Record<string, unknown>).user_index) > 0
					if (
						initialTurn ||
						(row[1] !== "harness.continued" && !legacyContinuation) ||
						continuationIndex >= userMessages.length
					)
						return [event]
					return [
						{
							task_id: taskId,
							session_id: sessionId,
							kind: "user.message",
							payload: { text: userMessages[continuationIndex++], images },
						},
						event,
					]
				})
				const handoff = rows.find((row) => row[1] === "harness.prepared")?.[2] as
					| { handoff?: { objective?: string; turns?: { user?: string; assistant?: string }[] } }
					| undefined
				const inherited =
					handoff?.handoff?.turns?.flatMap((turn) => [
						...(turn.user
							? [
									{
										task_id: taskId,
										session_id: sessionId,
										kind: "user.message",
										payload: { text: turn.user },
									},
								]
							: []),
						...(turn.assistant
							? [
									{
										task_id: taskId,
										session_id: sessionId,
										kind: "text",
										payload: { data: turn.assistant },
									},
								]
							: []),
					]) ?? []
				events.unshift(...inherited)
				const response = {
					type: "runtimeSessionLoaded" as const,
					payload: {
						prompt:
							handoff?.handoff?.objective ??
							userMessages[window.skipped_turns] ??
							(typeof record.title === "string" ? record.title : sessionId),
						historyTurns,
						hasEarlierHistory: window.skipped_turns > 0,
						images: initialImages,
						sessionId,
						taskId,
						status: typeof record.status === "string" ? record.status : undefined,
						phase: record.phase === "executing" || record.phase === "thinking" ? record.phase : undefined,
						queue: await runtime.getQueue(sessionId),
						startedAt: (
							[...events].reverse().find((event) => event.kind === "agent.started")?.payload as
								| { started_at?: number }
								| undefined
						)?.started_at,
						updatedAt: record.updated_at,
						events,
					},
				}
				const { ClineProvider } = await import("./ClineProvider")
				if (request !== runtimeViewRequest) break
				ClineProvider.setActiveRuntimeSession(sessionId, taskId)
				await Promise.all(
					ClineProvider.getAllInstances().map((instance) => instance.postMessageToWebview(response)),
				)
			} catch (error) {
				if (request !== runtimeViewRequest) break
				const detail = error instanceof Error ? error.message : String(error)
				provider.log(`[Runtime history] Failed to load ${sessionId}: ${detail}`)
				await provider.postMessageToWebview({
					type: "runtimeSessionLoadFailed",
					payload: { sessionId, error: detail },
				})
			}
			break
		}
		case "runtimeRequest": {
			const request = message.payload as { method?: string; params?: unknown; requestId?: string }
			const allowed = new Set([
				"provider.context",
				"provider.speech.info",
				"provider.speech.check",
				"session.list",
				"project.list",
				"project.index",
				"project.refresh",
				"project.create",
				"project.assign",
				"project.rename",
				"project.delete",
				"session.get",
				"session.update",
				"session.delete",
				"message.list",
				"log.list",
				"log.delete",
				"log.delete_matching",
				"log.clear",
				"log.purge",
				"setting.get",
				"setting.set",
				"audio.start",
				"audio.chunk",
				"audio.preview",
				"audio.finish",
				"audio.cancel",
			])
			try {
				if (!request.method || !allowed.has(request.method)) throw new Error("Unsupported runtime request")
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				const params = request.params ?? {}
				const result =
					request.method.startsWith("audio.") || request.method.startsWith("provider.speech.")
						? await getOctoCodeRuntime().speechRequest(
								request.method,
								params,
								request.method.startsWith("provider.speech.")
									? (await import("@roo-code/types")).providerSettingsSchema.parse(params)
									: (await provider.getState()).apiConfiguration,
							)
						: request.method === "provider.context"
							? await getOctoCodeRuntime().modelContext(
									(await import("@roo-code/types")).providerSettingsSchema.parse(params),
								)
							: await getOctoCodeRuntime().call(request.method, params)
				if (
					request.method === "session.delete" &&
					typeof (request.params as { id?: unknown })?.id === "string"
				) {
					const { ClineProvider } = await import("./ClineProvider")
					if (ClineProvider.clearActiveRuntimeSession((request.params as { id: string }).id)) {
						await Promise.all(
							ClineProvider.getAllInstances().map((instance) =>
								instance.postMessageToWebview({ type: "invoke", invoke: "newChat" }),
							),
						)
					}
				}
				if (request.method === "log.list" && Array.isArray(result)) {
					const category = (request.params as { category?: unknown })?.category
					await provider.showLogsInTerminal(result, category === "developer" ? "developer" : "system")
				}
				await provider.postMessageToWebview({
					type: "runtimeResponse",
					payload: { requestId: request.requestId, result },
				})
			} catch (error) {
				await provider.postMessageToWebview({
					type: "runtimeResponse",
					payload: {
						requestId: request.requestId,
						error: error instanceof Error ? error.message : String(error),
					},
				})
			}
			break
		}
		case "webviewLog": {
			const payload = message.payload as { level?: unknown; message?: unknown; source?: unknown }
			const level = payload.level === "warn" ? "warn" : "error"
			const text = String(payload.message ?? "")
				.trim()
				.slice(0, 4000)
			if (!text) break
			const source = String(payload.source ?? "console").slice(0, 200)
			provider.log(`[webview:${level}] ${text}`)
			try {
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				await getOctoCodeRuntime().call("log.create", {
					category: "system",
					fields: { source },
					level,
					message: text,
					subsystem: "webview",
				})
			} catch (error) {
				provider.log(`[webview:log-persistence] ${error instanceof Error ? error.message : String(error)}`)
			}
			break
		}
		case "openArtifactBrowser": {
			try {
				const url = new URL(message.url ?? "")
				if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported")
				await openWorkbenchBrowser(url.toString())
			} catch (error) {
				void vscode.window.showErrorMessage(
					`Cannot open browser: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "requestLanguagePacks":
		case "installLanguagePack":
		case "removeLanguagePack": {
			const store = new LanguagePackStore(path.join(provider.context.globalStorageUri.fsPath, "language-packs"))
			try {
				if (message.type === "installLanguagePack") {
					const [file] =
						(await vscode.window.showOpenDialog({
							canSelectMany: false,
							filters: { "OctoCode language pack": ["json"] },
							openLabel: "Install language pack",
						})) ?? []
					if (file) await store.install(file.fsPath)
				} else if (message.type === "removeLanguagePack" && message.text) {
					await store.remove(message.text)
				}
				await provider.postMessageToWebview({ type: "languagePacks", payload: { packs: await store.list() } })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				void vscode.window.showErrorMessage(t("common:ui.languagePackError", { error: errorMessage }))
				await provider.postMessageToWebview({
					type: "languagePacks",
					payload: { error: errorMessage, packs: await store.list() },
				})
			}
			break
		}
		case "openOctoCodeSettings": {
			const { ClineProvider } = await import("./ClineProvider")
			const visible = ClineProvider.getVisibleInstance()
			await visible?.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
			break
		}
		case "openDisplayLanguagePicker":
			await vscode.commands.executeCommand("workbench.action.configureLocale")
			break
		case "workspaceAction": {
			if (message.text === "openFolder") {
				const folders = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
				})
				if (folders?.[0]) {
					await vscode.workspace
						.getConfiguration("octocode")
						.update("workspace.path", folders[0].fsPath, vscode.ConfigurationTarget.Global)
				}
				break
			}
			const command = new Map([
				["openFolder", "vscode.openFolder"],
				["openRecent", "workbench.action.openRecent"],
				["findFile", "workbench.action.quickOpen"],
				["commands", "workbench.action.showCommands"],
				["keyboardShortcuts", "workbench.action.openGlobalKeybindings"],
			]).get(message.text ?? "")
			if (command) await vscode.commands.executeCommand(command)
			break
		}
		case "requestColorThemes":
		case "setColorTheme": {
			const themes = vscode.extensions.all.flatMap((extension) => {
				const contributions: unknown = extension.packageJSON?.contributes?.themes
				if (!Array.isArray(contributions)) return []
				return contributions.flatMap((theme: unknown) => {
					if (!theme || typeof theme !== "object") return []
					const id = "id" in theme && typeof theme.id === "string" ? theme.id : undefined
					const label = "label" in theme && typeof theme.label === "string" ? theme.label : id
					return label ? [{ id: id || label, label }] : []
				})
			})
			let error: string | undefined
			try {
				if (message.type === "setColorTheme") {
					const followSystem = message.text === "__system__"
					if (!followSystem && !themes.some((theme) => theme.id === message.text))
						throw new Error(t("common:ui.themeNotInstalled"))
					// Application appearance belongs to global settings; remove only obsolete theme overrides.
					for (const key of [
						"workbench.colorTheme",
						"workbench.preferredDarkColorTheme",
						"workbench.preferredLightColorTheme",
						"workbench.preferredHighContrastColorTheme",
						"workbench.preferredHighContrastLightColorTheme",
						"window.autoDetectColorScheme",
						"window.autoDetectHighContrast",
					]) {
						const config = vscode.workspace.getConfiguration()
						if (config.inspect(key)?.workspaceValue !== undefined)
							await config.update(key, undefined, vscode.ConfigurationTarget.Workspace)
						for (const folder of vscode.workspace.workspaceFolders ?? []) {
							const scoped = vscode.workspace.getConfiguration(undefined, folder.uri)
							if (scoped.inspect(key)?.workspaceFolderValue !== undefined)
								await scoped.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder)
						}
					}
					await vscode.workspace
						.getConfiguration("window")
						.update("autoDetectColorScheme", followSystem, vscode.ConfigurationTarget.Global)
					await vscode.workspace
						.getConfiguration("window")
						.update("autoDetectHighContrast", followSystem, vscode.ConfigurationTarget.Global)
					if (!followSystem)
						await vscode.workspace
							.getConfiguration("workbench")
							.update("colorTheme", message.text, vscode.ConfigurationTarget.Global)
				}
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause)
			}
			await provider.postMessageToWebview({
				type: "colorThemeSettings",
				colorThemeSettings: {
					current: vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "",
					followSystem:
						vscode.workspace.getConfiguration("window").get<boolean>("autoDetectColorScheme") === true ||
						vscode.workspace.getConfiguration("window").get<boolean>("autoDetectHighContrast") === true,
					themes,
				},
				error,
			})
			break
		}
		case "revealWorkbenchPane": {
			// The management rail is where you select panes now: the editor groups
			// no longer draw tab strips.
			const position = WORKBENCH_PANE_POSITIONS[message.text ?? ""]
			if (position !== undefined) {
				await vscode.commands.executeCommand(
					message.text === "preview" ? "octocode.openArtifactPanel" : "octocode.openRuntimeTerminal",
				)
				await vscode.commands.executeCommand(OCTOCODE_FOCUS_GROUP_COMMAND, position)
			}
			break
		}
		case "startAutonomousResearch": {
			const config = message.payload as { evaluator?: string; maximumIterations?: number; objective?: string }
			const maximumIterations = Math.max(1, Math.min(Number(config.maximumIterations) || 10, 100))
			if (!config.objective?.trim() || !config.evaluator?.trim()) {
				void vscode.window.showErrorMessage(t("common:errors.autonomousResearchFields"))
				break
			}
			await provider.startRuntimeTask(
				`Run an autonomous research loop. Objective: ${config.objective}\nEvaluator: ${config.evaluator}\n` +
					`Maximum iterations: ${maximumIterations}. Measure a baseline first. For each iteration, state one hypothesis, ` +
					`make one bounded change, run the evaluator, keep only measurable improvements, and revert regressions using checkpoints. ` +
					`Record hypothesis, commands, diff, score, and keep/revert decision. Stop at the iteration limit or when further improvement is not credible.`,
			)
			break
		}
		case "stopAutonomousResearch":
			await provider.cancelTask()
			break
		case "importSettings": {
			await importSettingsWithFeedback({
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
				customModesManager: provider.customModesManager,
				provider: provider,
			})

			break
		}
		case "importRooHistory": {
			const progress = { copiedFileCount: 0, totalFileCount: 0, importedTaskCount: 0, totalTaskCount: 0 }
			try {
				await provider.postMessageToWebview({
					type: "rooHistoryImportProgress",
					rooHistoryImportProgress: { status: "starting", ...progress },
				})
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				const root = provider.contextProxy.globalStorageUri.fsPath
				const custom = vscode.workspace.getConfiguration("roo-cline").get<string>("customStoragePath")?.trim()
				const ownCustom = vscode.workspace
					.getConfiguration(Package.name)
					.get<string>("customStoragePath")
					?.trim()
				const result = await importLegacyHistory({
					sourceRoots: [
						root,
						path.join(path.dirname(root), "rooveterinaryinc.roo-cline"),
						...(custom ? [custom] : []),
						...(ownCustom ? [ownCustom] : []),
					],
					backupRoot: path.join(root, "legacy-backups"),
					call: (method, params) => getOctoCodeRuntime().call(method, params),
				})
				await provider.postMessageToWebview({
					type: "rooHistoryImportProgress",
					rooHistoryImportProgress: {
						status: "finished",
						...progress,
						importedTaskCount: result.imported,
						totalTaskCount: result.found,
					},
				})
				void vscode.window.showInformationMessage(
					t("common:ui.historyImported", { imported: result.imported, skipped: result.skipped }),
				)
				await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
			} catch (error) {
				await provider.postMessageToWebview({
					type: "rooHistoryImportProgress",
					rooHistoryImportProgress: { status: "failed", ...progress },
				})
				void vscode.window.showErrorMessage(
					t("common:ui.historyImportFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			}
			break
		}
		case "exportSettings":
			await exportSettings({
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
			})

			break
		case "resetState":
			await provider.resetState()
			break
		case "flushRouterModels":
			const routerNameFlush: RouterName = toRouterName(message.text)
			// Note: flushRouterModels is a generic flush without credentials
			// For providers that need credentials, use their specific handlers
			await flushModels({ provider: routerNameFlush } as GetModelsOptions, true)
			break
		case "requestRouterModels": {
			const { apiConfiguration } = await provider.getState()

			// Optional single provider filter from webview
			const requestedProvider = message?.values?.provider
			const providerFilter = requestedProvider ? toRouterName(requestedProvider) : undefined

			// Optional refresh flag to flush cache before fetching (useful for providers requiring credentials)
			const shouldRefresh = message?.values?.refresh === true

			const routerModels: Record<RouterName, ModelRecord> = providerFilter
				? ({} as Record<RouterName, ModelRecord>)
				: {
						openrouter: {},
						"vercel-ai-gateway": {},
						"octocode-gateway": {},
						litellm: {},
						requesty: {},
						unbound: {},
						ollama: {},
						lmstudio: {},
						poe: {},
						deepseek: {},
						moonshot: {},
						"opencode-go": {},
						kenari: {},
						nanogpt: {},
						"kimi-code": {},
					}

			const safeGetModels = async (options: GetModelsOptions): Promise<ModelRecord> => {
				try {
					return await getModels(options)
				} catch (error) {
					console.error(
						`Failed to fetch models in webviewMessageHandler requestRouterModels for ${options.provider}:`,
						error,
					)

					throw error // Re-throw to be caught by Promise.allSettled.
				}
			}

			// Base candidates (only those handled by this aggregate fetcher)
			const candidates: { key: RouterName; options: GetModelsOptions }[] = [
				{ key: "openrouter", options: { provider: "openrouter" } },
				{
					key: "requesty",
					options: {
						provider: "requesty",
						apiKey: apiConfiguration.requestyApiKey,
						baseUrl: apiConfiguration.requestyBaseUrl,
					},
				},
				{
					key: "unbound",
					options: {
						provider: "unbound",
						apiKey: apiConfiguration.unboundApiKey,
					},
				},
				{ key: "vercel-ai-gateway", options: { provider: "vercel-ai-gateway" } },
				{
					key: "octocode-gateway",
					options: {
						provider: "octocode-gateway",
						apiKey: apiConfiguration.octoCodeSessionToken,
						baseUrl: apiConfiguration.octoCodeGatewayBaseUrl,
					},
				},
			]

			// LiteLLM is conditional on baseUrl+apiKey.
			// Prefer explicit values from message (current unsaved field state) over saved config,
			// matching the pattern used for DeepSeek and other credential-carrying providers.
			const litellmApiKey = message?.values?.litellmApiKey ?? apiConfiguration.litellmApiKey
			const litellmBaseUrl = message?.values?.litellmBaseUrl ?? apiConfiguration.litellmBaseUrl

			if (litellmApiKey && litellmBaseUrl) {
				// If explicit credentials are provided in message.values (from Refresh Models button),
				// flush the cache first to ensure we fetch fresh data with the new credentials
				if (message?.values?.litellmApiKey || message?.values?.litellmBaseUrl) {
					await flushModels({ provider: "litellm", apiKey: litellmApiKey, baseUrl: litellmBaseUrl }, true)
				}

				candidates.push({
					key: "litellm",
					options: { provider: "litellm", apiKey: litellmApiKey, baseUrl: litellmBaseUrl },
				})
			}

			// Poe is conditional on apiKey
			const poeApiKey = apiConfiguration.poeApiKey || message?.values?.poeApiKey
			const poeBaseUrl = apiConfiguration.poeBaseUrl || message?.values?.poeBaseUrl

			if (poeApiKey) {
				if (message?.values?.poeApiKey || message?.values?.poeBaseUrl) {
					await flushModels({ provider: "poe", apiKey: poeApiKey, baseUrl: poeBaseUrl }, true)
				}

				candidates.push({
					key: "poe",
					options: { provider: "poe", apiKey: poeApiKey, baseUrl: poeBaseUrl },
				})
			}

			// DeepSeek is conditional on apiKey
			const deepSeekApiKey = message?.values?.deepSeekApiKey ?? apiConfiguration.deepSeekApiKey
			const deepSeekBaseUrl = message?.values?.deepSeekBaseUrl ?? apiConfiguration.deepSeekBaseUrl

			if (deepSeekApiKey) {
				if (message?.values?.deepSeekApiKey || message?.values?.deepSeekBaseUrl) {
					await flushModels({ provider: "deepseek", apiKey: deepSeekApiKey, baseUrl: deepSeekBaseUrl }, true)
				}

				candidates.push({
					key: "deepseek",
					options: { provider: "deepseek", apiKey: deepSeekApiKey, baseUrl: deepSeekBaseUrl },
				})
			}

			// Moonshot is conditional on apiKey
			const moonshotApiKey = message?.values?.moonshotApiKey ?? apiConfiguration.moonshotApiKey
			const moonshotBaseUrl = message?.values?.moonshotBaseUrl ?? apiConfiguration.moonshotBaseUrl

			if (moonshotApiKey) {
				if (message?.values?.moonshotApiKey || message?.values?.moonshotBaseUrl) {
					await flushModels({ provider: "moonshot", apiKey: moonshotApiKey, baseUrl: moonshotBaseUrl }, true)
				}

				candidates.push({
					key: "moonshot",
					options: { provider: "moonshot", apiKey: moonshotApiKey, baseUrl: moonshotBaseUrl },
				})
			}

			// Opencode Go's /models endpoint is public — it returns the full model list with no
			// Authorization header — so it's fetched unconditionally like openrouter/vercel-ai-gateway
			// above. Gating it behind a key meant the picker stayed empty (and fell back to the default
			// model) whenever the key wasn't yet in apiConfiguration at fetch time. The key is still
			// forwarded when present.
			const opencodeGoApiKey = message?.values?.opencodeGoApiKey ?? apiConfiguration.opencodeGoApiKey

			// Refresh the cache when a new key is explicitly provided (e.g. the Refresh Models button).
			if (message?.values?.opencodeGoApiKey) {
				await flushModels({ provider: "opencode-go", apiKey: opencodeGoApiKey }, true)
			}

			candidates.push({
				key: "opencode-go",
				options: { provider: "opencode-go", apiKey: opencodeGoApiKey },
			})

			// Kenari's /models endpoint is public — it returns the full model list with no
			// Authorization header — so it's fetched unconditionally like openrouter/vercel-ai-gateway
			// above. Gating it behind a key meant the picker stayed empty (and fell back to the default
			// model) whenever the key wasn't yet in apiConfiguration at fetch time. The key is still
			// forwarded when present.
			const kenariApiKey = message?.values?.kenariApiKey ?? apiConfiguration.kenariApiKey

			// Refresh the cache when a new key is explicitly provided (e.g. the Refresh Models button).
			if (message?.values?.kenariApiKey) {
				await flushModels({ provider: "kenari", apiKey: kenariApiKey }, true)
			}

			candidates.push({
				key: "kenari",
				options: { provider: "kenari", apiKey: kenariApiKey },
			})

			// NanoGPT's detailed catalog is public, while an optional key can expose a
			// different allowlist. Prefer an explicitly supplied unsaved key and use the
			// same key-scoped options for refresh and retrieval.
			const nanoGptApiKey = message?.values?.nanoGptApiKey ?? apiConfiguration.nanoGptApiKey
			if (message?.values?.nanoGptApiKey !== undefined) {
				await flushModels({ provider: "nanogpt", apiKey: nanoGptApiKey }, true)
			}

			candidates.push({
				key: "nanogpt",
				options: { provider: "nanogpt", apiKey: nanoGptApiKey },
			})

			if (!providerFilter || providerFilter === "kimi-code") {
				const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
				const kimiCodeAuthMethod =
					message?.values?.kimiCodeAuthMethod ?? apiConfiguration.kimiCodeAuthMethod ?? "oauth"
				const kimiCodeApiKey =
					kimiCodeAuthMethod === "api-key"
						? (message?.values?.kimiCodeApiKey ?? apiConfiguration.kimiCodeApiKey)
						: await kimiCodeOAuthManager.getAccessToken()
				if (kimiCodeApiKey) {
					candidates.push({
						key: "kimi-code",
						options: { provider: "kimi-code", apiKey: kimiCodeApiKey },
					})
				}
			}

			// Apply single provider filter if specified
			const modelFetchPromises = providerFilter
				? candidates.filter(({ key }) => key === providerFilter)
				: candidates

			// If refresh flag is set and we have a specific provider, flush its cache first
			if (shouldRefresh && providerFilter && modelFetchPromises.length > 0) {
				const targetCandidate = modelFetchPromises[0]
				await flushModels(targetCandidate.options, true)
			}

			const results = await Promise.allSettled(
				modelFetchPromises.map(async ({ key, options }) => {
					const models = await safeGetModels(options)
					return { key, models } // The key is `ProviderName` here.
				}),
			)

			results.forEach((result, index) => {
				const routerName = modelFetchPromises[index].key

				if (result.status === "fulfilled") {
					routerModels[routerName] = result.value.models

					// Ollama and LM Studio settings pages still need these events. They are not fetched here.
				} else {
					// Handle rejection: Post a specific error message for this provider.
					const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason)
					console.error(`Error fetching models for ${routerName}:`, result.reason)

					routerModels[routerName] = {} // Ensure it's an empty object in the main routerModels message.

					void provider.postMessageToWebview({
						type: "singleRouterModelFetchResponse",
						success: false,
						error: errorMessage,
						values: { provider: routerName },
					})
				}
			})

			await provider.postMessageToWebview({
				type: "routerModels",
				routerModels,
				values: providerFilter ? { provider: requestedProvider } : undefined,
			})
			break
		}
		case "requestOllamaModels": {
			// Specific handler for Ollama models only.
			const { apiConfiguration: ollamaApiConfig } = await provider.getState()
			// Prefer the baseUrl/apiKey from the message values (which reflect
			// the user's unsaved edits in the settings form) over the saved
			// state, so the refresh uses the URL the user is actually looking
			// at — not the stale one from before they started editing.
			const baseUrl = message.values?.baseUrl ?? ollamaApiConfig.ollamaBaseUrl
			const apiKey = message.values?.apiKey ?? ollamaApiConfig.ollamaApiKey
			const logBaseUrl = baseUrl || "http://localhost:11434"
			const ollamaOptions = {
				provider: "ollama" as const,
				baseUrl,
				apiKey,
			}
			try {
				// Refresh the cache before reading the models. Keep this error
				// separate from the read below so diagnostics identify which
				// cache operation failed.
				await flushModels(ollamaOptions, true)
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error)
				provider.log(`[requestOllamaModels] Failed to refresh model cache for ${logBaseUrl}: ${errorMsg}`)
				await provider.postMessageToWebview({
					type: "ollamaModels",
					ollamaModels: {},
					error: errorMsg,
				})
				break
			}

			try {
				const ollamaModels = await getModels(ollamaOptions)

				// Always post a response so the webview refresh status can
				// transition out of "loading" — even when no models are found.
				await provider.postMessageToWebview({ type: "ollamaModels", ollamaModels })
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error)
				provider.log(`[requestOllamaModels] Failed to read models for ${logBaseUrl}: ${errorMsg}`)
				await provider.postMessageToWebview({
					type: "ollamaModels",
					ollamaModels: {},
					error: errorMsg,
				})
			}
			break
		}
		case "requestLmStudioModels": {
			// Specific handler for LM Studio models only.
			const { apiConfiguration: lmStudioApiConfig } = await provider.getState()
			try {
				const requestedBaseUrl = message.values?.baseUrl
				const hasPreviewBaseUrl = typeof requestedBaseUrl === "string"
				let lmStudioModels: ModelRecord
				if (hasPreviewBaseUrl) {
					lmStudioModels = await getLMStudioModels(requestedBaseUrl)
				} else {
					const lmStudioOptions = {
						provider: "lmstudio" as const,
						baseUrl: lmStudioApiConfig.lmStudioBaseUrl,
					}
					// Flush cache and refresh to ensure fresh models.
					await flushModels(lmStudioOptions, true)
					lmStudioModels = await getModels(lmStudioOptions)
				}

				if (Object.keys(lmStudioModels).length > 0) {
					await provider.postMessageToWebview({
						type: "lmStudioModels",
						lmStudioModels: lmStudioModels,
					})
				}
			} catch (error) {
				// Silently fail - user hasn't configured LM Studio yet.
				console.debug("LM Studio models fetch failed:", error)
			}
			break
		}
		case "requestRooModels": {
			await provider.postMessageToWebview({
				type: "singleRouterModelFetchResponse",
				success: false,
				error: getRouterRemovalMessage(),
				values: { provider: "roo" },
			})
			break
		}
		case "requestOpenAiModels":
			if (message?.values?.baseUrl) {
				const openAiModelInfo = await getOpenAiModelInfo(
					message?.values?.baseUrl,
					message?.values?.apiKey,
					message?.values?.openAiHeaders,
				)

				await provider.postMessageToWebview({
					type: "openAiModels",
					openAiModels: Object.keys(openAiModelInfo),
					openAiModelInfo,
				})
			}

			break
		case "requestProviderModels":
			await handleRequestProviderModels(provider, message.values, {
				getModels,
				flushModels,
				getOpenAiModels,
				getVsCodeLmModels,
				getKimiCodeAccessToken: async () => {
					const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
					return kimiCodeOAuthManager.getAccessToken()
				},
			})
			break
		case "requestVsCodeLmModels":
			const vsCodeLmModels = await getVsCodeLmModels()
			// TODO: Cache like we do for OpenRouter, etc?
			await provider.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels })
			break
		case "openImage":
			await openImage(message.text!, { values: message.values })
			break
		case "saveImage":
			if (message.dataUri) {
				const matches = message.dataUri.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/)
				if (!matches) {
					// Let saveImage handle invalid URI error
					await saveImage(message.dataUri, vscode.Uri.file(""))
					break
				}
				const format = matches[1]
				const defaultFileName = `img_${Date.now()}.${format}`

				const defaultUri = await resolveDefaultSaveUri(
					provider.contextProxy,
					"lastImageSavePath",
					defaultFileName,
					{
						useWorkspace: false,
						fallbackDir: path.join(os.homedir(), "Downloads"),
					},
				)

				const savedUri = await saveImage(message.dataUri, defaultUri)

				if (savedUri) {
					await saveLastExportPath(provider.contextProxy, "lastImageSavePath", savedUri)
				}
			}
			break
		case "openFile":
			let filePath: string = message.text!
			if (!path.isAbsolute(filePath)) {
				filePath = path.join(getCurrentCwd(), filePath)
			}
			await openFile(filePath, message.values as { create?: boolean; content?: string; line?: number })
			break
		case "readFileContent": {
			const relPath = message.text || ""
			if (!relPath) {
				await provider.postMessageToWebview({
					type: "fileContent",
					fileContent: { path: relPath, content: null, error: "No path provided" },
				})
				break
			}
			try {
				const cwd = getCurrentCwd()
				if (!cwd) {
					await provider.postMessageToWebview({
						type: "fileContent",
						fileContent: { path: relPath, content: null, error: "No workspace path available" },
					})
					break
				}
				const absPath = path.resolve(cwd, relPath)
				// Workspace-boundary validation: prevent path traversal attacks
				if (isPathOutsideWorkspace(absPath)) {
					await provider.postMessageToWebview({
						type: "fileContent",
						fileContent: { path: relPath, content: null, error: "Path is outside workspace" },
					})
					break
				}
				const content = await fs.readFile(absPath, "utf-8")
				await provider.postMessageToWebview({ type: "fileContent", fileContent: { path: relPath, content } })
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				await provider.postMessageToWebview({
					type: "fileContent",
					fileContent: { path: relPath, content: null, error: errorMsg },
				})
			}
			break
		}
		case "openMention":
			await openMention(getCurrentCwd(), message.text)
			break
		case "openExternal":
			if (message.url) {
				vscode.env.openExternal(vscode.Uri.parse(message.url))
			}
			break
		case "cancelTask":
			await provider.cancelTask()
			break
		case "allowedCommands": {
			// Validate and sanitize the commands array
			const commands = message.commands ?? []
			const validCommands = Array.isArray(commands)
				? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			await updateGlobalState("allowedCommands", validCommands)

			// Also update workspace settings.
			await vscode.workspace
				.getConfiguration(Package.name)
				.update("allowedCommands", validCommands, vscode.ConfigurationTarget.Global)

			break
		}
		case "deniedCommands": {
			// Validate and sanitize the commands array
			const commands = message.commands ?? []
			const validCommands = Array.isArray(commands)
				? commands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
				: []

			await updateGlobalState("deniedCommands", validCommands)

			// Also update workspace settings.
			await vscode.workspace
				.getConfiguration(Package.name)
				.update("deniedCommands", validCommands, vscode.ConfigurationTarget.Global)

			break
		}
		case "openCustomModesSettings": {
			const customModesFilePath = await provider.customModesManager.getCustomModesFilePath()

			if (customModesFilePath) {
				await openFile(customModesFilePath)
			}

			break
		}
		case "openTerminalProfilePicker": {
			// Open VS Code's native terminal profile picker so the user can set the
			// default shell without leaving VS Code's own settings UI.
			await vscode.commands.executeCommand("workbench.action.terminal.selectDefaultShell")
			break
		}
		case "openKeyboardShortcuts": {
			// Open VSCode keyboard shortcuts settings and optionally filter to show the Roo Code commands
			const searchQuery = message.text || ""
			if (searchQuery) {
				// Open with a search query pre-filled
				await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", searchQuery)
			} else {
				// Just open the keyboard shortcuts settings
				await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings")
			}
			break
		}
		case "openMcpSettings": {
			const mcpSettingsFilePath = await provider.getMcpHub()?.getMcpSettingsFilePath()

			if (mcpSettingsFilePath) {
				await openFile(mcpSettingsFilePath)
			}

			break
		}
		case "openProjectMcpSettings": {
			if (process.env.OCTOCODE_ENVIRONMENTS) {
				const settings = await provider.getMcpHub()?.getMcpSettingsFilePath()
				if (settings) await openFile(settings)
				break
			}
			if (!vscode.workspace.workspaceFolders?.length) {
				vscode.window.showErrorMessage(t("common:errors.no_workspace"))
				return
			}

			const workspaceFolder = getCurrentCwd()
			const rooDir = path.join(workspaceFolder, ".roo")
			const mcpPath = path.join(rooDir, "mcp.json")

			try {
				await fs.mkdir(rooDir, { recursive: true })
				const exists = await fileExistsAtPath(mcpPath)

				if (!exists) {
					await safeWriteJson(mcpPath, { mcpServers: {} }, { prettyPrint: true })
				}

				await openFile(mcpPath)
			} catch (error) {
				vscode.window.showErrorMessage(t("mcp:errors.create_json", { error: `${error}` }))
			}

			break
		}
		case "deleteMcpServer": {
			if (!message.serverName) {
				break
			}

			try {
				provider.log(`Attempting to delete MCP server: ${message.serverName}`)
				await provider.getMcpHub()?.deleteServer(message.serverName, message.source as "global" | "project")
				provider.log(`Successfully deleted MCP server: ${message.serverName}`)

				// Refresh the webview state
				await provider.postStateToWebview()
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Failed to delete MCP server: ${errorMessage}`)
				// Error messages are already handled by McpHub.deleteServer
			}
			break
		}
		case "restartMcpServer": {
			try {
				await provider.getMcpHub()?.restartConnection(message.text!, message.source as "global" | "project")
			} catch (error) {
				provider.log(
					`Failed to retry connection for ${message.text}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleToolAlwaysAllow": {
			try {
				await provider
					.getMcpHub()
					?.toggleToolAlwaysAllow(
						message.serverName!,
						message.source as "global" | "project",
						message.toolName!,
						Boolean(message.alwaysAllow),
					)
			} catch (error) {
				provider.log(
					`Failed to toggle auto-approve for tool ${message.toolName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleToolEnabledForPrompt": {
			try {
				await provider
					.getMcpHub()
					?.toggleToolEnabledForPrompt(
						message.serverName!,
						message.source as "global" | "project",
						message.toolName!,
						Boolean(message.isEnabled),
					)
			} catch (error) {
				provider.log(
					`Failed to toggle enabled for prompt for tool ${message.toolName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "toggleMcpServer": {
			try {
				await provider
					.getMcpHub()
					?.toggleServerDisabled(
						message.serverName!,
						message.disabled!,
						message.source as "global" | "project",
					)
				await provider.postStateToWebview()
			} catch (error) {
				provider.log(
					`Failed to toggle MCP server ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
		case "taskSyncEnabled":
			provider.log("Ignoring taskSyncEnabled update because cloud task sync is disabled")
			break

		case "refreshAllMcpServers": {
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				await mcpHub.refreshAllConnections()
			}

			break
		}

		case "ttsEnabled":
			const ttsEnabled = message.bool ?? true
			await updateGlobalState("ttsEnabled", ttsEnabled)
			setTtsEnabled(ttsEnabled)
			await provider.postStateToWebview()
			break
		case "ttsSpeed":
			const ttsSpeed = message.value ?? 1.0
			await updateGlobalState("ttsSpeed", ttsSpeed)
			setTtsSpeed(ttsSpeed)
			await provider.postStateToWebview()
			break
		case "playTts":
			if (message.text) {
				void playTts(message.text, {
					onStart: () => provider.postMessageToWebview({ type: "ttsStart", text: message.text }),
					onStop: () => provider.postMessageToWebview({ type: "ttsStop", text: message.text }),
				})
			}

			break
		case "stopTts":
			stopTts()
			break

		case "updateVSCodeSetting": {
			const { setting } = message
			const value = message.bool ?? message.value

			if (setting !== undefined && value !== undefined) {
				if (ALLOWED_VSCODE_SETTINGS.has(setting)) {
					await vscode.workspace.getConfiguration().update(setting, value, true)
				} else {
					vscode.window.showErrorMessage(t("common:ui.restrictedSetting", { setting }))
				}
			}

			break
		}
		case "getVSCodeSetting":
			const { setting } = message

			if (setting) {
				try {
					await provider.postMessageToWebview({
						type: "vsCodeSetting",
						setting,
						value: vscode.workspace.getConfiguration().get(setting),
					})
				} catch (error) {
					console.error(`Failed to get VSCode setting ${message.setting}:`, error)

					await provider.postMessageToWebview({
						type: "vsCodeSetting",
						setting,
						error: `Failed to get setting: ${error.message}`,
						value: undefined,
					})
				}
			}

			break

		case "requestTerminalProfiles": {
			// Allowlisted request: read VS Code's terminal profiles server-side and
			// return only the sanitized profile names. The terminal profile dropdown
			// only needs names, so this avoids routing it through the generic
			// `getVSCodeSetting` handler (which reads any key the webview supplies).
			// Only profiles with a resolvable `path` are returned — source-only
			// profiles (e.g. { source: "PowerShell" }) cannot be mapped to a shell
			// binary by an extension and would silently fall back to the default.
			try {
				await provider.postMessageToWebview({
					type: "terminalProfiles",
					profiles: Terminal.getAvailableProfileNames(),
				})
			} catch (error) {
				console.error("Failed to get terminal profiles:", error)
				await provider.postMessageToWebview({ type: "terminalProfiles", profiles: [] })
			}

			break
		}

		case "mode":
			await provider.handleModeSwitch(message.text as Mode)
			break
		case "updatePrompt":
			if (message.promptMode && message.customPrompt !== undefined) {
				const existingPrompts = getGlobalState("customModePrompts") ?? {}
				const updatedPrompts = { ...existingPrompts, [message.promptMode]: message.customPrompt }
				await updateGlobalState("customModePrompts", updatedPrompts)
				const currentState = await provider.getStateToPostToWebview()
				const stateWithPrompts = {
					...currentState,
					customModePrompts: updatedPrompts,
					hasOpenedModeSelector: currentState.hasOpenedModeSelector ?? false,
				}
				await provider.postMessageToWebview({ type: "state", state: stateWithPrompts })

				if (TelemetryService.hasInstance()) {
					// Determine which setting was changed by comparing objects
					const oldPrompt = existingPrompts[message.promptMode] || {}
					const newPrompt = message.customPrompt
					const changedSettings = Object.keys(newPrompt).filter(
						(key) =>
							JSON.stringify((oldPrompt as Record<string, unknown>)[key]) !==
							JSON.stringify((newPrompt as Record<string, unknown>)[key]),
					)

					if (changedSettings.length > 0) {
						TelemetryService.instance.captureModeSettingChanged(changedSettings[0])
					}
				}
			}
			break

		case "hasOpenedModeSelector":
			await updateGlobalState("hasOpenedModeSelector", message.bool ?? true)
			await provider.postStateToWebview()
			break

		case "lockApiConfigAcrossModes": {
			const enabled = message.bool ?? false
			await provider.context.workspaceState.update("lockApiConfigAcrossModes", enabled)

			await provider.postStateToWebview()
			break
		}

		case "toggleApiConfigPin":
			if (message.text) {
				const currentPinned = getGlobalState("pinnedApiConfigs") ?? {}
				const updatedPinned: Record<string, boolean> = { ...currentPinned }

				if (currentPinned[message.text]) {
					delete updatedPinned[message.text]
				} else {
					updatedPinned[message.text] = true
				}

				await updateGlobalState("pinnedApiConfigs", updatedPinned)
				await provider.postStateToWebview()
			}
			break
		case "enhancementApiConfigId":
			await updateGlobalState("enhancementApiConfigId", message.text)
			await provider.postStateToWebview()
			break

		case "autoApprovalEnabled":
			await updateGlobalState("autoApprovalEnabled", message.bool ?? false)
			await provider.postStateToWebview()
			break
		case "permissionProfile":
			if (["review", "directory", "full"].includes(message.text ?? "")) {
				await updateGlobalState("permissionProfile", message.text as "review" | "directory" | "full")
				await provider.postStateToWebview()
			}
			break
		case "enhancePrompt":
			if (message.text) {
				try {
					const state = await provider.getState()

					const {
						apiConfiguration,
						customSupportPrompts,
						listApiConfigMeta = [],
						enhancementApiConfigId,
						includeTaskHistoryInEnhance,
					} = state
					const { ClineProvider } = await import("./ClineProvider")
					const sessionId = ClineProvider.getActiveRuntimeTask()?.sessionId
					let runtimeMessages: unknown[] = []
					if (includeTaskHistoryInEnhance && sessionId) {
						const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
						const rows = await getOctoCodeRuntime().call<unknown>("message.list", { session_id: sessionId })
						if (!Array.isArray(rows)) throw new Error("Runtime history is unavailable")
						runtimeMessages = rows
					}

					const result = await MessageEnhancer.enhanceMessage({
						text: message.text,
						apiConfiguration,
						customSupportPrompts,
						listApiConfigMeta,
						enhancementApiConfigId,
						includeTaskHistoryInEnhance,
						runtimeMessages,
						providerSettingsManager: provider.providerSettingsManager,
					})

					if (result.success && result.enhancedText) {
						MessageEnhancer.captureTelemetry(
							sessionId,
							Boolean(includeTaskHistoryInEnhance && runtimeMessages.length),
						)
						await provider.postMessageToWebview({ type: "enhancedPrompt", text: result.enhancedText })
					} else {
						throw new Error(result.error || "Unknown error")
					}
				} catch (error) {
					/*
					 * Say enough to diagnose, and nothing the user wrote.
					 *
					 * The bare "Prompt enhancement failed" line is kept deliberately: the
					 * thrown error can carry the conversation it was enhancing, or a
					 * provider echoing it back, so its message must not reach a log file.
					 * What can: the error's type, the network code underneath it, and the
					 * configuration being used. Those are the three things that differ
					 * between a working setup and a broken one, and none of them is
					 * content — which is why this failure used to be undiagnosable.
					 */
					provider.log("Prompt enhancement failed")
					const cause = (error as { cause?: { code?: string } })?.cause
					const code = (error as { code?: string })?.code ?? cause?.code
					const kind = error instanceof Error ? error.name : typeof error
					const state = await provider.getState().catch(() => undefined)
					const config = state?.apiConfiguration
					const endpoint = config?.openAiNativeBaseUrl || config?.openAiBaseUrl || config?.ollamaBaseUrl || ""
					provider.log(
						`[enhance] ${kind}${code ? ` (${code})` : ""} provider=${config?.apiProvider ?? "unset"} model=${config?.apiModelId ?? "unset"} endpoint=${endpoint || "unset"}`,
					)
					// An unconfigured provider is the ordinary state of a fresh install and
					// deserves a sentence that says what to do, not a generic failure.
					vscode.window.showErrorMessage(
						config?.apiProvider
							? t("common:errors.enhance_prompt_detail", { error: code ?? kind })
							: t("common:errors.enhance_prompt_unconfigured"),
					)
					await provider.postMessageToWebview({ type: "enhancedPrompt" })
				}
			}
			break
		case "getSystemPrompt":
			try {
				const systemPrompt = await generateSystemPrompt(provider, message)

				await provider.postMessageToWebview({
					type: "systemPrompt",
					text: systemPrompt,
					mode: message.mode,
				})
			} catch (error) {
				provider.log(
					`Error getting system prompt:  ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
			}
			break
		case "copySystemPrompt":
			try {
				const systemPrompt = await generateSystemPrompt(provider, message)

				await vscode.env.clipboard.writeText(systemPrompt)
				await vscode.window.showInformationMessage(t("common:info.clipboard_copy"))
			} catch (error) {
				provider.log(
					`Error getting system prompt:  ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
			}
			break
		case "searchCommits": {
			const cwd = getCurrentCwd()
			if (cwd) {
				try {
					const commits = await searchCommits(message.query || "", cwd)
					await provider.postMessageToWebview({
						type: "commitSearchResults",
						commits,
					})
				} catch (error) {
					provider.log(
						`Error searching commits: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.search_commits"))
				}
			}
			break
		}
		case "searchFiles": {
			const workspacePath = getCurrentCwd()

			if (!workspacePath) {
				// Handle case where workspace path is not available
				await provider.postMessageToWebview({
					type: "fileSearchResults",
					results: [],
					requestId: message.requestId,
					error: "No workspace path available",
				})
				break
			}
			try {
				// Call file search service with query from message
				const results = await searchWorkspaceFiles(
					message.query || "",
					workspacePath,
					20, // Use default limit, as filtering is now done in the backend
				)

				const tempController = new RooIgnoreController(workspacePath)
				await tempController.initialize()
				const rooIgnoreController = tempController
				try {
					// Get showRooIgnoredFiles setting from state
					const { showRooIgnoredFiles = false } = (await provider.getState()) ?? {}

					// Filter results using RooIgnoreController if showRooIgnoredFiles is false
					let filteredResults = results
					if (!showRooIgnoredFiles && rooIgnoreController) {
						const allowedPaths = rooIgnoreController.filterPaths(results.map((r) => r.path))
						filteredResults = results.filter((r) => allowedPaths.includes(r.path))
					}

					// Send results back to webview
					await provider.postMessageToWebview({
						type: "fileSearchResults",
						results: filteredResults,
						requestId: message.requestId,
					})
				} finally {
					// Dispose temporary controller to prevent resource leak
					tempController?.dispose()
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				// Send error response to webview
				await provider.postMessageToWebview({
					type: "fileSearchResults",
					results: [],
					error: errorMessage,
					requestId: message.requestId,
				})
			}
			break
		}
		case "saveApiConfiguration":
			if (message.text && message.apiConfiguration) {
				try {
					await provider.providerSettingsManager.saveConfig(message.text, message.apiConfiguration)
					const listApiConfig = await provider.providerSettingsManager.listConfig()
					await updateGlobalState("listApiConfigMeta", listApiConfig)
				} catch (error) {
					provider.log(
						`Error save api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.save_api_config"))
				}
			}
			break
		case "upsertApiConfiguration":
			if (message.text && message.apiConfiguration) {
				await provider.upsertProviderProfile(message.text, message.apiConfiguration)
			}
			break
		case "renameApiConfiguration":
			if (message.values && message.apiConfiguration) {
				try {
					const { oldName, newName } = message.values

					if (oldName === newName) {
						break
					}

					// Load the old configuration to get its ID.
					const { id } = await provider.providerSettingsManager.getProfile({ name: oldName })

					// Create a new configuration with the new name and old ID.
					await provider.providerSettingsManager.saveConfig(newName, { ...message.apiConfiguration, id })

					// Delete the old configuration.
					await provider.providerSettingsManager.deleteConfig(oldName)

					// Re-activate to update the global settings related to the
					// currently activated provider profile.
					await provider.activateProviderProfile({ name: newName })
				} catch (error) {
					provider.log(
						`Error rename api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)

					vscode.window.showErrorMessage(t("common:errors.rename_api_config"))
				}
			}
			break
		case "loadApiConfiguration":
			if (message.text) {
				try {
					await provider.activateProviderProfile({ name: message.text })
				} catch (error) {
					provider.log(
						`Error load api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.load_api_config"))
				}
			}
			break
		case "loadApiConfigurationById":
			if (message.text) {
				try {
					await provider.activateProviderProfile({ id: message.text })
				} catch (error) {
					provider.log(
						`Error load api configuration by ID: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.load_api_config"))
				}
			}
			break
		case "deleteApiConfiguration":
			if (message.text) {
				const answer = await vscode.window.showInformationMessage(
					t("common:confirmation.delete_config_profile"),
					{ modal: true },
					t("common:answers.yes"),
				)

				if (answer !== t("common:answers.yes")) {
					break
				}

				const oldName = message.text

				const newName = (await provider.providerSettingsManager.listConfig()).filter(
					(c) => c.name !== oldName,
				)[0]?.name

				if (!newName) {
					vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
					return
				}

				try {
					await provider.providerSettingsManager.deleteConfig(oldName)
					await provider.activateProviderProfile({ name: newName })
				} catch (error) {
					provider.log(
						`Error delete api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)

					vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
				}
			}
			break
		case "getListApiConfiguration":
			try {
				const listApiConfig = await provider.providerSettingsManager.listConfig()
				await updateGlobalState("listApiConfigMeta", listApiConfig)
				await provider.postMessageToWebview({ type: "listApiConfig", listApiConfig })
			} catch (error) {
				provider.log(
					`Error get list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.list_api_config"))
			}
			break

		case "updateMcpTimeout":
			if (message.serverName && typeof message.timeout === "number") {
				try {
					await provider
						.getMcpHub()
						?.updateServerTimeout(
							message.serverName,
							message.timeout,
							message.source as "global" | "project",
						)
				} catch (error) {
					provider.log(
						`Failed to update timeout for ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
					vscode.window.showErrorMessage(t("common:errors.update_server_timeout"))
				}
			}
			break
		case "updateCustomMode":
			if (message.modeConfig) {
				try {
					// Check if this is a new mode or an update to an existing mode
					const existingModes = await provider.customModesManager.getCustomModes()
					const isNewMode = !existingModes.some((mode) => mode.slug === message.modeConfig?.slug)

					await provider.customModesManager.updateCustomMode(message.modeConfig.slug, message.modeConfig)
					// Update state after saving the mode
					const customModes = await provider.customModesManager.getCustomModes()
					await updateGlobalState("customModes", customModes)
					await updateGlobalState("mode", message.modeConfig.slug)
					await provider.postStateToWebview()

					// Track telemetry for custom mode creation or update
					if (TelemetryService.hasInstance()) {
						if (isNewMode) {
							// This is a new custom mode
							TelemetryService.instance.captureCustomModeCreated(
								message.modeConfig.slug,
								message.modeConfig.name,
							)
						} else {
							// Determine which setting was changed by comparing objects
							const existingMode = existingModes.find((mode) => mode.slug === message.modeConfig?.slug)
							const changedSettings = existingMode
								? Object.keys(message.modeConfig).filter(
										(key) =>
											JSON.stringify((existingMode as Record<string, unknown>)[key]) !==
											JSON.stringify((message.modeConfig as Record<string, unknown>)[key]),
									)
								: []

							if (changedSettings.length > 0) {
								TelemetryService.instance.captureModeSettingChanged(changedSettings[0])
							}
						}
					}
				} catch (error) {
					// Error already shown to user by updateCustomMode
					// Just prevent unhandled rejection and skip state updates
				}
			}
			break
		case "deleteCustomMode":
			if (message.slug) {
				// Get the mode details to determine source and rules folder path
				const customModes = await provider.customModesManager.getCustomModes()
				const modeToDelete = customModes.find((mode) => mode.slug === message.slug)

				if (!modeToDelete) {
					break
				}

				// Determine the scope based on source (project or global)
				const scope = modeToDelete.source || "global"

				// Determine the rules folder path
				let rulesFolderPath: string
				if (scope === "project") {
					const workspacePath = getWorkspacePath()
					if (workspacePath) {
						rulesFolderPath = path.join(workspacePath, ".roo", `rules-${message.slug}`)
					} else {
						rulesFolderPath = path.join(".roo", `rules-${message.slug}`)
					}
				} else {
					// Global scope - use OS home directory
					const homeDir = os.homedir()
					rulesFolderPath = path.join(homeDir, ".roo", `rules-${message.slug}`)
				}

				// Check if the rules folder exists
				const rulesFolderExists = await fileExistsAtPath(rulesFolderPath)

				// If this is a check request, send back the folder info
				if (message.checkOnly) {
					await provider.postMessageToWebview({
						type: "deleteCustomModeCheck",
						slug: message.slug,
						rulesFolderPath: rulesFolderExists ? rulesFolderPath : undefined,
					})
					break
				}

				// Delete the mode
				await provider.customModesManager.deleteCustomMode(message.slug)

				// Delete the rules folder if it exists
				if (rulesFolderExists) {
					try {
						await fs.rm(rulesFolderPath, { recursive: true, force: true })
						provider.log(`Deleted rules folder for mode ${message.slug}: ${rulesFolderPath}`)
					} catch (error) {
						provider.log(`Failed to delete rules folder for mode ${message.slug}: ${error}`)
						// Notify the user about the failure
						vscode.window.showErrorMessage(
							t("common:errors.delete_rules_folder_failed", {
								rulesFolderPath,
								error: error instanceof Error ? error.message : String(error),
							}),
						)
						// Continue with mode deletion even if folder deletion fails
					}
				}

				// Switch back to default mode after deletion
				await updateGlobalState("mode", defaultModeSlug)
				await provider.postStateToWebview()
			}
			break
		case "exportMode":
			if (message.slug) {
				try {
					// Get custom mode prompts to check if built-in mode has been customized
					const customModePrompts = getGlobalState("customModePrompts") || {}
					const customPrompt = customModePrompts[message.slug]

					// Export the mode with any customizations merged directly
					const result = await provider.customModesManager.exportModeWithRules(message.slug, customPrompt)

					if (result.success && result.yaml) {
						const defaultUri = await resolveDefaultSaveUri(
							provider.contextProxy,
							"lastModeExportPath",
							`${message.slug}-export.yaml`,
							{
								useWorkspace: true,
								fallbackDir: path.join(os.homedir(), "Downloads"),
							},
						)

						// Show save dialog
						const saveUri = await vscode.window.showSaveDialog({
							defaultUri,
							filters: {
								"YAML files": ["yaml", "yml"],
							},
							title: "Save mode export",
						})

						if (saveUri && result.yaml) {
							// Save the directory for next time
							await saveLastExportPath(provider.contextProxy, "lastModeExportPath", saveUri)

							// Write the file to the selected location
							await fs.writeFile(saveUri.fsPath, result.yaml, "utf-8")

							// Send success message to webview
							await provider.postMessageToWebview({
								type: "exportModeResult",
								success: true,
								slug: message.slug,
							})

							// Show info message
							vscode.window.showInformationMessage(t("common:info.mode_exported", { mode: message.slug }))
						} else {
							// User cancelled the save dialog
							await provider.postMessageToWebview({
								type: "exportModeResult",
								success: false,
								error: "Export cancelled",
								slug: message.slug,
							})
						}
					} else {
						// Send error message to webview
						await provider.postMessageToWebview({
							type: "exportModeResult",
							success: false,
							error: result.error,
							slug: message.slug,
						})
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					provider.log(`Failed to export mode ${message.slug}: ${errorMessage}`)

					// Send error message to webview
					await provider.postMessageToWebview({
						type: "exportModeResult",
						success: false,
						error: errorMessage,
						slug: message.slug,
					})
				}
			}
			break
		case "importMode":
			try {
				// Get last used directory for import
				const lastImportPath = getGlobalState("lastModeImportPath")
				let defaultUri: vscode.Uri | undefined

				if (lastImportPath) {
					// Use the directory from the last import
					const lastDir = path.dirname(lastImportPath)
					defaultUri = vscode.Uri.file(lastDir)
				} else {
					// Default to workspace or home directory
					const workspaceFolders = vscode.workspace.workspaceFolders
					if (workspaceFolders && workspaceFolders.length > 0) {
						defaultUri = vscode.Uri.file(workspaceFolders[0].uri.fsPath)
					}
				}

				// Show file picker to select YAML file
				const fileUri = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					defaultUri,
					filters: {
						"YAML files": ["yaml", "yml"],
					},
					title: "Select mode export file to import",
				})

				if (fileUri && fileUri[0]) {
					// Save the directory for next time
					await updateGlobalState("lastModeImportPath", fileUri[0].fsPath)

					// Read the file content
					const yamlContent = await fs.readFile(fileUri[0].fsPath, "utf-8")

					// Import the mode with the specified source level
					const result = await provider.customModesManager.importModeWithRules(
						yamlContent,
						message.source || "project", // Default to project if not specified
					)

					if (result.success) {
						// Update state after importing
						const customModes = await provider.customModesManager.getCustomModes()
						await updateGlobalState("customModes", customModes)
						await provider.postStateToWebview()

						// Send success message to webview, include the imported slug so UI can switch
						await provider.postMessageToWebview({
							type: "importModeResult",
							success: true,
							slug: result.slug,
						})

						// Show success message
						vscode.window.showInformationMessage(t("common:info.mode_imported"))
					} else {
						// Send error message to webview
						await provider.postMessageToWebview({
							type: "importModeResult",
							success: false,
							error: result.error,
						})

						// Show error message
						vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: result.error }))
					}
				} else {
					// User cancelled the file dialog - reset the importing state
					await provider.postMessageToWebview({
						type: "importModeResult",
						success: false,
						error: "cancelled",
					})
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Failed to import mode: ${errorMessage}`)

				// Send error message to webview
				await provider.postMessageToWebview({
					type: "importModeResult",
					success: false,
					error: errorMessage,
				})

				// Show error message
				vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: errorMessage }))
			}
			break
		case "checkRulesDirectory":
			if (message.slug) {
				const hasContent = await provider.customModesManager.checkRulesDirectoryHasContent(message.slug)

				await provider.postMessageToWebview({
					type: "checkRulesDirectoryResult",
					slug: message.slug,
					hasContent: hasContent,
				})
			}
			break
		case "telemetrySetting": {
			const telemetrySetting = message.text as TelemetrySetting
			const previousSetting = getGlobalState("telemetrySetting") || "unset"
			const isOptedIn = telemetrySetting === "enabled"
			const wasPreviouslyOptedIn = previousSetting === "enabled"

			// If turning telemetry OFF, fire event BEFORE disabling
			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, telemetrySetting)
			}

			// Update the telemetry state
			await updateGlobalState("telemetrySetting", telemetrySetting)

			if (TelemetryService.hasInstance()) {
				TelemetryService.instance.updateTelemetryState(isOptedIn)
			}

			// If turning telemetry ON, fire event AFTER enabling
			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, telemetrySetting)
			}

			await provider.postStateToWebview()
			break
		}
		case "debugSetting": {
			await vscode.workspace
				.getConfiguration(Package.name)
				.update("debug", message.bool ?? false, vscode.ConfigurationTarget.Global)
			await provider.postStateToWebview()
			break
		}
		case "rooCloudSignIn": {
			if (!isCloudServiceAvailable()) {
				provider.log("CloudService unavailable; ignoring rooCloudSignIn")
				showCloudUnavailableMessage()
				break
			}

			try {
				TelemetryService.instance.captureEvent(TelemetryEventName.AUTHENTICATION_INITIATED)
				// Use provider signup flow if useProviderSignup is explicitly true
				await CloudService.instance.login(undefined, message.useProviderSignup ?? false)
			} catch (error) {
				provider.log(`AuthService#login failed: ${error}`)
				vscode.window.showErrorMessage(t("common:ui.signInFailed"))
			}

			break
		}
		case "cloudLandingPageSignIn": {
			if (!isCloudServiceAvailable()) {
				provider.log("CloudService unavailable; ignoring cloudLandingPageSignIn")
				showCloudUnavailableMessage()
				break
			}

			try {
				const landingPageSlug = message.text || "supernova"
				TelemetryService.instance.captureEvent(TelemetryEventName.AUTHENTICATION_INITIATED)
				await CloudService.instance.login(landingPageSlug)
			} catch (error) {
				provider.log(`CloudService#login failed: ${error}`)
				vscode.window.showErrorMessage(t("common:ui.signInFailed"))
			}
			break
		}
		case "rooCloudSignOut": {
			if (!isCloudServiceAvailable()) {
				await provider.postStateToWebview()
				await provider.postMessageToWebview({ type: "authenticatedUser", userInfo: undefined })
				break
			}

			try {
				await CloudService.instance.logout()
				await provider.postStateToWebview()
				await provider.postMessageToWebview({ type: "authenticatedUser", userInfo: undefined })
			} catch (error) {
				provider.log(`AuthService#logout failed: ${error}`)
				vscode.window.showErrorMessage(t("common:ui.signOutFailed"))
			}

			break
		}
		case "openAiCodexSignIn": {
			try {
				const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
				const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()

				// Open the authorization URL in the browser
				await vscode.env.openExternal(vscode.Uri.parse(authUrl))

				// Wait for the callback in a separate promise (non-blocking)
				openAiCodexOAuthManager
					.waitForCallback()
					.then(async () => {
						vscode.window.showInformationMessage(t("common:ui.codexSignedIn"))
						await provider.postStateToWebview()
					})
					.catch((error) => {
						provider.log(`OpenAI Codex OAuth callback failed: ${error}`)
						if (!String(error).includes("timed out")) {
							vscode.window.showErrorMessage(
								t("common:ui.codexSignInError", { error: error.message || error }),
							)
						}
					})
			} catch (error) {
				provider.log(`OpenAI Codex OAuth failed: ${error}`)
				vscode.window.showErrorMessage(t("common:ui.codexSignInFailed"))
			}
			break
		}
		case "openAiCodexSignOut": {
			try {
				const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
				await openAiCodexOAuthManager.clearCredentials()
				vscode.window.showInformationMessage(t("common:ui.codexSignedOut"))
				await provider.postStateToWebview()
			} catch (error) {
				provider.log(`OpenAI Codex sign out failed: ${error}`)
				vscode.window.showErrorMessage(t("common:ui.codexSignOutFailed"))
			}
			break
		}
		case "kimiCodeSignIn": {
			try {
				const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
				const device = await kimiCodeOAuthManager.startAuthorization()
				await provider.postStateToWebview()
				await vscode.env.openExternal(
					vscode.Uri.parse(device.verificationUriComplete ?? device.verificationUri),
				)
				void kimiCodeOAuthManager
					.waitForAuthorization()
					.then(async () => {
						vscode.window.showInformationMessage(t("common:ui.kimiSignedIn"))
						await provider.postStateToWebview()
					})
					.catch(async (error) => {
						provider.log(`Kimi Code OAuth failed: ${error}`)
						await provider.postStateToWebview()
					})
			} catch (error) {
				provider.log(`Kimi Code OAuth failed: ${error}`)
				vscode.window.showErrorMessage(
					t("common:ui.kimiSignInError", { error: error instanceof Error ? error.message : error }),
				)
				await provider.postStateToWebview()
			}
			break
		}
		case "kimiCodeSignOut": {
			try {
				const { kimiCodeOAuthManager } = await import("../../integrations/kimi-code/oauth")
				await kimiCodeOAuthManager.clearCredentials()
				vscode.window.showInformationMessage(t("common:ui.kimiSignedOut"))
				await provider.postStateToWebview()
			} catch (error) {
				provider.log(`Kimi Code sign out failed: ${error}`)
				vscode.window.showErrorMessage(t("common:ui.kimiSignOutFailed"))
			}
			break
		}
		case "rooCloudManualUrl": {
			if (!isCloudServiceAvailable()) {
				provider.log("CloudService unavailable; ignoring rooCloudManualUrl")
				showCloudUnavailableMessage()
				break
			}

			try {
				if (!message.text) {
					vscode.window.showErrorMessage(t("common:errors.manual_url_empty"))
					break
				}

				// Parse the callback URL to extract parameters
				const callbackUrl = message.text.trim()
				const uri = vscode.Uri.parse(callbackUrl)

				if (!uri.query) {
					throw new Error(t("common:errors.manual_url_no_query"))
				}

				const query = new URLSearchParams(uri.query)
				const code = query.get("code")
				const state = query.get("state")
				const organizationId = query.get("organizationId")

				if (!code || !state) {
					throw new Error(t("common:errors.manual_url_missing_params"))
				}

				// Reuse the existing authentication flow
				await CloudService.instance.handleAuthCallback(
					code,
					state,
					organizationId === "null" ? null : organizationId,
				)

				await provider.postStateToWebview()
			} catch (error) {
				provider.log(`ManualUrl#handleAuthCallback failed: ${error}`)
				const errorMessage = error instanceof Error ? error.message : t("common:errors.manual_url_auth_failed")

				// Show error message through VS Code UI
				vscode.window.showErrorMessage(`${t("common:errors.manual_url_auth_error")}: ${errorMessage}`)
			}

			break
		}
		case "clearCloudAuthSkipModel": {
			// Clear the flag that indicates auth completed without model selection
			await provider.context.globalState.update("roo-auth-skip-model", undefined)
			await provider.postStateToWebview()
			break
		}
		case "octoCodeSignOut": {
			try {
				const { disconnectOctoCode } = await import("../../services/octocode-auth")
				await disconnectOctoCode()

				// Clear octoCodeSessionToken from ALL provider profiles with apiProvider === "octocode-gateway".
				// Profiles are user-renameable, so we cannot rely on a hardcoded name like "OctoCode Gateway".
				// We must scan all profiles and clear tokens from any that use the octocode-gateway provider.
				try {
					const allProfiles = await provider.providerSettingsManager.listConfig()
					// Check if OctoCode Gateway is the currently active profile by apiProvider identity
					const currentSettings = provider.contextProxy.getProviderSettings()
					const isOctoCodeGatewayActive = currentSettings.apiProvider === providerIdentifiers.octoCodeGateway
					const currentApiConfigName = provider.contextProxy.getValues().currentApiConfigName

					for (const entry of allProfiles) {
						if (entry.apiProvider !== providerIdentifiers.octoCodeGateway) {
							continue
						}

						// Isolate per-profile failures: a corrupted profile or a failed write
						// for one entry must not abort cleanup of the remaining profiles,
						// otherwise sign-out would leave later profiles with a stale token.
						try {
							const profile = await provider.providerSettingsManager.getProfile({ name: entry.name })
							const { octoCodeSessionToken: _removed, ...cleanedProfile } = profile

							// If this is the currently active profile, ALWAYS push to the in-memory
							// handler — even when the persisted profile has already been cleared —
							// because currentSettings (and therefore the live API handler) may still
							// carry a stale token from before sign-out. Persisted-only profiles get
							// rewritten only when they previously had a token to avoid no-op disk writes.
							const isThisProfileActive = isOctoCodeGatewayActive && currentApiConfigName === entry.name

							if (isThisProfileActive) {
								await provider.upsertProviderProfile(entry.name, cleanedProfile, true)
								provider.log(
									`[octoCodeSignOut] Cleared octoCodeSessionToken from "${entry.name}" profile and updated in-memory handler`,
								)
							} else if (profile.octoCodeSessionToken) {
								await provider.providerSettingsManager.saveConfig(entry.name, cleanedProfile)
								provider.log(
									`[octoCodeSignOut] Cleared octoCodeSessionToken from "${entry.name}" profile`,
								)
							}
						} catch (profileError) {
							// Log but continue to the next profile so one failure doesn't
							// leave other profiles holding a stale token.
							provider.log(
								`[octoCodeSignOut] Failed to clear profile token for "${entry.name}": ${profileError instanceof Error ? profileError.message : String(profileError)}`,
							)
						}
					}
				} catch (profileError) {
					// listConfig itself failed — nothing to iterate.
					provider.log(
						`[octoCodeSignOut] Failed to list profiles for token cleanup: ${profileError instanceof Error ? profileError.message : String(profileError)}`,
					)
				}

				await provider.postStateToWebview()
			} catch (error) {
				provider.log(
					`Failed to sign out of OctoCode: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "switchOrganization": {
			try {
				const organizationId = message.organizationId ?? null

				// Switch to the new organization context
				await CloudService.instance.switchOrganization(organizationId)

				// Refresh the state to update UI
				await provider.postStateToWebview()

				// Send success response back to webview
				await provider.postMessageToWebview({
					type: "organizationSwitchResult",
					success: true,
					organizationId: organizationId,
				})
			} catch (error) {
				provider.log(`Organization switch failed: ${error}`)
				const errorMessage = error instanceof Error ? error.message : String(error)

				// Send error response back to webview
				await provider.postMessageToWebview({
					type: "organizationSwitchResult",
					success: false,
					error: errorMessage,
					organizationId: message.organizationId ?? null,
				})

				vscode.window.showErrorMessage(t("common:ui.switchOrganization", { error: errorMessage }))
			}
			break
		}

		case "saveCodeIndexSettingsAtomic": {
			if (!message.codeIndexSettings) {
				break
			}

			const settings = message.codeIndexSettings

			try {
				// Check if embedder provider has changed
				const currentConfig = getGlobalState("codebaseIndexConfig") || {}
				const embedderProviderChanged =
					currentConfig.codebaseIndexEmbedderProvider !== settings.codebaseIndexEmbedderProvider

				// Save global state settings atomically
				const globalStateConfig = {
					...currentConfig,
					codebaseIndexEnabled: settings.codebaseIndexEnabled,
					codebaseIndexQdrantUrl: settings.codebaseIndexQdrantUrl,
					codebaseIndexEmbedderProvider: settings.codebaseIndexEmbedderProvider,
					codebaseIndexEmbedderBaseUrl: settings.codebaseIndexEmbedderBaseUrl,
					codebaseIndexEmbedderModelId: settings.codebaseIndexEmbedderModelId,
					codebaseIndexEmbedderModelDimension: settings.codebaseIndexEmbedderModelDimension, // Generic dimension
					codebaseIndexOpenAiCompatibleBaseUrl: settings.codebaseIndexOpenAiCompatibleBaseUrl,
					codebaseIndexBedrockRegion: settings.codebaseIndexBedrockRegion,
					codebaseIndexBedrockProfile: settings.codebaseIndexBedrockProfile,
					codebaseIndexSearchMaxResults: settings.codebaseIndexSearchMaxResults,
					codebaseIndexSearchMinScore: settings.codebaseIndexSearchMinScore,
					codebaseIndexOpenRouterSpecificProvider: settings.codebaseIndexOpenRouterSpecificProvider,
				}

				// Save global state first
				await updateGlobalState("codebaseIndexConfig", globalStateConfig)

				// Save secrets directly using context proxy
				if (settings.codeIndexOpenAiKey !== undefined) {
					await provider.contextProxy.storeSecret("codeIndexOpenAiKey", settings.codeIndexOpenAiKey)
				}
				if (settings.codeIndexQdrantApiKey !== undefined) {
					await provider.contextProxy.storeSecret("codeIndexQdrantApiKey", settings.codeIndexQdrantApiKey)
				}
				if (settings.codebaseIndexOpenAiCompatibleApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexOpenAiCompatibleApiKey",
						settings.codebaseIndexOpenAiCompatibleApiKey,
					)
				}
				if (settings.codebaseIndexGeminiApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexGeminiApiKey",
						settings.codebaseIndexGeminiApiKey,
					)
				}
				if (settings.codebaseIndexMistralApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexMistralApiKey",
						settings.codebaseIndexMistralApiKey,
					)
				}
				if (settings.codebaseIndexVercelAiGatewayApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexVercelAiGatewayApiKey",
						settings.codebaseIndexVercelAiGatewayApiKey,
					)
				}
				if (settings.codebaseIndexOpenRouterApiKey !== undefined) {
					await provider.contextProxy.storeSecret(
						"codebaseIndexOpenRouterApiKey",
						settings.codebaseIndexOpenRouterApiKey,
					)
				}

				// Send success response first - settings are saved regardless of validation
				await provider.postMessageToWebview({
					type: "codeIndexSettingsSaved",
					success: true,
					settings: globalStateConfig,
				})

				// Update webview state
				await provider.postStateToWebview()

				// Then handle validation and initialization for the current workspace
				const currentCodeIndexManager = provider.getCurrentWorkspaceCodeIndexManager()
				if (currentCodeIndexManager) {
					// If embedder provider changed, perform proactive validation
					if (embedderProviderChanged) {
						try {
							// Force handleSettingsChange which will trigger validation
							await currentCodeIndexManager.handleSettingsChange()
						} catch (error) {
							// Validation failed - the error state is already set by handleSettingsChange
							provider.log(
								`Embedder validation failed after provider change: ${error instanceof Error ? error.message : String(error)}`,
							)
							// Send validation error to webview
							await provider.postMessageToWebview({
								type: "indexingStatusUpdate",
								values: currentCodeIndexManager.getCurrentStatus(),
							})
							// Exit early - don't try to start indexing with invalid configuration
							break
						}
					} else {
						// No provider change, just handle settings normally
						try {
							await currentCodeIndexManager.handleSettingsChange()
						} catch (error) {
							// Log but don't fail - settings are saved
							provider.log(
								`Settings change handling error: ${error instanceof Error ? error.message : String(error)}`,
							)
						}
					}

					// Wait a bit more to ensure everything is ready
					await new Promise((resolve) => setTimeout(resolve, 200))

					// Auto-start indexing if now enabled and configured
					if (currentCodeIndexManager.isFeatureEnabled && currentCodeIndexManager.isFeatureConfigured) {
						if (!currentCodeIndexManager.isInitialized) {
							try {
								await currentCodeIndexManager.initialize(provider.contextProxy)
								provider.log(`Code index manager initialized after settings save`)
							} catch (error) {
								provider.log(
									`Code index initialization failed: ${error instanceof Error ? error.message : String(error)}`,
								)
								// Send error status to webview
								await provider.postMessageToWebview({
									type: "indexingStatusUpdate",
									values: currentCodeIndexManager.getCurrentStatus(),
								})
							}
						}
					}
				} else {
					provider.log("Code index settings saved; workspace activation is waiting for an open folder")
					await provider.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: {
							systemStatus: "Standby",
							message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
							processedItems: 0,
							totalItems: 0,
							currentItemUnit: "items",
						},
					})
				}
			} catch (error) {
				provider.log(`Error saving code index settings: ${error.message || error}`)
				await provider.postMessageToWebview({
					type: "codeIndexSettingsSaved",
					success: false,
					error: error.message || "Failed to save settings",
				})
			}
			break
		}

		case "requestIndexingStatus": {
			const manager = provider.getCurrentWorkspaceCodeIndexManager()
			if (!manager) {
				// Code indexing is workspace-scoped; an empty window is idle, not an indexing failure.
				await provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: {
						systemStatus: "Standby",
						message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
						processedItems: 0,
						totalItems: 0,
						currentItemUnit: "items",
						workspacePath: undefined,
					},
				})
				return
			}

			const status = manager
				? manager.getCurrentStatus()
				: {
						systemStatus: "Standby",
						message: "No workspace folder open",
						processedItems: 0,
						totalItems: 0,
						currentItemUnit: "items",
						workspacePath: undefined,
					}

			await provider.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: status,
			})
			break
		}
		case "requestUpdateStatus": {
			// The rail asks what the channel says. `check()` is inert without a
			// configured manifest URL, so an install that never chose an update
			// source answers "no channel" rather than reaching the network.
			const { UpdateService } = await import("../../services/update/UpdateService")
			const service = new UpdateService(provider.context, (message) => provider.log(message))
			const result = await service.check()
			// Whether a channel exists at all, not whether it offered something: an
			// up-to-date install has no manifest and must still read as configured.
			const channelConfigured =
				(vscode.workspace.getConfiguration().get<string>("octocode.update.manifestUrl") ?? "").trim().length > 0
			await provider.postMessageToWebview({
				type: "updateStatus",
				values: {
					available: result.available,
					current: result.current,
					version: result.manifest?.version,
					configured: channelConfigured,
					applying: false,
				},
			})
			break
		}
		case "applyUpdate": {
			// The rail's one-click update. `run(false)` skips the prompt the user
			// already answered by clicking, then installs, reloads and reports.
			const { UpdateService } = await import("../../services/update/UpdateService")
			const service = new UpdateService(provider.context, (message) => provider.log(message))
			let applied = false
			try {
				applied = await service.run(false)
			} catch (error) {
				provider.log(`[update] apply from rail failed: ${String(error)}`)
				vscode.window.showErrorMessage(String(error))
			} finally {
				const result = applied ? undefined : await service.check()
				await provider.postMessageToWebview({
					type: "updateStatus",
					values: {
						available: result?.available ?? false,
						current: result?.current ?? "",
						version: result?.manifest?.version,
						configured: true,
						applying: false,
					},
				})
			}
			break
		}
		case "requestCodeIndexSecretStatus": {
			// Check if secrets are set using the VSCode context directly for async access
			const hasOpenAiKey = !!(await provider.context.secrets.get("codeIndexOpenAiKey"))
			const hasQdrantApiKey = !!(await provider.context.secrets.get("codeIndexQdrantApiKey"))
			const hasOpenAiCompatibleApiKey = !!(await provider.context.secrets.get(
				"codebaseIndexOpenAiCompatibleApiKey",
			))
			const hasGeminiApiKey = !!(await provider.context.secrets.get("codebaseIndexGeminiApiKey"))
			const hasMistralApiKey = !!(await provider.context.secrets.get("codebaseIndexMistralApiKey"))
			const hasVercelAiGatewayApiKey = !!(await provider.context.secrets.get(
				"codebaseIndexVercelAiGatewayApiKey",
			))
			const hasOpenRouterApiKey = !!(await provider.context.secrets.get("codebaseIndexOpenRouterApiKey"))

			await provider.postMessageToWebview({
				type: "codeIndexSecretStatus",
				values: {
					hasOpenAiKey,
					hasQdrantApiKey,
					hasOpenAiCompatibleApiKey,
					hasGeminiApiKey,
					hasMistralApiKey,
					hasVercelAiGatewayApiKey,
					hasOpenRouterApiKey,
				},
			})
			break
		}
		case "startIndexing": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					await provider.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: {
							systemStatus: "Standby",
							message: t("embeddings:orchestrator.indexingRequiresWorkspace"),
							processedItems: 0,
							totalItems: 0,
							currentItemUnit: "items",
						},
					})
					provider.log("Cannot start indexing: No workspace folder open")
					return
				}

				// "Start Indexing" implicitly enables the workspace
				await manager.setWorkspaceEnabled(true)

				if (manager.isFeatureEnabled && manager.isFeatureConfigured) {
					await manager.initialize(provider.contextProxy)

					const currentState = manager.state
					if (currentState === "Standby" || currentState === "Error") {
						void manager.startIndexing().catch((err) => provider.log(`Indexing error: ${err}`))

						if (!manager.isInitialized) {
							await manager.initialize(provider.contextProxy)
							if (manager.state === "Standby" || manager.state === "Error") {
								void manager.startIndexing().catch((err) => provider.log(`Indexing error: ${err}`))
							}
						}
					}
				}
			} catch (error) {
				provider.log(`Error starting indexing: ${error instanceof Error ? error.message : String(error)}`)
			}
			break
		}
		case "stopIndexing": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot stop indexing: No workspace folder open")
					return
				}
				manager.stopIndexing()
				await provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: manager.getCurrentStatus(),
				})
			} catch (error) {
				provider.log(`Error stopping indexing: ${error instanceof Error ? error.message : String(error)}`)
			}
			break
		}
		case "toggleWorkspaceIndexing": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot toggle workspace indexing: No workspace folder open")
					return
				}
				const enabled = message.bool ?? false
				await manager.setWorkspaceEnabled(enabled)
				if (enabled && manager.isFeatureEnabled && manager.isFeatureConfigured) {
					await manager.initialize(provider.contextProxy)
					void manager.startIndexing().catch((err) => provider.log(`Indexing error: ${err}`))
				} else if (!enabled) {
					manager.stopIndexing()
				}
				await provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: manager.getCurrentStatus(),
				})
			} catch (error) {
				provider.log(
					`Error toggling workspace indexing: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "setAutoEnableDefault": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot set auto-enable default: No workspace folder open")
					return
				}
				// Capture prior state for every manager before persisting the global change
				const allManagers = CodeIndexManager.getAllInstances()
				const priorStates = new Map(allManagers.map((m) => [m, m.isWorkspaceEnabled]))
				await manager.setAutoEnableDefault(message.bool ?? true)
				// Apply stop/start to every affected manager
				for (const m of allManagers) {
					const wasEnabled = priorStates.get(m)!
					const isNowEnabled = m.isWorkspaceEnabled
					if (wasEnabled && !isNowEnabled) {
						m.stopIndexing()
					} else if (!wasEnabled && isNowEnabled && m.isFeatureEnabled && m.isFeatureConfigured) {
						await m.initialize(provider.contextProxy)
						void m.startIndexing().catch((err) => provider.log(`Indexing error: ${err}`))
					}
				}
				await provider.postMessageToWebview({
					type: "indexingStatusUpdate",
					values: manager.getCurrentStatus(),
				})
			} catch (error) {
				provider.log(
					`Error setting auto-enable default: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			break
		}
		case "clearIndexData": {
			try {
				const manager = provider.getCurrentWorkspaceCodeIndexManager()
				if (!manager) {
					provider.log("Cannot clear index data: No workspace folder open")
					await provider.postMessageToWebview({
						type: "indexCleared",
						values: {
							success: false,
							error: t("embeddings:orchestrator.indexingRequiresWorkspace"),
						},
					})
					return
				}
				await manager.clearIndexData()
				await provider.postMessageToWebview({ type: "indexCleared", values: { success: true } })
			} catch (error) {
				provider.log(`Error clearing index data: ${error instanceof Error ? error.message : String(error)}`)
				await provider.postMessageToWebview({
					type: "indexCleared",
					values: {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				})
			}
			break
		}
		case "focusPanelRequest": {
			// Execute the focusPanel command to focus the WebView
			await vscode.commands.executeCommand(getCommand("focusPanel"))
			break
		}
		case "filterMarketplaceItems": {
			if (marketplaceManager && message.filters) {
				try {
					await marketplaceManager.updateWithFilteredItems({
						type: message.filters.type as MarketplaceItemType | undefined,
						search: message.filters.search,
						tags: message.filters.tags,
					})
					await provider.postStateToWebview()
				} catch (error) {
					console.error("Marketplace: Error filtering items:", error)
					vscode.window.showErrorMessage(t("common:ui.filterFailed"))
				}
			}
			break
		}

		case "fetchMarketplaceData": {
			// Fetch marketplace data on demand
			await provider.fetchMarketplaceData()
			break
		}

		case "installMarketplaceItem": {
			if (marketplaceManager && message.mpItem && message.mpInstallOptions) {
				try {
					const configFilePath = await marketplaceManager.installMarketplaceItem(
						message.mpItem,
						message.mpInstallOptions,
					)
					await provider.showArtifact(configFilePath)
					await provider.postStateToWebview()
					console.log(`Marketplace item installed: ${configFilePath}`)

					// Send success message to webview
					await provider.postMessageToWebview({
						type: "marketplaceInstallResult",
						success: true,
						slug: message.mpItem.id,
					})
				} catch (error) {
					console.error(`Error installing marketplace item: ${error}`)
					// Send error message to webview
					await provider.postMessageToWebview({
						type: "marketplaceInstallResult",
						success: false,
						error: error instanceof Error ? error.message : String(error),
						slug: message.mpItem.id,
					})
				}
			}
			break
		}

		case "removeInstalledMarketplaceItem": {
			if (marketplaceManager && message.mpItem && message.mpInstallOptions) {
				try {
					await marketplaceManager.removeInstalledMarketplaceItem(message.mpItem, message.mpInstallOptions)
					await provider.postStateToWebview()

					// Send success message to webview
					await provider.postMessageToWebview({
						type: "marketplaceRemoveResult",
						success: true,
						slug: message.mpItem.id,
					})
				} catch (error) {
					console.error(`Error removing marketplace item: ${error}`)

					// Show error message to user
					vscode.window.showErrorMessage(
						`Failed to remove marketplace item: ${error instanceof Error ? error.message : String(error)}`,
					)

					// Send error message to webview
					await provider.postMessageToWebview({
						type: "marketplaceRemoveResult",
						success: false,
						error: error instanceof Error ? error.message : String(error),
						slug: message.mpItem.id,
					})
				}
			} else {
				// MarketplaceManager not available or missing required parameters
				const errorMessage = !marketplaceManager
					? "Marketplace manager is not available"
					: "Missing required parameters for marketplace item removal"
				console.error(errorMessage)

				vscode.window.showErrorMessage(errorMessage)

				if (message.mpItem?.id) {
					await provider.postMessageToWebview({
						type: "marketplaceRemoveResult",
						success: false,
						error: errorMessage,
						slug: message.mpItem.id,
					})
				}
			}
			break
		}

		case "installMarketplaceItemWithParameters": {
			if (marketplaceManager && message.payload && "item" in message.payload && "parameters" in message.payload) {
				try {
					const configFilePath = await marketplaceManager.installMarketplaceItem(message.payload.item, {
						parameters: message.payload.parameters,
					})
					await provider.showArtifact(configFilePath)
					await provider.postStateToWebview()
					console.log(`Marketplace item with parameters installed: ${configFilePath}`)
				} catch (error) {
					console.error(`Error installing marketplace item with parameters: ${error}`)
					vscode.window.showErrorMessage(
						`Failed to install marketplace item: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			break
		}

		case "switchTab": {
			if (message.tab) {
				// Capture tab shown event for all switchTab messages (which are user-initiated).
				if (TelemetryService.hasInstance()) {
					TelemetryService.instance.captureTabShown(message.tab)
				}

				await provider.postMessageToWebview({
					type: "action",
					action: "switchTab",
					tab: message.tab,
					values: message.values,
				})
			}
			break
		}
		case "requestCommands": {
			try {
				const commandList = await getDiscoveredCommands()
				await provider.postMessageToWebview({ type: "commands", commands: commandList })
			} catch (error) {
				provider.log(`Error fetching commands: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				await provider.postMessageToWebview({ type: "commands", commands: [] })
			}
			break
		}
		case "requestModes": {
			try {
				const modes = await provider.getModes()
				await provider.postMessageToWebview({ type: "modes", modes })
			} catch (error) {
				provider.log(`Error fetching modes: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				await provider.postMessageToWebview({ type: "modes", modes: [] })
			}
			break
		}
		case "requestSkills": {
			await handleRequestSkills(provider)
			break
		}
		case "extensionRequest": {
			// The one install/uninstall/enable surface for every extension kind.
			const { ExtensionRegistry } = await import("../../services/extensions/ExtensionRegistry")
			const { environmentManifest, getSharedEnvironmentProvisioner } = await import("../../services/environments")
			const provisioner = getSharedEnvironmentProvisioner()
			const skills = provider.getSkillsManager()
			const mcp = provider.getMcpHub()
			const { searchCommunity, installCommunitySkill, prepareCommunityMcp } =
				await import("../../services/extensions/community")
			const registry = new ExtensionRegistry({
				mcp,
				marketplace: marketplaceManager,
				skills,
				community: {
					search: searchCommunity,
					install: async (kind, id) => {
						if (kind === "skill") {
							if (!skills) throw new Error("Skills manager is unavailable")
							await installCommunitySkill(id)
							await skills.discoverSkills()
						} else {
							if (!marketplaceManager || !mcp) throw new Error("MCP marketplace is unavailable")
							const prepared = await prepareCommunityMcp(id)
							try {
								await marketplaceManager.installMarketplaceItem(prepared.item, { target: "global" })
							} catch (error) {
								const fs = await import("node:fs/promises")
								await fs.rm(prepared.directory, { recursive: true, force: true })
								throw error
							}
							await mcp.refreshAllConnections()
						}
					},
				},
				modes: {
					getCustomModes: () => provider.customModesManager.getCustomModes(),
					deleteCustomMode: (slug) => provider.customModesManager.deleteCustomMode(slug),
				},
				vscodeExtensions: {
					installed: () =>
						vscode.extensions.all
							.filter(
								(extension) =>
									!extension.packageJSON?.isBuiltin &&
									extension.id.toLowerCase() !== "octocode.octocode" &&
									!uninstalledThisSession.has(extension.id.toLowerCase()),
							)
							.map((extension) => ({
								id: extension.id,
								name: extension.packageJSON?.displayName ?? extension.id,
								description: extension.packageJSON?.description,
							})),
					search: searchOpenVsx,
					install: async (id) => {
						await vscode.commands.executeCommand("workbench.extensions.installExtension", id, {
							skipPublisherTrust: true,
						})
						uninstalledThisSession.delete(id.toLowerCase())
						await extensionRegistered(id)
					},
					uninstall: async (id) => {
						await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", id)
						uninstalledThisSession.add(id.toLowerCase())
					},
				},
				environments: provisioner && {
					manifest: environmentManifest,
					isInstalled: (id) => provisioner.isInstalled(id),
					ensure: (id) => provisioner.ensure(id),
					remove: (id) => provisioner.remove(id),
				},
			})
			const request = message.payload as ExtensionRequest
			const result = await registry.handle(request)
			if (result.error) void vscode.window.showErrorMessage(result.error)
			if (request.kind === "skill" && skills) await handleRequestSkills(provider)
			await provider.postMessageToWebview({ type: "extensionState", payload: result })
			break
		}
		case "installBundledSkills": {
			try {
				const manager = provider.getSkillsManager()
				if (!manager) throw new Error(t("common:ui.skillsUnavailable"))
				await manager.installBundledSkills()
				for (const name of ["ponytail", "using-superpowers"]) {
					if (!manager.getAllSkills().some((skill) => skill.name === name))
						throw new Error(t("common:ui.skillInvalid", { name }))
				}
				await handleRequestSkills(provider)
				void vscode.window.showInformationMessage(t("common:ui.skillsInstalled"))
			} catch (error) {
				void vscode.window.showErrorMessage(
					t("common:ui.skillsInstallFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			}
			break
		}
		case "createSkill": {
			await handleCreateSkill(provider, message)
			break
		}
		case "deleteSkill": {
			await handleDeleteSkill(provider, message)
			break
		}
		case "moveSkill": {
			await handleMoveSkill(provider, message)
			break
		}
		case "updateSkillModes": {
			await handleUpdateSkillModes(provider, message)
			break
		}
		case "openSkillFile": {
			await handleOpenSkillFile(provider, message)
			break
		}
		case "requestRules": {
			await handleRequestRules(provider, getCurrentCwd())
			break
		}
		case "createRule": {
			await handleCreateRule(provider, getCurrentCwd(), message)
			break
		}
		case "deleteRule": {
			await handleDeleteRule(provider, getCurrentCwd(), message)
			break
		}
		case "openRuleFile": {
			await handleOpenRuleFile(provider, getCurrentCwd(), message)
			break
		}
		case "openRulesDirectory": {
			await handleOpenRulesDirectory(provider, getCurrentCwd(), message)
			break
		}
		case "openCommandFile": {
			try {
				if (message.text) {
					const { getCommand } = await import("../../services/command/commands")
					const command = await getCommand(getCurrentCwd(), message.text)

					if (command && command.filePath) {
						await openFile(command.filePath)
					} else {
						vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
					}
				}
			} catch (error) {
				provider.log(
					`Error opening command file: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
				vscode.window.showErrorMessage(t("common:errors.open_command_file"))
			}
			break
		}
		case "deleteCommand": {
			try {
				if (message.text && message.values?.source) {
					const { getCommand } = await import("../../services/command/commands")
					const command = await getCommand(getCurrentCwd(), message.text)

					if (command && command.filePath) {
						// Delete the command file
						await fs.unlink(command.filePath)
						provider.log(`Deleted command file: ${command.filePath}`)
					} else {
						vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
					}
				}
			} catch (error) {
				provider.log(`Error deleting command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				vscode.window.showErrorMessage(t("common:errors.delete_command"))
			}
			break
		}
		case "createCommand": {
			try {
				const source = message.values?.source as "global" | "project"
				const fileName = message.text // Custom filename from user input

				if (!source) {
					provider.log("Missing source for createCommand")
					break
				}

				// Determine the commands directory based on source
				let commandsDir: string
				if (source === "global") {
					const globalConfigDir = getGlobalRooDirectory()
					commandsDir = path.join(globalConfigDir, "commands")
				} else {
					if (!vscode.workspace.workspaceFolders?.length) {
						vscode.window.showErrorMessage(t("common:errors.no_workspace"))
						return
					}
					// Project commands
					const workspaceRoot = getCurrentCwd()
					if (!workspaceRoot) {
						vscode.window.showErrorMessage(t("common:errors.no_workspace_for_project_command"))
						break
					}
					commandsDir = path.join(workspaceRoot, ".roo", "commands")
				}

				// Ensure the commands directory exists
				await fs.mkdir(commandsDir, { recursive: true })

				// Use provided filename or generate a unique one
				let commandName: string
				if (fileName && fileName.trim()) {
					let cleanFileName = fileName.trim()

					// Strip leading slash if present
					if (cleanFileName.startsWith("/")) {
						cleanFileName = cleanFileName.substring(1)
					}

					// Remove .md extension if present BEFORE slugification
					if (cleanFileName.toLowerCase().endsWith(".md")) {
						cleanFileName = cleanFileName.slice(0, -3)
					}

					// Slugify the command name: lowercase, replace spaces with dashes, remove special characters
					commandName = cleanFileName
						.toLowerCase()
						.replace(/\s+/g, "-") // Replace spaces with dashes
						.replace(/[^a-z0-9-]/g, "") // Remove special characters except dashes
						.replace(/-+/g, "-") // Replace multiple dashes with single dash
						.replace(/^-|-$/g, "") // Remove leading/trailing dashes

					// Ensure we have a valid command name
					if (!commandName || commandName.length === 0) {
						commandName = "new-command"
					}
				} else {
					// Generate a unique command name
					commandName = "new-command"
					let counter = 1
					let filePath = path.join(commandsDir, `${commandName}.md`)

					while (
						await fs
							.access(filePath)
							.then(() => true)
							.catch(() => false)
					) {
						commandName = `new-command-${counter}`
						filePath = path.join(commandsDir, `${commandName}.md`)
						counter++
					}
				}

				const filePath = path.join(commandsDir, `${commandName}.md`)

				// Check if file already exists
				if (
					await fs
						.access(filePath)
						.then(() => true)
						.catch(() => false)
				) {
					vscode.window.showErrorMessage(t("common:errors.command_already_exists", { commandName }))
					break
				}

				// Create the command file with template content
				const templateContent = t("common:errors.command_template_content")

				await fs.writeFile(filePath, templateContent, "utf8")
				provider.log(`Created new command file: ${filePath}`)

				// Open the new file in the editor
				await openFile(filePath)

				// Refresh commands list
				const { getCommands } = await import("../../services/command/commands")
				const commands = await getCommands(getCurrentCwd() || "")
				const commandList = commands.map((command) => ({
					name: command.name,
					source: command.source,
					filePath: command.filePath,
					description: command.description,
					argumentHint: command.argumentHint,
				}))
				await provider.postMessageToWebview({
					type: "commands",
					commands: commandList,
				})
			} catch (error) {
				provider.log(`Error creating command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
				vscode.window.showErrorMessage(t("common:errors.create_command_failed"))
			}
			break
		}

		case "insertTextIntoTextarea": {
			const text = message.text
			if (text) {
				// Send message to insert text into the chat textarea
				await provider.postMessageToWebview({
					type: "insertTextIntoTextarea",
					text: text,
				})
			}
			break
		}
		case "showMdmAuthRequiredNotification": {
			// Show notification that organization requires authentication
			vscode.window.showWarningMessage(t("common:mdm.info.organization_requires_auth"))
			break
		}

		/**
		 * Chat Message Queue
		 */

		case "resumeRuntimeQueue": {
			if (!message.taskId) break
			const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
			const state = await provider.getStateToPostToWebview()
			await getOctoCodeRuntime().resumeQueue(
				message.taskId,
				state.apiConfiguration,
				state.permissionProfile ?? "full",
			)
			break
		}
		case "queueMessage": {
			const resolved = await resolveIncomingImages({ text: message.text, images: message.images })
			if (message.taskId) {
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				const state = await provider.getStateToPostToWebview()
				await getOctoCodeRuntime().enqueue(
					message.taskId,
					resolved.text,
					resolved.images,
					state.apiConfiguration,
					state.permissionProfile ?? "full",
				)
				break
			}
			await provider.startRuntimeTask(resolved.text, resolved.images)
			break
		}
		case "removeQueuedMessage": {
			if (message.taskId) {
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				await getOctoCodeRuntime().editQueue(message.taskId, (queue) =>
					queue.filter((entry) => entry.id !== message.text),
				)
				break
			}
			break
		}
		case "editQueuedMessage": {
			if (message.taskId && message.payload) {
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				const { id, text } = message.payload as EditQueuedMessagePayload
				if (typeof text !== "string" || !text.trim()) break
				await getOctoCodeRuntime().editQueue(message.taskId, (queue) =>
					queue.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
				)
				break
			}

			break
		}
		case "pushQueuedMessage": {
			if (!message.taskId || !message.text) break
			const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
			const runtime = getOctoCodeRuntime()
			const state = await provider.getStateToPostToWebview()
			try {
				await runtime.pushQueuedMessage(
					message.taskId,
					message.text,
					state.apiConfiguration,
					state.permissionProfile ?? "full",
				)
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
			}
			break
		}

		case "dismissUpsell": {
			if (message.upsellId) {
				try {
					// Get current list of dismissed upsells
					const dismissedUpsells = getGlobalState("dismissedUpsells") || []

					// Add the new upsell ID if not already present
					let updatedList = dismissedUpsells
					if (!dismissedUpsells.includes(message.upsellId)) {
						updatedList = [...dismissedUpsells, message.upsellId]
						await updateGlobalState("dismissedUpsells", updatedList)
					}

					// Send updated list back to webview (use the already computed updatedList)
					await provider.postMessageToWebview({
						type: "dismissedUpsells",
						list: updatedList,
					})
				} catch (error) {
					// Fail silently as per Bruno's comment - it's OK to fail silently in this case
					provider.log(`Failed to dismiss upsell: ${error instanceof Error ? error.message : String(error)}`)
				}
			}
			break
		}
		case "getDismissedUpsells": {
			// Send the current list of dismissed upsells to the webview
			const dismissedUpsells = getGlobalState("dismissedUpsells") || []
			await provider.postMessageToWebview({
				type: "dismissedUpsells",
				list: dismissedUpsells,
			})
			break
		}

		case "openMarkdownPreview": {
			if (message.text) {
				try {
					const tmpDir = os.tmpdir()
					const timestamp = Date.now()
					const tempFileName = `roo-preview-${timestamp}.md`
					const tempFilePath = path.join(tmpDir, tempFileName)

					await fs.writeFile(tempFilePath, message.text, "utf8")

					const doc = await vscode.workspace.openTextDocument(tempFilePath)
					// Rendered markdown is visual content, so the preview opens in
					// the multimodal slot. `markdown.showPreview` targets whichever
					// group is active, so focus that slot first.
					await focusArtifactSlot()
					await vscode.commands.executeCommand("markdown.showPreview", doc.uri)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					provider.log(`Error opening markdown preview: ${errorMessage}`)
					vscode.window.showErrorMessage(t("common:ui.markdownPreview", { error: errorMessage }))
				}
			}
			break
		}

		case "requestOpenAiCodexRateLimits": {
			try {
				const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
				const accessToken = await openAiCodexOAuthManager.getAccessToken()

				if (!accessToken) {
					await provider.postMessageToWebview({
						type: "openAiCodexRateLimits",
						error: "Not authenticated with OpenAI Codex",
					})
					break
				}

				const accountId = await openAiCodexOAuthManager.getAccountId()
				const { fetchOpenAiCodexRateLimitInfo } = await import("../../integrations/openai-codex/rate-limits")
				const rateLimits = await fetchOpenAiCodexRateLimitInfo(accessToken, { accountId })

				await provider.postMessageToWebview({
					type: "openAiCodexRateLimits",
					values: rateLimits,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error fetching OpenAI Codex rate limits: ${errorMessage}`)
				await provider.postMessageToWebview({
					type: "openAiCodexRateLimits",
					error: errorMessage,
				})
			}
			break
		}

		case "openDebugApiHistory":
		case "openDebugUiHistory": {
			const { ClineProvider } = await import("./ClineProvider")
			const currentTask = ClineProvider.getActiveRuntimeTask()
			if (!currentTask) {
				vscode.window.showErrorMessage(t("common:ui.noActiveHistory"))
				break
			}

			try {
				const { getOctoCodeRuntime } = await import("../../services/octocode-runtime/OctoCodeRuntime")
				// Create a temporary file
				const tmpDir = os.tmpdir()
				const timestamp = Date.now()
				const tempFileName = `octocode-events-${currentTask.sessionId.slice(0, 8)}-${timestamp}.json`
				const tempFilePath = path.join(tmpDir, tempFileName)

				const file = await fs.open(tempFilePath, "w")
				try {
					await file.write("[\n")
					let first = true
					for await (const page of readEventPages(getOctoCodeRuntime(), currentTask.sessionId)) {
						if (!page.length) continue
						await file.write((first ? "" : ",\n") + page.map((row) => JSON.stringify(row)).join(",\n"))
						first = false
					}
					await file.write("\n]")
				} finally {
					await file.close()
				}

				// Open the temp file in the multimodal slot, never over the chat.
				const doc = await vscode.workspace.openTextDocument(tempFilePath)
				await showTextDocumentInArtifactSlot(doc, { preview: true })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error opening debug history: ${errorMessage}`)
				vscode.window.showErrorMessage(t("common:ui.debugHistory", { error: errorMessage }))
			}
			break
		}

		/**
		 * Git Worktree Management
		 */

		case "listWorktrees": {
			try {
				const { worktrees, isGitRepo, isMultiRoot, isSubfolder, gitRootPath, error } =
					await handleListWorktrees(provider)

				await provider.postMessageToWebview({
					type: "worktreeList",
					worktrees,
					isGitRepo,
					isMultiRoot,
					isSubfolder,
					gitRootPath,
					error,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "worktreeList",
					worktrees: [],
					isGitRepo: false,
					isMultiRoot: false,
					isSubfolder: false,
					gitRootPath: "",
					error: errorMessage,
				})
			}

			break
		}

		case "createWorktree": {
			try {
				const { success, message: text } = await handleCreateWorktree(
					provider,
					{
						path: message.worktreePath!,
						branch: message.worktreeBranch,
						baseBranch: message.worktreeBaseBranch,
						createNewBranch: message.worktreeCreateNewBranch,
					},
					(progress) => {
						void provider.postMessageToWebview({
							type: "worktreeCopyProgress",
							copyProgressBytesCopied: progress.bytesCopied,
							copyProgressItemName: progress.itemName,
						})
					},
				)

				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "deleteWorktree": {
			try {
				const { success, message: text } = await handleDeleteWorktree(
					provider,
					message.worktreePath!,
					message.worktreeForce ?? false,
				)

				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "switchWorktree": {
			try {
				const { success, message: text } = await handleSwitchWorktree(
					provider,
					message.worktreePath!,
					message.worktreeNewWindow ?? true,
				)

				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "getAvailableBranches": {
			try {
				const { localBranches, remoteBranches, currentBranch } = await handleGetAvailableBranches(provider)

				await provider.postMessageToWebview({
					type: "branchList",
					localBranches,
					remoteBranches,
					currentBranch,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "branchList",
					localBranches: [],
					remoteBranches: [],
					currentBranch: "",
					error: errorMessage,
				})
			}

			break
		}

		case "getWorktreeDefaults": {
			try {
				const { suggestedBranch, suggestedPath } = await handleGetWorktreeDefaults(provider)
				await provider.postMessageToWebview({ type: "worktreeDefaults", suggestedBranch, suggestedPath })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "worktreeDefaults",
					suggestedBranch: "",
					suggestedPath: "",
					error: errorMessage,
				})
			}

			break
		}

		case "getWorktreeIncludeStatus": {
			try {
				const worktreeIncludeStatus = await handleGetWorktreeIncludeStatus(provider)
				await provider.postMessageToWebview({ type: "worktreeIncludeStatus", worktreeIncludeStatus })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)

				await provider.postMessageToWebview({
					type: "worktreeIncludeStatus",
					worktreeIncludeStatus: {
						exists: false,
						hasGitignore: false,
						gitignoreContent: undefined,
					},
					error: errorMessage,
				})
			}

			break
		}

		case "checkBranchWorktreeInclude": {
			try {
				const branch = message.worktreeBranch
				if (!branch) {
					await provider.postMessageToWebview({
						type: "branchWorktreeIncludeResult",
						hasWorktreeInclude: false,
						error: "No branch specified",
					})
					break
				}
				const hasWorktreeInclude = await handleCheckBranchWorktreeInclude(provider, branch)
				await provider.postMessageToWebview({
					type: "branchWorktreeIncludeResult",
					branch,
					hasWorktreeInclude,
				})
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({
					type: "branchWorktreeIncludeResult",
					hasWorktreeInclude: false,
					error: errorMessage,
				})
			}

			break
		}

		case "createWorktreeInclude": {
			try {
				const { success, message: text } = await handleCreateWorktreeInclude(
					provider,
					message.worktreeIncludeContent ?? "",
				)

				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error creating worktree include: ${errorMessage}`)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "checkoutBranch": {
			try {
				const { success, message: text } = await handleCheckoutBranch(provider, message.worktreeBranch!)
				await provider.postMessageToWebview({ type: "worktreeResult", success, text })
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
			}

			break
		}

		case "browseForWorktreePath": {
			try {
				const options: vscode.OpenDialogOptions = {
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					openLabel: t("worktrees:selectWorktreeLocation"),
					title: t("worktrees:selectFolderForWorktree"),
					defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
						? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "..")
						: undefined,
				}

				const result = await vscode.window.showOpenDialog(options)
				if (result && result[0]) {
					await provider.postMessageToWebview({
						type: "folderSelected",
						path: result[0].fsPath,
					})
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				provider.log(`Error opening folder picker: ${errorMessage}`)
			}

			break
		}

		default: {
			// console.log(`Unhandled message type: ${message.type}`)
			//
			// Currently unhandled:
			//
			// "currentApiConfigName" |
			// "codebaseIndexEnabled" |
			// "enhancedPrompt" |
			// "systemPrompt" |
			// "exportModeResult" |
			// "importModeResult" |
			// "checkRulesDirectoryResult" |
			// "browserConnectionResult" |
			// "vsCodeSetting" |
			// "indexingStatusUpdate" |
			// "indexCleared" |
			// "marketplaceInstallResult" |
			// "shareTaskSuccess" |
			// "playSound" |
			// "draggedImages" |
			// "setApiConfigPassword" |
			// "setopenAiCustomModelInfo" |
			// "marketplaceButtonClicked" |
			// "cancelMarketplaceInstall" |
			// "imageGenerationSettings"
			break
		}
	}
}
