// npx vitest core/webview/__tests__/webviewMessageHandler.revealPane.spec.ts

import type { Mock } from "vitest"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import * as vscode from "vscode"

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn() },
	window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
}))

const executeCommand = vscode.commands.executeCommand as Mock

/**
 * The management rail is the product's pane switcher.
 *
 * The editor groups no longer draw tab strips, so this message is the only way to
 * put the keyboard into a pane.
 *
 * It must reach OctoCode's own focus command, not `focusNthEditorGroup`. The rail
 * lives in a webview, and a focused webview holds the browser's focus: the stock
 * command marks the group active — the window title changes — while every
 * keystroke still goes to the chat box. Measured on a running build, where
 * `document.activeElement` stayed the webview iframe throughout. OctoCode's
 * command releases that hold first.
 */
describe("webviewMessageHandler - revealWorkbenchPane", () => {
	let provider: ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
		provider = {
			getState: vi.fn(),
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			cwd: "/mock/workspace",
		} as unknown as ClineProvider
	})

	it.each([
		["preview", 1],
		["terminal", 2],
	])("focuses the %s pane by its position in the grid", async (pane, position) => {
		await webviewMessageHandler(provider, { type: "revealWorkbenchPane", text: pane })

		// Open/reveal first, then await the product focus command so focus cannot race.
		expect(executeCommand.mock.calls).toEqual([
			[pane === "preview" ? "octocode.openArtifactPanel" : "octocode.openRuntimeTerminal"],
			["workbench.action.octocode.focusEditorGroupByPosition", position],
		])
	})

	it("has no browser entry", async () => {
		// `octocode.openBrowserPanel` passes `relocateExisting`, which the host
		// action treats as "move an existing browser and return" — it never creates
		// one. A rail entry wired to it is a button that does nothing until a
		// browser already exists, so there is deliberately no such entry.
		await webviewMessageHandler(provider, { type: "revealWorkbenchPane", text: "browser" })

		expect(executeCommand).not.toHaveBeenCalled()
	})

	it.each([["settings"], ["workbench.action.reloadWindow"], [""], [undefined]])(
		"runs nothing for %s",
		async (pane) => {
			// The webview may reach the panes this product owns and nothing else: the
			// name is looked up in a fixed table rather than executed as a command.
			await webviewMessageHandler(provider, { type: "revealWorkbenchPane", text: pane as string })

			expect(executeCommand).not.toHaveBeenCalled()
		},
	)
})
