export type WorkbenchCommandExecutor = (command: string, ...args: unknown[]) => PromiseLike<unknown>

export const OCTOCODE_EDITOR_LAYOUT = {
	orientation: 0,
	groups: [{ size: 0.58 }, { orientation: 1, size: 0.42, groups: [{ size: 0.75 }, { size: 0.25 }] }],
} as const

/**
 * The same three panes, sized for the window OctoCode draws itself.
 *
 * The proportions above assume the icon rail and the task list live outside the
 * editor area, in the host's own chrome. In the shell they live *inside* the
 * first group — roughly 356px of it — so reusing 0.58 silently takes that width
 * out of the conversation instead of out of the window. Widening the first group
 * to 0.66 leaves the conversation and the preview at the widths they had before
 * the shell existed.
 */
export const OCTOCODE_SHELL_EDITOR_LAYOUT = {
	orientation: 0,
	groups: [{ size: 0.66 }, { orientation: 1, size: 0.34, groups: [{ size: 0.75 }, { size: 0.25 }] }],
} as const

type LayoutGroup = { orientation?: number; groups?: LayoutGroup[] }
type EditorLayout = { orientation?: number; groups?: LayoutGroup[] }

export function isOctoCodeWorkbenchLayout(layout: unknown): boolean {
	if (!layout || typeof layout !== "object") return false
	const root = layout as EditorLayout
	const [chat, right] = root.groups ?? []
	const [artifact, terminal] = right?.groups ?? []
	return (
		root.orientation === 0 &&
		root.groups?.length === 2 &&
		!chat?.groups &&
		right?.orientation === 1 &&
		right.groups?.length === 2 &&
		!artifact?.groups &&
		!terminal?.groups
	)
}

/**
 * Arranges the host's editor groups into the three-pane layout: the shell on the
 * left, the preview upper-right, the execution terminal below it.
 *
 * @param shellOwnsWindow When OctoCode draws its own window, the editor grid is
 * still arranged — the terminal belongs in the lower-right group and there is
 * nowhere else in the window it can be — but the activity bar is not revealed.
 * That command reopens the very side bar the shell replaces; on a running build
 * the side bar came back seconds after launch, carrying a second copy of the
 * task list.
 */
export async function applyOctoCodeWorkbenchLayout(
	execute: WorkbenchCommandExecutor,
	shellOwnsWindow = false,
	resetSizes = false,
): Promise<boolean> {
	const current = await execute("vscode.getEditorLayout")
	if (resetSizes || !isOctoCodeWorkbenchLayout(current)) {
		await execute("vscode.setEditorLayout", shellOwnsWindow ? OCTOCODE_SHELL_EDITOR_LAYOUT : OCTOCODE_EDITOR_LAYOUT)
	}
	if (!shellOwnsWindow) await execute("workbench.view.extension.octocode-ActivityBar")
	await execute("workbench.action.closeAuxiliaryBar")
	if (shellOwnsWindow) await execute("workbench.action.closePanel")
	return true
}
