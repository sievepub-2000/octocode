import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage, TelemetryEventName } from "@roo-code/types"

import TranslationProvider from "./i18n/TranslationContext"
import { MarketplaceViewStateManager } from "./components/marketplace/MarketplaceViewStateManager"

import { vscode } from "./utils/vscode"
import { telemetryClient } from "./utils/TelemetryClient"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import type { SettingsViewRef } from "./components/settings/SettingsView"
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"
import { ShellFrame } from "./components/shell/ShellFrame"
import TaskNavigationView from "./components/history/TaskNavigationView"
import { useOctoCodeTheme } from "./theme/useOctoCodeTheme"

type Tab = "settings" | "chat" | "marketplace"

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedCheckpointRestoreDialog = React.memo(CheckpointRestoreDialog)
const ArtifactView = React.lazy(() => import("./components/artifacts/ArtifactView"))
const SettingsView = React.lazy(() => import("./components/settings/SettingsView"))
const WelcomeView = React.lazy(() => import("./components/welcome/WelcomeViewProvider"))
const MarketplaceView = React.lazy(() =>
	import("./components/marketplace/MarketplaceView").then(({ MarketplaceView }) => ({ default: MarketplaceView })),
)
const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	marketplaceButtonClicked: "marketplace",
}

const App = () => {
	const {
		didHydrateState,
		showWelcome,
		settingsImportedAt,
		shouldShowAnnouncement,
		telemetrySetting,
		telemetryKey,
		machineId,
		renderContext,
		mdmCompliant,
	} = useExtensionState()

	// Create a persistent state manager
	// Publishes the OctoCode palette as --octo-* custom properties; the shell's
	// frosted panel and every other surface read them from the document root.
	useOctoCodeTheme()

	const marketplaceStateManager = useMemo(() => new MarketplaceViewStateManager(), [])

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")
	const handledImportRef = useRef<number | undefined>(undefined)

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)

	const switchTab = useCallback(
		/**
		 * @param section Settings section to land on. It has to be passed *through*
		 * here rather than set alongside the call: this function resets the section
		 * so an unrelated tab cannot inherit the last one, which silently undid a
		 * caller that set it first — every rail entry that targeted a section opened
		 * settings at the top instead.
		 */
		(newTab: Tab, section?: string, marketplaceTab?: string) => {
			if (mdmCompliant === false) {
				// Notify the user that authentication is required by their organization
				vscode.postMessage({ type: "showMdmAuthRequiredNotification" })
				return
			}

			const navigate = () => {
				setCurrentSection(section)
				setCurrentMarketplaceTab(marketplaceTab)
				setTab(newTab)
			}
			if (settingsRef.current?.checkUnsaveChanges) {
				settingsRef.current.checkUnsaveChanges(navigate)
			} else {
				navigate()
			}
		},
		[mdmCompliant],
	)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	const [currentMarketplaceTab, setCurrentMarketplaceTab] = useState<string | undefined>(undefined)

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data
			if (message.type === "runtimeSessionLoaded") switchTab("chat")

			if (message.type === "action" && message.action) {
				// Handle switchTab action with tab parameter
				if (message.action === "switchTab" && message.tab) {
					const targetTab = message.tab === "history" ? "chat" : (message.tab as Tab)
					// Extract targetSection from values if provided
					const targetSection = message.values?.section as string | undefined
					switchTab(targetTab, targetSection)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					const section = message.values?.section as string | undefined
					const marketplaceTab = message.values?.marketplaceTab as string | undefined

					if (newTab) {
						switchTab(newTab, section, marketplaceTab)
					}
				}
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					hasCheckpoint: message.hasCheckpoint || false,
				})
			}

			if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
				setEditMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					text: message.text,
					hasCheckpoint: message.hasCheckpoint || false,
					images: message.images || [],
				})
			}

			if (message.type === "acceptInput") {
				chatViewRef.current?.acceptInput()
			}
		},
		[switchTab],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	useEffect(() => {
		const isRecoverableTab = tab === "settings" || tab === "marketplace"

		if (showWelcome && settingsImportedAt && settingsImportedAt !== handledImportRef.current) {
			handledImportRef.current = settingsImportedAt
			if (!isRecoverableTab) {
				setCurrentSection("providers")
				setCurrentMarketplaceTab(undefined)
				setTab("settings")
			}
		}
	}, [showWelcome, settingsImportedAt, tab])

	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	// Tell the extension that we are ready to receive messages.
	useEffect(() => vscode.postMessage({ type: "webviewDidLaunch" }), [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)
	// Track marketplace tab views
	useEffect(() => {
		if (tab === "marketplace") {
			telemetryClient.capture(TelemetryEventName.MARKETPLACE_TAB_VIEWED)
		}
	}, [tab])

	if (!didHydrateState) {
		return null
	}

	if (renderContext === "sidebar") {
		return <TaskNavigationView />
	}
	if (renderContext === "artifact") {
		return <ArtifactView />
	}

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	const isSetupGatedTab = showWelcome && tab !== "settings" && tab !== "marketplace"

	/*
	 * Setup renders inside the shell, not instead of it.
	 *
	 * Returning `<WelcomeView />` on its own took the whole window with it: the
	 * management rail and the task column vanished and the product briefly looked
	 * like a different application. Seen on a running build when the provider
	 * configuration went missing mid-session. The chrome is the product; only the
	 * middle column is gated.
	 */
	return (
		<ShellFrame tab={tab} section={currentSection} onSelect={switchTab}>
			{isSetupGatedTab ? (
				<WelcomeView />
			) : (
				<>
					{tab === "settings" && (
						<SettingsView ref={settingsRef} onDone={() => setTab("chat")} targetSection={currentSection} />
					)}
					{tab === "marketplace" && (
						<MarketplaceView
							stateManager={marketplaceStateManager}
							onDone={() => switchTab("chat")}
							targetTab={currentMarketplaceTab as "mcp" | "mode" | "skills" | "extensions" | undefined}
						/>
					)}
					<ChatView
						ref={chatViewRef}
						isHidden={tab !== "chat"}
						showAnnouncement={showAnnouncement}
						hideAnnouncement={() => setShowAnnouncement(false)}
					/>
					{deleteMessageDialogState.hasCheckpoint ? (
						<MemoizedCheckpointRestoreDialog
							open={deleteMessageDialogState.isOpen}
							type="delete"
							hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
									restoreCheckpoint,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<MemoizedDeleteMessageDialog
							open={deleteMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
					{editMessageDialogState.hasCheckpoint ? (
						<MemoizedCheckpointRestoreDialog
							open={editMessageDialogState.isOpen}
							type="edit"
							hasCheckpoint={editMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									restoreCheckpoint,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<MemoizedEditMessageDialog
							open={editMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									images: editMessageDialogState.images,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
				</>
			)}
		</ShellFrame>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ErrorBoundary>
		<ExtensionStateContextProvider>
			<TranslationProvider>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
						<React.Suspense fallback={null}>
							<App />
						</React.Suspense>
					</TooltipProvider>
				</QueryClientProvider>
			</TranslationProvider>
		</ExtensionStateContextProvider>
	</ErrorBoundary>
)

export default AppWithProviders
