import * as vscode from "vscode"
import { Package } from "../shared/package"
import { ClineProvider } from "../core/webview/ClineProvider"
import { CHAT_VIEW_COLUMN } from "../integrations/misc/artifactSlot"

/**
 * Focus the active panel (either tab or sidebar)
 * @param tabPanel - The tab panel reference
 * @param sidebarPanel - The sidebar panel reference
 * @returns Promise that resolves when focus is complete
 */
export async function focusPanel(
	tabPanel: vscode.WebviewPanel | undefined,
	sidebarPanel: vscode.WebviewView | undefined,
): Promise<void> {
	const panel = tabPanel || sidebarPanel

	if (!panel) {
		// If no panel is open, open the sidebar
		await vscode.commands.executeCommand(`workbench.view.extension.${Package.name}-ActivityBar`)
	} else if (panel === tabPanel && !panel.active) {
		// Reveal the conversation in its own group. `ViewColumn.Active` would move
		// the chat panel into whichever group happens to be focused, which breaks
		// the fixed chat / multimodal / execution layout.
		panel.reveal(CHAT_VIEW_COLUMN, false)
	} else if (panel === sidebarPanel) {
		// For sidebar panels, focus the sidebar
		await vscode.commands.executeCommand(`${ClineProvider.sideBarId}.focus`)
	}
}
