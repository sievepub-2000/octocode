// npx vitest core/webview/__tests__/webviewMessageHandler.searchFiles.spec.ts

import type { Mock } from "vitest"

// Mock dependencies - must come before imports
vi.mock("../../../services/search/file-search")
vi.mock("../../ignore/RooIgnoreController")

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import { searchWorkspaceFiles } from "../../../services/search/file-search"
import { RooIgnoreController } from "../../ignore/RooIgnoreController"

const mockSearchWorkspaceFiles = searchWorkspaceFiles as Mock<typeof searchWorkspaceFiles>

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
	},
}))

describe("webviewMessageHandler - searchFiles with RooIgnore filtering", () => {
	let mockClineProvider: ClineProvider
	let mockFilterPaths: Mock
	let mockDispose: Mock

	beforeEach(() => {
		vi.clearAllMocks()

		// Spy on the mock RooIgnoreController prototype methods
		mockFilterPaths = vi.fn()
		mockDispose = vi.fn()

		// Override the filterPaths method on the prototype
		;(RooIgnoreController.prototype as any).filterPaths = mockFilterPaths
		;(RooIgnoreController.prototype as any).initialize = vi.fn().mockResolvedValue(undefined)
		;(RooIgnoreController.prototype as any).dispose = mockDispose

		// Create mock ClineProvider
		mockClineProvider = {
			getState: vi.fn(),
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			cwd: "/mock/workspace",
		} as unknown as ClineProvider
	})

	it("should handle error when no workspace path is available", async () => {
		// Create provider without cwd
		mockClineProvider = {
			...mockClineProvider,
			cwd: undefined,
			getCurrentTask: vi.fn().mockReturnValue(null),
		} as unknown as ClineProvider

		await webviewMessageHandler(mockClineProvider, {
			type: "searchFiles",
			query: "test",
			requestId: "test-request-error",
		})

		// Verify error response was sent
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [],
			requestId: "test-request-error",
			error: "No workspace path available",
		})
	})
})
