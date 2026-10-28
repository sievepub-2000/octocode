import type React from "react"
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react"
import { loadUiLanguage, WithTranslations } from "@src/utils/test-i18n"

import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import { MarketplaceView } from "../MarketplaceView"
import { MarketplaceViewStateManager } from "../MarketplaceViewStateManager"
import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS } from "@roo-code/types"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// The labels asserted below are Chinese, and locales other than English load on
// demand — without this the view renders raw keys.
beforeAll(() => loadUiLanguage())

/*
 * Render inside a translation context that actually translates.
 *
 * `useAppTranslation` returns the key unchanged when nothing provides it, which
 * is what left every assertion below looking for text the DOM never contained.
 */
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: WithTranslations })

describe("MarketplaceView", () => {
	let stateManager: MarketplaceViewStateManager
	let mockExtensionState: any

	beforeEach(() => {
		vi.clearAllMocks()
		stateManager = new MarketplaceViewStateManager()

		// Initialize state manager with some test data
		stateManager.transition({
			type: "FETCH_COMPLETE",
			payload: {
				items: [
					{
						id: "test-mcp",
						name: "Test MCP",
						type: "mcp" as const,
						description: "Test MCP server",
						tags: ["test"],
						content: "Test content",
						url: "https://test.com",
						author: "Test Author",
					},
				],
			},
		})

		mockExtensionState = {
			organizationSettingsVersion: 1,
			// Add other required properties for the context
			didHydrateState: true,
			showWelcome: false,
			theme: {},
			mcpServers: [],
			filePaths: [],
			openedTabs: [],
			commands: [],
			organizationAllowList: { allowAll: true, providers: {} },
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			hasOpenedModeSelector: false,
			setHasOpenedModeSelector: vi.fn(),
			alwaysAllowFollowupQuestions: false,
			setAlwaysAllowFollowupQuestions: vi.fn(),
			followupAutoApproveTimeoutMs: 60000,
			setFollowupAutoApproveTimeoutMs: vi.fn(),
			profileThresholds: {},
			setProfileThresholds: vi.fn(),
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			// ... other required context properties
		}
	})

	it("should trigger fetchMarketplaceData when organization settings version changes", async () => {
		const { rerender } = render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Initial render should not trigger fetch (version hasn't changed)
		expect(vscode.postMessage).not.toHaveBeenCalledWith({
			type: "fetchMarketplaceData",
		})

		// Update the organization settings version
		mockExtensionState = {
			...mockExtensionState,
			organizationSettingsVersion: 2,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		}

		// Re-render with updated context
		rerender(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Wait for the effect to run
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "fetchMarketplaceData",
			})
		})
	})

	it("should trigger fetchMarketplaceData when organization settings version changes from -1", async () => {
		// Start with -1 version (default)
		mockExtensionState = {
			...mockExtensionState,
			organizationSettingsVersion: -1,
		}

		const { rerender } = render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Clear any initial calls
		vi.clearAllMocks()

		// Update to a defined version
		mockExtensionState = {
			...mockExtensionState,
			organizationSettingsVersion: 1,
		}

		rerender(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Should trigger fetch when transitioning from -1 to 1
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "fetchMarketplaceData",
			})
		})
	})

	it("should not trigger fetchMarketplaceData when organization settings version remains the same", async () => {
		const { rerender } = render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Re-render with same version
		rerender(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Should not trigger fetch when version hasn't changed
		await waitFor(() => {
			expect(vscode.postMessage).not.toHaveBeenCalledWith({
				type: "fetchMarketplaceData",
			})
		})
	})

	it("keeps MCP separate and places legacy Agent mode links in Skills", () => {
		const { rerender } = render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} targetTab="mcp" />
			</ExtensionStateContext.Provider>,
		)

		expect(screen.getByRole("button", { name: "MCP 服务" })).toHaveAttribute("aria-pressed", "true")
		expect(screen.queryByRole("button", { name: "Modes" })).not.toBeInTheDocument()

		rerender(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} targetTab="mode" />
			</ExtensionStateContext.Provider>,
		)
		expect(screen.queryByRole("button", { name: "Agent 模式" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Skills 技能" })).toHaveAttribute("aria-pressed", "true")
		expect(screen.queryByRole("button", { name: "MCP" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "VS Code 扩展" }))
		// VS Code extensions are managed in place, not by opening the Extensions view as an extra column.
		// The tabbed list asks for the market page and guards its reply with a request id.
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "extensionRequest",
			payload: { action: "list", kind: "extension", page: "market", requestId: expect.any(String) },
		})
		expect(screen.getByTestId("extension-list-extension")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Skills 技能" }))
		// Skills is a marketplace entry backed by the shared system tools list.
		expect(screen.getByTestId("extension-list-skill")).toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "extensionRequest",
			payload: { action: "list", kind: "skill", page: "market", requestId: expect.any(String) },
		})
	})
})
