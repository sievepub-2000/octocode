// npx vitest core/webview/__tests__/webviewMessageHandler.importRooHistory.spec.ts

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined), update: vi.fn() })),
	},
	env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
	commands: { executeCommand: vi.fn() },
	Uri: { parse: vi.fn((s: string) => ({ toString: () => s })), file: vi.fn((p: string) => ({ fsPath: p })) },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}))

const importLegacyHistoryMock = vi.fn()
vi.mock("../../../services/octocode-runtime/importLegacyHistory", () => ({
	importLegacyHistory: (...args: any[]) => importLegacyHistoryMock(...args),
}))
vi.mock("../../../services/octocode-runtime/OctoCodeRuntime", () => ({
	getOctoCodeRuntime: () => ({ call: vi.fn() }),
}))

import * as vscode from "vscode"

/**
 * Bringing a Roo installation's conversations across.
 *
 * The import is the one path that writes history from outside the runtime, so
 * what matters here is that it reports itself honestly: the webview shows a
 * progress row that only clears on "finished" or "failed", and a silent throw
 * would leave that row spinning forever.
 */
describe("webviewMessageHandler - importRooHistory", () => {
	let mockProvider: ClineProvider & { postMessageToWebview: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		vi.clearAllMocks()
		mockProvider = {
			contextProxy: { getValue: vi.fn(), setValue: vi.fn(), globalStorageUri: { fsPath: "/mock/storage" } },
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		} as any
	})

	it("reads the legacy stores, reports the counts, and returns to the conversation", async () => {
		importLegacyHistoryMock.mockResolvedValue({ found: 4, imported: 3, skipped: 1, backups: [] })

		await webviewMessageHandler(mockProvider as any, { type: "importRooHistory" } as any)

		const options = importLegacyHistoryMock.mock.calls[0][0]
		// The extension's own storage plus the Roo directory beside it: both are
		// searched, because an installation that was upgraded in place keeps its
		// tasks under the old publisher's folder.
		expect(options.sourceRoots).toContain("/mock/storage")
		expect(options.sourceRoots.some((root: string) => root.includes("rooveterinaryinc.roo-cline"))).toBe(true)
		expect(options.backupRoot).toContain("legacy-backups")
		expect(typeof options.call).toBe("function")

		expect(mockProvider.postMessageToWebview).toHaveBeenNthCalledWith(1, {
			type: "rooHistoryImportProgress",
			rooHistoryImportProgress: {
				status: "starting",
				copiedFileCount: 0,
				totalFileCount: 0,
				importedTaskCount: 0,
				totalTaskCount: 0,
			},
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenNthCalledWith(2, {
			type: "rooHistoryImportProgress",
			rooHistoryImportProgress: {
				status: "finished",
				copiedFileCount: 0,
				totalFileCount: 0,
				importedTaskCount: 3,
				totalTaskCount: 4,
			},
		})
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:ui.historyImported")
		// One way back, and it is the conversation the task column already lists.
		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "action",
			action: "chatButtonClicked",
		})
	})

	it("clears the progress row and says why when the import throws", async () => {
		importLegacyHistoryMock.mockRejectedValue(new Error("permission denied"))

		await webviewMessageHandler(mockProvider as any, { type: "importRooHistory" } as any)

		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "rooHistoryImportProgress",
			rooHistoryImportProgress: {
				status: "failed",
				copiedFileCount: 0,
				totalFileCount: 0,
				importedTaskCount: 0,
				totalTaskCount: 0,
			},
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:ui.historyImportFailed")
	})
})
