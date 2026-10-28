import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import {
	CheckCheck,
	GitBranch,
	Bell,
	Database,
	SquareTerminal,
	FlaskConical,
	TriangleAlert,
	Globe,
	Info,
	MessageSquare,
	LucideIcon,
	SquareSlash,
	Glasses,
	Plug,
	UsersRound,
	ArrowLeft,
	ScrollText,
	FileClock,
} from "lucide-react"

import {
	type ProviderSettings,
	type TelemetrySetting,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES_AFTER_USER_EDITED,
	DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_NEW_FILES,
} from "@roo-code/types"
import { DEFAULT_LANGUAGE } from "@roo/language"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { ExtensionStateContextType, useExtensionState } from "@src/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogCancel,
	AlertDialogAction,
	AlertDialogHeader,
	AlertDialogFooter,
	Button,
	StandardTooltip,
} from "@src/components/ui"

import { Tab, TabContent, TabHeader, TabList, TabTrigger } from "../common/Tab"
import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import ApiConfigManager from "./ApiConfigManager"
import ApiOptions from "./ApiOptions"
import { AutoApproveSettings } from "./AutoApproveSettings"
import { NotificationSettings } from "./NotificationSettings"
import { ContextManagementSettings } from "./ContextManagementSettings"
import { TerminalSettings } from "./TerminalSettings"
import { LanguageSettings } from "./LanguageSettings"
import { About } from "./About"
import { Section } from "./Section"
import PromptsSettings from "./PromptsSettings"
import { SlashCommandsSettings } from "./SlashCommandsSettings"
import { SkillsSettings } from "./SkillsSettings"
import { RulesSettings } from "./RulesSettings"
import { UISettings } from "./UISettings"
import ModesView from "../modes/ModesView"
import McpView from "../mcp/McpView"
import LogsView from "../logs/LogsView"
import { WorktreesView } from "../worktrees/WorktreesView"
import { SettingsSearch } from "./SettingsSearch"
import { IndexingStatusBadge } from "../chat/IndexingStatusBadge"
import type { CodeIndexSettingsActions } from "../chat/CodeIndexPopover"
import { CodeIndexSearch } from "./CodeIndexSearch"
import { useSearchIndexRegistry, SearchIndexProvider } from "./useSettingsSearch"
import searchMetadata from "./settings-search.generated.json"
const AutonomousResearchView = React.lazy(() => import("../autoresearch/AutonomousResearchView"))

export const settingsTabsContainer = "flex flex-1 overflow-hidden"
export const settingsTabList =
	"w-48 data-[compact=true]:w-28 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden border-r border-vscode-sideBar-background"
export const settingsTabTrigger =
	"whitespace-normal overflow-hidden min-w-0 min-h-12 shrink-0 px-3 py-3 box-border flex items-center border-l-2 border-transparent text-vscode-foreground opacity-70 hover:bg-vscode-list-hoverBackground data-[compact=true]:px-2"
export const settingsTabTriggerActive = "opacity-100 border-vscode-focusBorder bg-vscode-list-activeSelectionBackground"

export interface SettingsViewRef {
	checkUnsaveChanges: (then: () => void) => void
}

export const sectionNames = [
	"providers",
	"autoApprove",
	"slashCommands",
	"skills",
	"rules",
	"notifications",
	"contextManagement",
	"memoryKnowledge",
	"terminal",
	"logs",
	"modes",
	"mcp",
	"worktrees",
	"prompts",
	"ui",
	"language",
	"about",
	"research",
	"codeIndex",
] as const

export type SectionName = (typeof sectionNames)[number]

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

