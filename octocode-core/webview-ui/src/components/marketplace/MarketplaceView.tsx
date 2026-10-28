import { useState, useEffect, useMemo, useContext } from "react"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { Tab, TabContent, TabHeader } from "../common/Tab"
import { MarketplaceViewStateManager } from "./MarketplaceViewStateManager"
import { useStateManager } from "./useStateManager"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { MarketplaceListView } from "./MarketplaceListView"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { ExtensionList } from "./ExtensionList"

interface MarketplaceViewProps {
	onDone?: () => void
	stateManager: MarketplaceViewStateManager
	targetTab?: "mcp" | "mode" | "skills" | "extensions" | "environments"
}
export function MarketplaceView({ stateManager, onDone, targetTab = "mcp" }: MarketplaceViewProps) {
	const { t } = useAppTranslation()
	const [catalog, setCatalog] = useState(targetTab === "mode" ? "skills" : targetTab)
	const [state, manager] = useStateManager(stateManager)
	const [hasReceivedInitialState, setHasReceivedInitialState] = useState(false)
	const extensionState = useContext(ExtensionStateContext)
	const [lastOrganizationSettingsVersion, setLastOrganizationSettingsVersion] = useState<number>(
		extensionState?.organizationSettingsVersion ?? -1,
	)

	useEffect(() => {
		const currentVersion = extensionState?.organizationSettingsVersion ?? -1
		if (currentVersion !== lastOrganizationSettingsVersion) {
			vscode.postMessage({
				type: "fetchMarketplaceData",
			})
		}
		setLastOrganizationSettingsVersion(currentVersion)
	}, [extensionState?.organizationSettingsVersion, lastOrganizationSettingsVersion])

	// Track when we receive the initial state
	useEffect(() => {
		// Check if we already have items (state might have been received before mount)
		if (state.allItems.length > 0 && !hasReceivedInitialState) {
			setHasReceivedInitialState(true)
		}
	}, [state.allItems, hasReceivedInitialState])

	useEffect(() => {
		setCatalog(targetTab === "mode" ? "skills" : targetTab)
	}, [targetTab, manager])
	useEffect(() => {
		if (catalog === "mcp") manager.transition({ type: "SET_ACTIVE_TAB", payload: { tab: catalog } })
	}, [catalog, manager])

	// Ensure marketplace state manager processes messages when component mounts
	useEffect(() => {
		// When the marketplace view first mounts, we need to trigger a state update
		// to ensure we get the current marketplace items. We do this by sending
		// a filter message with empty filters, which will cause the extension to
		// send back the full state including all marketplace items.
		if (!hasReceivedInitialState && state.allItems.length === 0) {
			// Fetch marketplace data on demand
			// Note: isFetching is already true by default for initial load
			vscode.postMessage({
				type: "fetchMarketplaceData",
			})
		}

		// Listen for state changes to know when initial data arrives
		const unsubscribe = manager.onStateChange((newState) => {
			// Mark as received initial state when we get any state update
			// This prevents infinite loops and ensures proper state handling
			if (!hasReceivedInitialState && (newState.allItems.length > 0 || newState.displayItems !== undefined)) {
				setHasReceivedInitialState(true)
			}
		})

		const handleVisibilityMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "webviewVisible" && message.visible === true) {
				// Data will be automatically fresh when panel becomes visible
				// No manual fetching needed since we removed caching
			}
		}

		window.addEventListener("message", handleVisibilityMessage)
		return () => {
			window.removeEventListener("message", handleVisibilityMessage)
			unsubscribe()
		}
	}, [manager, hasReceivedInitialState, state.allItems.length])

	// Memoize all available tags
	const allTags = useMemo(
		() => Array.from(new Set(state.allItems.flatMap((item) => item.tags || []))).sort(),
		[state.allItems],
	)

	// Memoize filtered tags
	const filteredTags = useMemo(() => allTags, [allTags])

	return (
		<TooltipProvider delayDuration={300}>
			<Tab>
				<TabHeader className="flex flex-col sticky top-0 z-10 px-3 py-2">
					<div className="flex items-center justify-between gap-2 px-2">
						<div className="flex items-center gap-2">
							<Button
								variant="ghost"
								className="px-1.5 -ml-2"
								onClick={() => onDone?.()}
								aria-label={t("settings:back")}>
								<ArrowLeft />
								<span className="sr-only">{t("settings:back")}</span>
							</Button>
							<h3 className="font-bold m-0">{t("common:ui.marketplace")}</h3>
						</div>
					</div>
					<nav aria-label={t("common:ui.marketplaceCategories")} className="mt-2 flex flex-wrap gap-1">
						{(
							[
								["extensions", t("common:ui.extensions")],
								["skills", t("common:ui.skills")],
								["mcp", t("common:ui.mcpServices")],
								["environments", t("common:extensions.environments")],
							] as const
						).map(([id, label]) => (
							<Button
								key={id}
								variant={catalog === id ? "primary" : "secondary"}
								aria-pressed={catalog === id}
								onClick={() => setCatalog(id)}>
								{label}
							</Button>
						))}
					</nav>
				</TabHeader>

				<TabContent className="p-3 pt-2">
					{catalog === "skills" ? (
						<ExtensionList
							key="skills"
							kind="skill"
							tabs
							searchable
							hint={t("common:extensions.systemToolsHint")}
						/>
					) : catalog === "environments" ? (
						<ExtensionList kind="environment" searchable hint={t("common:extensions.environmentsHint")} />
					) : catalog === "extensions" ? (
						<ExtensionList
							key="extensions"
							kind="extension"
							tabs
							searchable
							hint={t("common:extensions.vscodeHint")}
						/>
					) : catalog === "mcp" ? (
						<ExtensionList
							key="mcp"
							kind="mcp"
							tabs
							searchable
							hint={t("common:extensions.systemToolsHint")}
						/>
					) : (
						<MarketplaceListView
							stateManager={stateManager}
							allTags={allTags}
							filteredTags={filteredTags}
							filterByType={catalog}
						/>
					)}
				</TabContent>
			</Tab>
		</TooltipProvider>
	)
}
