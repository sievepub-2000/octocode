import { describe, expect, it, vi } from "vitest"

import {
	OCTOCODE_EDITOR_LAYOUT,
	OCTOCODE_SHELL_EDITOR_LAYOUT,
	applyOctoCodeWorkbenchLayout,
	isOctoCodeWorkbenchLayout,
} from "../workbenchLayout"

describe("OctoCode native workbench layout", () => {
	it("keeps chat central and splits the right column into artifact and terminal groups", () => {
		expect(OCTOCODE_EDITOR_LAYOUT).toEqual({
			orientation: 0,
			groups: [{ size: 0.58 }, { orientation: 1, size: 0.42, groups: [{ size: 0.75 }, { size: 0.25 }] }],
		})
	})

	it("gives the shell's own grid a wider first group", () => {
		// The rail and the task list move inside the first group when the shell draws
		// the window — about 356px of it. Reusing the host proportions would take
		// that width out of the conversation rather than out of the window.
		expect(OCTOCODE_SHELL_EDITOR_LAYOUT.groups[0].size).toBeGreaterThan(OCTOCODE_EDITOR_LAYOUT.groups[0].size)
		expect(OCTOCODE_SHELL_EDITOR_LAYOUT.groups[0].size + OCTOCODE_SHELL_EDITOR_LAYOUT.groups[1].size).toBe(1)
		expect(isOctoCodeWorkbenchLayout(OCTOCODE_SHELL_EDITOR_LAYOUT)).toBe(true)
	})

	it("still builds the grid when OctoCode draws its own window, but leaves the side bar alone", async () => {
		// The shell replaces the activity bar and the side bar — not the editor
		// grid, which is what puts the execution terminal in the lower-right group.
		// Skipping the grid here left the terminal nowhere to go but a full-width
		// strip along the bottom of the window.
		//
		// Revealing the activity bar is the part that must not happen: that command
		// reopens the very side bar the shell replaces, and on a running build it
		// came back seconds after launch carrying a second copy of the task list.
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ orientation: 0, groups: [{}] })
			.mockResolvedValue(undefined)

		await expect(applyOctoCodeWorkbenchLayout(execute, true)).resolves.toBe(true)
		expect(execute.mock.calls).toEqual([
			["vscode.getEditorLayout"],
			["vscode.setEditorLayout", OCTOCODE_SHELL_EDITOR_LAYOUT],
			["workbench.action.closeAuxiliaryBar"],
			["workbench.action.closePanel"],
		])
	})

	it("repairs a wrong editor grid before opening the task navigator", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce({ orientation: 0, groups: [{}] })
			.mockResolvedValue(undefined)

		await expect(applyOctoCodeWorkbenchLayout(execute)).resolves.toBe(true)
		expect(execute.mock.calls).toEqual([
			["vscode.getEditorLayout"],
			["vscode.setEditorLayout", OCTOCODE_EDITOR_LAYOUT],
			["workbench.view.extension.octocode-ActivityBar"],
			["workbench.action.closeAuxiliaryBar"],
		])
	})

	it("restores default sizes on explicit reset and closes a misplaced bottom panel", async () => {
		const execute = vi.fn().mockResolvedValueOnce(OCTOCODE_SHELL_EDITOR_LAYOUT).mockResolvedValue(undefined)
		await applyOctoCodeWorkbenchLayout(execute, true, true)
		expect(execute).toHaveBeenCalledWith("vscode.setEditorLayout", OCTOCODE_SHELL_EDITOR_LAYOUT)
		expect(execute).toHaveBeenCalledWith("workbench.action.closePanel")
	})

	it("preserves user-resized groups when the required topology already exists", async () => {
		const current = {
			orientation: 0,
			groups: [{ size: 0.7 }, { orientation: 1, size: 0.3, groups: [{ size: 0.6 }, { size: 0.4 }] }],
		}
		const execute = vi.fn().mockResolvedValueOnce(current).mockResolvedValue(undefined)

		expect(isOctoCodeWorkbenchLayout(current)).toBe(true)
		await applyOctoCodeWorkbenchLayout(execute)
		expect(execute.mock.calls).toEqual([
			["vscode.getEditorLayout"],
			["workbench.view.extension.octocode-ActivityBar"],
			["workbench.action.closeAuxiliaryBar"],
		])
	})
})