const SettingsView = forwardRef<SettingsViewRef, SettingsViewProps>(
	({ onDone, targetSection: requestedSection }, ref) => {
		const targetSection = requestedSection === "codeIndex" ? "memoryKnowledge" : requestedSection
		const { t } = useAppTranslation()

		const extensionState = useExtensionState()
		const { currentApiConfigName, listApiConfigMeta, uriScheme, settingsImportedAt, mode } = extensionState

		const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
		const [isChangeDetected, setChangeDetected] = useState(false)
		const originalValues = useRef(new Map<string, { original: unknown; value: unknown }>())
		const trackChange = useCallback((key: string, previous: unknown, value: unknown) => {
			const original = originalValues.current.has(key) ? originalValues.current.get(key)!.original : previous
			originalValues.current.set(key, { original, value })
			setChangeDetected(
				[...originalValues.current.values()].some(
					({ original, value }) => JSON.stringify(original) !== JSON.stringify(value),
				),
			)
		}, [])
		const [indexDirty, setIndexDirty] = useState(false)
		const indexSettingsRef = useRef<CodeIndexSettingsActions>(null)
		const [isSaving, setSaving] = useState(false)
		const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
		const [activeTab, setActiveTab] = useState<SectionName>(
			targetSection && sectionNames.includes(targetSection as SectionName)
				? (targetSection as SectionName)
				: "providers",
		)

		const scrollPositions = useRef<Record<SectionName, number>>(
			Object.fromEntries(sectionNames.map((s) => [s, 0])) as Record<SectionName, number>,
		)
		const contentRef = useRef<HTMLDivElement | null>(null)

		const prevApiConfigName = useRef(currentApiConfigName)
		const prevMode = useRef(mode)
		const handledSettingsImportedAt = useRef<number | undefined>(undefined)
		const confirmDialogHandler = useRef<(() => void) | undefined>(undefined)

		const [cachedState, setCachedState] = useState(() => extensionState)
		const cachedStateRef = useRef(cachedState)
		cachedStateRef.current = cachedState
		const savedState = useRef(extensionState)

		const {
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			allowedCommands,
			deniedCommands,
			allowedMaxRequests,
			allowedMaxCost,
			language,
			alwaysAllowExecute,
			destructiveCommandGuardEnabled,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected,
			autoCondenseContext,
			autoCondenseContextPercent,
			maxOpenTabsContext,
			maxWorkspaceFiles,
			mcpEnabled,
			soundEnabled,
			ttsEnabled,
			ttsSpeed,
			soundVolume,
			telemetrySetting,
			terminalOutputPreviewSize,
			terminalShellIntegrationTimeout,
			terminalShellIntegrationDisabled, // Added from upstream
			terminalCommandDelay,
			terminalPowershellCounter,
			terminalZshClearEolMark,
			terminalZshOhMy,
			terminalZshP10k,
			terminalZdotdir,
			terminalProfile,
			writeDelayMs,
			diffFuzzyThreshold,
			showRooIgnoredFiles,
			enableSubfolderRules,
			maxImageFileSize,
			maxTotalImageSize,
			customSupportPrompts,
			profileThresholds,
			alwaysAllowFollowupQuestions,
			followupAutoApproveTimeoutMs,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			includeTaskHistoryInEnhance,
			reasoningBlockCollapsed,
			chatFontSize,
			enterBehavior,
			includeCurrentTime,
			includeCurrentCost,
			maxGitStatusFiles,
			autoCloseOctoCodeOpenedFiles,
			autoCloseOctoCodeOpenedFilesAfterUserEdited,
			autoCloseOctoCodeOpenedNewFiles,
		} = cachedState

		const apiConfiguration = useMemo(() => cachedState.apiConfiguration ?? {}, [cachedState.apiConfiguration])

		useEffect(() => {
			// Update when currentApiConfigName or mode changes.
			// Expected to be triggered by loadApiConfiguration/upsertApiConfiguration or mode switch.
			if (prevApiConfigName.current === currentApiConfigName && prevMode.current === mode) {
				return
			}

			setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
			savedState.current = extensionState
			prevApiConfigName.current = currentApiConfigName
			prevMode.current = mode
			originalValues.current.clear()
			setChangeDetected(false)
		}, [currentApiConfigName, mode, extensionState])

		// Bust the cache when settings are imported.
		useEffect(() => {
			if (!settingsImportedAt || handledSettingsImportedAt.current === settingsImportedAt) {
				return
			}

			handledSettingsImportedAt.current = settingsImportedAt
			setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
			savedState.current = extensionState
			originalValues.current.clear()
			setChangeDetected(false)
		}, [settingsImportedAt, extensionState])

		const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = useCallback(
			(field, value) => {
				setCachedState((prevState) => {
					if (prevState[field] === value) {
						return prevState
					}

					trackChange(field, prevState[field], value)
					return { ...prevState, [field]: value }
				})
			},
			[trackChange],
		)

		const setApiConfigurationField = useCallback(
			<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
				setCachedState((prevState) => {
					if (prevState.apiConfiguration?.[field] === value) {
						return prevState
					}

					const key = `apiConfiguration.${field}`
					const tracked = originalValues.current.get(key)
					if (
						isUserAction ||
						(tracked && JSON.stringify(tracked.original) !== JSON.stringify(tracked.value))
					) {
						trackChange(key, prevState.apiConfiguration?.[field], value)
					} else {
						originalValues.current.delete(key)
					}
					return { ...prevState, apiConfiguration: { ...prevState.apiConfiguration, [field]: value } }
				})
			},
			[trackChange],
		)

		const setTelemetrySetting = useCallback(
			(setting: TelemetrySetting) => {
				setCachedState((prevState) => {
					if (prevState.telemetrySetting === setting) {
						return prevState
					}

					trackChange("telemetrySetting", prevState.telemetrySetting, setting)
					return { ...prevState, telemetrySetting: setting }
				})
			},
			[trackChange],
		)

		const setDebug = useCallback(
			(debug: boolean) => {
				setCachedState((prevState) => {
					if (prevState.debug === debug) {
						return prevState
					}

					trackChange("debug", prevState.debug, debug)
					return { ...prevState, debug }
				})
			},
			[trackChange],
		)

		const setCustomSupportPromptsField = useCallback(
			(prompts: Record<string, string | undefined>) => {
				setCachedState((prevState) => {
					const previousStr = JSON.stringify(prevState.customSupportPrompts)
					const newStr = JSON.stringify(prompts)

					if (previousStr === newStr) {
						return prevState
					}

					trackChange("customSupportPrompts", prevState.customSupportPrompts, prompts)
					return { ...prevState, customSupportPrompts: prompts }
				})
			},
			[trackChange],
		)

		const isSettingValid = !errorMessage

		const saveApiConfiguration = useCallback(() => {
			if (!currentApiConfigName) return

			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName,
				apiConfiguration,
			})
		}, [apiConfiguration, currentApiConfigName])

		const handleSubmit = async () => {
			if (!isSettingValid || isSaving) return false
			if (indexDirty) {
				setSaving(true)
				const saved = await indexSettingsRef.current?.save()
				setSaving(false)
				if (!saved) return false
				setIndexDirty(false)
				if (cachedStateRef.current !== cachedState) return false
			}
			if (isSettingValid) {
				vscode.postMessage({
					type: "updateSettings",
					updatedSettings: {
						language,
						alwaysAllowReadOnly: alwaysAllowReadOnly ?? undefined,
						alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? undefined,
						alwaysAllowWrite: alwaysAllowWrite ?? undefined,
						alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? undefined,
						alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? undefined,
						alwaysAllowExecute: alwaysAllowExecute ?? undefined,
						destructiveCommandGuardEnabled: destructiveCommandGuardEnabled ?? false,
						alwaysAllowMcp,
						alwaysAllowModeSwitch,
						allowedCommands: allowedCommands ?? [],
						deniedCommands: deniedCommands ?? [],
						// Note that we use `null` instead of `undefined` since `JSON.stringify`
						// will omit `undefined` when serializing the object and passing it to the
						// extension host. We may need to do the same for other nullable fields.
						allowedMaxRequests: allowedMaxRequests ?? null,
						allowedMaxCost: allowedMaxCost ?? null,
						autoCondenseContext,
						autoCondenseContextPercent,
						soundEnabled: soundEnabled ?? true,
						soundVolume: soundVolume ?? 0.5,
						ttsEnabled,
						ttsSpeed,
						writeDelayMs,
						diffFuzzyThreshold,
						terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? 30_000,
						terminalShellIntegrationDisabled,
						terminalCommandDelay,
						terminalPowershellCounter,
						terminalZshClearEolMark,
						terminalZshOhMy,
						terminalZshP10k,
						terminalZdotdir,
						terminalProfile: terminalProfile ?? "", // "" clears a saved profile; undefined is dropped by JSON.stringify
						terminalOutputPreviewSize: terminalOutputPreviewSize ?? "medium",
						mcpEnabled,
						maxOpenTabsContext: Math.min(Math.max(0, maxOpenTabsContext ?? 20), 500),
						maxWorkspaceFiles: Math.min(Math.max(0, maxWorkspaceFiles ?? 200), 500),
						showRooIgnoredFiles: showRooIgnoredFiles ?? true,
						enableSubfolderRules: enableSubfolderRules ?? false,
						maxImageFileSize: maxImageFileSize ?? 5,
						maxTotalImageSize: maxTotalImageSize ?? 20,
						includeDiagnosticMessages:
							includeDiagnosticMessages !== undefined ? includeDiagnosticMessages : true,
						maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
						alwaysAllowSubtasks,
						alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
						followupAutoApproveTimeoutMs,
						includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
						reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
						chatFontSize: chatFontSize ?? null,
						enterBehavior: enterBehavior ?? "send",
						includeCurrentTime: includeCurrentTime ?? true,
						includeCurrentCost: includeCurrentCost ?? true,
						maxGitStatusFiles: maxGitStatusFiles ?? 0,
						autoCloseOctoCodeOpenedFiles:
							autoCloseOctoCodeOpenedFiles ?? DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES,
						autoCloseOctoCodeOpenedFilesAfterUserEdited:
							autoCloseOctoCodeOpenedFilesAfterUserEdited ??
							DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_FILES_AFTER_USER_EDITED,
						autoCloseOctoCodeOpenedNewFiles:
							autoCloseOctoCodeOpenedNewFiles ?? DEFAULT_AUTO_CLOSE_OCTOCODE_OPENED_NEW_FILES,
						profileThresholds,
						customSupportPrompts,
					},
				})

				// These have more complex logic so they aren't (yet) handled
				// by the `updateSettings` message.
				vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
				vscode.postMessage({ type: "telemetrySetting", text: telemetrySetting })
				vscode.postMessage({ type: "debugSetting", bool: cachedState.debug })

				originalValues.current.clear()
				savedState.current = cachedState
				setChangeDetected(false)
			}
			return true
		}

		const checkUnsaveChanges = useCallback(
			(then: () => void) => {
				if (isChangeDetected || indexDirty) {
					confirmDialogHandler.current = then
					setDiscardDialogShow(true)
				} else {
					then()
				}
			},
			[isChangeDetected, indexDirty],
		)

		useImperativeHandle(ref, () => ({ checkUnsaveChanges }), [checkUnsaveChanges])

		const onConfirmDialogResult = async (confirm: boolean | "save") => {
			if (confirm === "save") {
				if (!(await handleSubmit())) return
				setDiscardDialogShow(false)
				confirmDialogHandler.current?.()
			} else if (confirm) {
				// Discard changes: Reset state and flag
				setCachedState(savedState.current)
				originalValues.current.clear()
				setChangeDetected(false) // Reset change flag
				indexSettingsRef.current?.discard()
				setIndexDirty(false)
				setDiscardDialogShow(false)
				confirmDialogHandler.current?.() // Execute the pending action (e.g., tab switch)
			} else {
				setDiscardDialogShow(false)
			}
			// If confirm is false (Cancel), do nothing, dialog closes automatically
		}

		// Handle tab changes with unsaved changes check
		const handleTabChange = useCallback(
			(newTab: SectionName) => {
				if (contentRef.current) {
					scrollPositions.current[activeTab] = contentRef.current.scrollTop
				}
				setActiveTab(newTab === "codeIndex" ? "memoryKnowledge" : newTab)
			},
			[activeTab],
		)

		useLayoutEffect(() => {
			if (contentRef.current) {
				contentRef.current.scrollTop = scrollPositions.current[activeTab] ?? 0
			}
		}, [activeTab])

		// Store direct DOM element refs for each tab
		const tabRefs = useRef<Record<SectionName, HTMLButtonElement | null>>(
			Object.fromEntries(sectionNames.map((name) => [name, null])) as Record<
				SectionName,
				HTMLButtonElement | null
			>,
		)

		// Track whether we're in compact mode
		const [isCompactMode, setIsCompactMode] = useState(false)
		const containerRef = useRef<HTMLDivElement>(null)

		// Setup resize observer to detect when we should switch to compact mode
		useEffect(() => {
			if (!containerRef.current) return

			const observer = new ResizeObserver((entries) => {
				for (const entry of entries) {
					// If container width is less than 500px, switch to compact mode
					setIsCompactMode(entry.contentRect.width < 500)
				}
			})

			observer.observe(containerRef.current)

			return () => {
				observer?.disconnect()
			}
		}, [])

		const sections: { id: SectionName; icon: LucideIcon; group?: string }[] = useMemo(
			() => [
				{ id: "providers", icon: Plug, group: t("common:ui.commonSettings") },
				{ id: "ui", icon: Glasses },
				{ id: "language", icon: Globe },
				{ id: "notifications", icon: Bell },
				{ id: "modes", icon: UsersRound, group: t("common:ui.agents") },
				{ id: "prompts", icon: MessageSquare },
				{ id: "rules", icon: ScrollText },
				{ id: "autoApprove", icon: CheckCheck },
				{ id: "contextManagement", icon: Database },
				{ id: "memoryKnowledge", icon: Database },
				/*
				 * Skills and MCP have no sidebar entries by design: both are managed
				 * through the marketplace (组件市场 → 技能市场 / MCP 市场). They stay in
				 * `sectionNames` so deep links (switchTab with a section) still land,
				 * but the tab list does not offer them.
				 */
				{ id: "slashCommands", icon: SquareSlash },
				{ id: "worktrees", icon: GitBranch, group: t("common:ui.taskExecution") },
				{ id: "terminal", icon: SquareTerminal },
				{ id: "research", icon: FlaskConical },
				{ id: "logs", icon: FileClock, group: t("common:ui.system") },
				{ id: "about", icon: Info },
			],
			[t],
		)

		// Update target section logic to set active tab
		useEffect(() => {
			if (targetSection && sectionNames.includes(targetSection as SectionName)) {
				setActiveTab(targetSection as SectionName)
			}
		}, [targetSection])

		// Function to scroll the active tab into view for vertical layout
		const scrollToActiveTab = useCallback(() => {
			const activeTabElement = tabRefs.current[activeTab]

			if (activeTabElement) {
				activeTabElement.scrollIntoView({
					behavior: "auto",
					block: "nearest",
				})
			}
		}, [activeTab])

		// Effect to scroll when the active tab changes
		useEffect(() => {
			scrollToActiveTab()
		}, [activeTab, scrollToActiveTab])

		// Effect to scroll when the webview becomes visible
		useLayoutEffect(() => {
			const handleMessage = (event: MessageEvent) => {
				const message = event.data
				if (message.type === "action" && message.action === "didBecomeVisible") {
					scrollToActiveTab()
				}
			}

			window.addEventListener("message", handleMessage)

			return () => {
				window.removeEventListener("message", handleMessage)
			}
		}, [scrollToActiveTab])

		// Search index registry - settings register themselves on mount
		const getSectionLabel = useCallback(
			(section: SectionName) =>
				section === "ui"
					? t("common:ui.interface")
					: section === "research"
						? t("common:ui.autoresearch")
						: section === "codeIndex"
							? t("settings:codeIndex.indexReadyLabel", { defaultValue: "Index ready" })
							: section === "logs"
								? t("common:octocode.logs")
								: t(`settings:sections.${section}`),
			[t],
		)
		const { contextValue: searchContextValue, index: visitedSettings } = useSearchIndexRegistry(getSectionLabel)
		const searchIndex = useMemo(() => {
			const entries = new Map(
				sections.map(({ id }) => [
					`tab-${id}`,
					{
						settingId: `tab-${id}`,
						section: id,
						label: getSectionLabel(id),
						sectionLabel: getSectionLabel(id),
					},
				]),
			)
			for (const item of searchMetadata) {
				if (!sectionNames.includes(item.section as SectionName)) continue
				const section = item.section as SectionName
				entries.set(item.settingId, {
					settingId: item.settingId,
					section,
					sectionLabel: getSectionLabel(section),
					label: item.labelKey
						? t(item.labelKey, {
								primaryMod: navigator.platform.toUpperCase().includes("MAC") ? "⌘" : "Ctrl",
							})
						: (item.label ?? ""),
				})
			}
			for (const item of visitedSettings) entries.set(item.settingId, item)
			return [...entries.values()]
		}, [sections, getSectionLabel, t, visitedSettings])
		const renderTab = activeTab

		// Handle search navigation - switch to the correct tab and scroll to the element
		const handleSearchNavigate = useCallback(
			(section: SectionName, settingId: string) => {
				// Switch to the correct tab
				handleTabChange(section)

				// Wait for the tab to render, then find element by settingId and scroll to it
				requestAnimationFrame(() => {
					setTimeout(() => {
						const element = document.querySelector(`[data-setting-id="${settingId}"]`)
						if (element) {
							element.scrollIntoView({ behavior: "smooth", block: "center" })

							// Add highlight animation
							element.classList.add("settings-highlight")
							setTimeout(() => {
								element.classList.remove("settings-highlight")
							}, 1500)
						}
					}, 100) // Small delay to ensure tab content is rendered
				})
			},
			[handleTabChange],
		)

		return (
			<Tab>
				<TabHeader className="flex justify-between items-center gap-2">
					<div className="flex items-center gap-2 grow">
						<StandardTooltip content={t("settings:header.doneButtonTooltip")}>
							<Button variant="ghost" className="px-1.5 -ml-2" onClick={() => checkUnsaveChanges(onDone)}>
								<ArrowLeft />
								<span className="sr-only">{t("settings:common.done")}</span>
							</Button>
						</StandardTooltip>
						<h3 className="text-vscode-foreground m-0 flex-shrink-0">{t("settings:header.title")}</h3>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						<SettingsSearch index={searchIndex} onNavigate={handleSearchNavigate} sections={sections} />
						<StandardTooltip
							content={
								!isSettingValid
									? errorMessage
									: isChangeDetected || indexDirty
										? t("settings:header.saveButtonTooltip")
										: t("settings:header.nothingChangedTooltip")
							}>
							<Button
								variant={isSettingValid ? "primary" : "secondary"}
								className={!isSettingValid ? "!border-vscode-errorForeground" : ""}
								onClick={() => void handleSubmit()}
								disabled={(!isChangeDetected && !indexDirty) || !isSettingValid || isSaving}
								data-testid="save-button">
								{t("settings:common.save")}
							</Button>
						</StandardTooltip>
					</div>
				</TabHeader>

				{/* Vertical tabs layout */}
				<div ref={containerRef} className={cn(settingsTabsContainer, isCompactMode && "narrow")}>
					{/* Tab sidebar */}
					<TabList
						value={activeTab}
						onValueChange={(value) => handleTabChange(value as SectionName)}
						className={cn(settingsTabList)}
						data-compact={isCompactMode}
						data-testid="settings-tab-list">
						{(() => {
							let previousGroup: string | undefined
							return sections.map(({ id, icon: Icon, group }) => {
								// A group heading renders only when the group actually changes.
								// Ungrouped entries must not reset the tracker, or a group that
								// surrounds one (worktrees … codeIndex around terminal) would
								// print its heading twice.
								const showGroupHeader = group !== undefined && group !== previousGroup
								if (group !== undefined) previousGroup = group
								const isSelected = id === activeTab
								const onSelect = () => handleTabChange(id)

								// Base TabTrigger component definition
								// We pass isSelected manually for styling, but onSelect is handled conditionally
								const triggerComponent = (
									<TabTrigger
										onSelect={onSelect}
										ref={(element) => {
											tabRefs.current[id] = element
										}}
										value={id}
										isSelected={isSelected} // Pass manually for styling state
										className={cn(
											isSelected // Use manual isSelected for styling
												? `${settingsTabTrigger} ${settingsTabTriggerActive}`
												: settingsTabTrigger,
											"cursor-pointer focus:ring-0", // Remove the focus ring styling
										)}
										data-testid={`tab-${id}`}
										aria-label={getSectionLabel(id)}
										data-compact={isCompactMode}>
										<div className="flex items-center gap-2 text-left">
											{!isCompactMode && <Icon className="w-4 h-4 shrink-0" />}
											<span className="tab-label text-[13px]">{getSectionLabel(id)}</span>
										</div>
									</TabTrigger>
								)

								return (
									<React.Fragment key={id}>
										{/* A group header only when the group actually changes; consecutive
									    members of the same group must not repeat the heading. */}
										{showGroupHeader && (
											<div
												role="presentation"
												className="px-3 pt-4 pb-1 text-[14px] font-bold text-vscode-foreground border-t border-vscode-panel-border"
												data-testid="settings-group">
												{group}
											</div>
										)}
										{triggerComponent}
									</React.Fragment>
								)
							})
						})()}
					</TabList>

					{/* Content area - renders only the active tab (or indexing tab during initial indexing) */}
					<TabContent ref={contentRef} className="p-0 flex-1 overflow-auto" data-testid="settings-content">
						<SearchIndexProvider value={searchContextValue}>
							{renderTab === "research" && (
								<React.Suspense fallback={<div className="p-5">{t("common:ui.loading")}</div>}>
									<AutonomousResearchView onDone={onDone} />
								</React.Suspense>
							)}
							{/* Providers Section */}
							{renderTab === "providers" && (
								<div>
									<SectionHeader>{t("settings:sections.providers")}</SectionHeader>

									<Section>
										<ApiConfigManager
											currentApiConfigName={currentApiConfigName}
											listApiConfigMeta={listApiConfigMeta}
											onSelectConfig={(configName: string) =>
												checkUnsaveChanges(() =>
													vscode.postMessage({
														type: "loadApiConfiguration",
														text: configName,
													}),
												)
											}
											onDeleteConfig={(configName: string) =>
												vscode.postMessage({ type: "deleteApiConfiguration", text: configName })
											}
											onRenameConfig={(oldName: string, newName: string) => {
												vscode.postMessage({
													type: "renameApiConfiguration",
													values: { oldName, newName },
													apiConfiguration,
												})
												prevApiConfigName.current = newName
											}}
											onUpsertConfig={(configName: string) =>
												vscode.postMessage({
													type: "upsertApiConfiguration",
													text: configName,
													apiConfiguration,
												})
											}
											onCreateConfig={(configName: string) =>
												// New profiles start blank: apiConfiguration here is the
												// currently *displayed* profile, whose key fields hold
												// masked/encrypted placeholders — inheriting them would
												// persist garbage into the new profile.
												vscode.postMessage({
													type: "upsertApiConfiguration",
													text: configName,
													apiConfiguration: {},
												})
											}
										/>
										<ApiOptions
											uriScheme={uriScheme}
											apiConfiguration={apiConfiguration}
											setApiConfigurationField={setApiConfigurationField}
											errorMessage={errorMessage}
											setErrorMessage={setErrorMessage}
											onSaveApiConfiguration={saveApiConfiguration}
										/>
									</Section>
								</div>
							)}

							{/* Auto-Approve Section */}
							{renderTab === "autoApprove" && <AutoApproveSettings />}

							{/* Slash Commands Section */}
							{renderTab === "slashCommands" && <SlashCommandsSettings />}

							{/* Skills Section — no sidebar entry; reachable via marketplace deep link */}
							{renderTab === "skills" && <SkillsSettings />}

							{/* Rules Section */}
							{renderTab === "rules" && <RulesSettings />}

							{/* Notifications Section */}
							{renderTab === "notifications" && (
								<NotificationSettings
									ttsEnabled={ttsEnabled}
									ttsSpeed={ttsSpeed}
									soundEnabled={soundEnabled}
									soundVolume={soundVolume}
									setCachedStateField={setCachedStateField}
								/>
							)}

							{/* Context Management Section */}
							{(renderTab === "memoryKnowledge" || renderTab === "codeIndex" || indexDirty) && (
								<div hidden={renderTab !== "memoryKnowledge" && renderTab !== "codeIndex"}>
									<SectionHeader>{t("settings:sections.memoryKnowledge")}</SectionHeader>
									<p className="text-sm text-vscode-descriptionForeground">
										{t("settings:codeIndex.memoryKnowledgeDescription")}
									</p>
									<IndexingStatusBadge
										inline
										onDirtyChange={setIndexDirty}
										settingsRef={indexSettingsRef}
									/>
									<CodeIndexSearch key={extensionState.codeIndexWorkspacePath ?? "no-workspace"} />
								</div>
							)}
							{renderTab === "contextManagement" && (
								<ContextManagementSettings
									autoCondenseContext={autoCondenseContext}
									autoCondenseContextPercent={autoCondenseContextPercent}
									listApiConfigMeta={listApiConfigMeta ?? []}
									showRooIgnoredFiles={showRooIgnoredFiles}
									maxImageFileSize={maxImageFileSize}
									maxTotalImageSize={maxTotalImageSize}
									profileThresholds={profileThresholds}
									setCachedStateField={setCachedStateField}
								/>
							)}

							{/* Terminal Section */}
							{renderTab === "terminal" && <TerminalSettings />}

							{/* Logs Section */}
							{renderTab === "logs" && <LogsView />}

							{/* Modes Section */}
							{renderTab === "modes" && <ModesView />}

							{/* MCP Section — no sidebar entry; reachable via marketplace deep link */}
							{renderTab === "mcp" && (
								<McpView
									mcpEnabled={mcpEnabled}
									setMcpEnabled={(value) => setCachedStateField("mcpEnabled", value)}
								/>
							)}

							{/* Worktrees Section */}
							{renderTab === "worktrees" && <WorktreesView />}

							{/* Prompts Section */}
							{renderTab === "prompts" && (
								<PromptsSettings
									customSupportPrompts={customSupportPrompts || {}}
									setCustomSupportPrompts={setCustomSupportPromptsField}
									includeTaskHistoryInEnhance={includeTaskHistoryInEnhance}
									setIncludeTaskHistoryInEnhance={(value) =>
										setCachedStateField("includeTaskHistoryInEnhance", value)
									}
								/>
							)}

							{/* UI Section */}
							{renderTab === "ui" && (
								<UISettings
									reasoningBlockCollapsed={reasoningBlockCollapsed ?? true}
									enterBehavior={enterBehavior ?? "send"}
									chatFontSize={chatFontSize ?? undefined}
									autoCloseOctoCodeOpenedFiles={autoCloseOctoCodeOpenedFiles}
									autoCloseOctoCodeOpenedFilesAfterUserEdited={
										autoCloseOctoCodeOpenedFilesAfterUserEdited
									}
									autoCloseOctoCodeOpenedNewFiles={autoCloseOctoCodeOpenedNewFiles}
									setCachedStateField={setCachedStateField}
								/>
							)}

							{/* Language Section */}
							{renderTab === "language" && <LanguageSettings language={language || DEFAULT_LANGUAGE} />}

							{/* About Section */}
							{renderTab === "about" && (
								<About
									telemetrySetting={telemetrySetting}
									setTelemetrySetting={setTelemetrySetting}
									debug={cachedState.debug}
									setDebug={setDebug}
								/>
							)}
						</SearchIndexProvider>
					</TabContent>
				</div>

				<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								<TriangleAlert className="w-5 h-5 text-yellow-500" />
								{t("settings:unsavedChangesDialog.title")}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{t("settings:unsavedChangesDialog.description")}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isSaving} onClick={() => void onConfirmDialogResult(false)}>
								{t("settings:unsavedChangesDialog.cancelButton")}
							</AlertDialogCancel>
							<AlertDialogAction
								className="bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground hover:bg-vscode-button-secondaryHoverBackground"
								disabled={!isSettingValid || isSaving}
								onClick={(event) => {
									event.preventDefault()
									void onConfirmDialogResult("save")
								}}>
								{t("settings:unsavedChangesDialog.saveButton")}
							</AlertDialogAction>
							<AlertDialogAction disabled={isSaving} onClick={() => void onConfirmDialogResult(true)}>
								{t("settings:unsavedChangesDialog.discardButton")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</Tab>
		)
	},
)

export default SettingsView
