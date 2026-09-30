import * as vscode from "vscode"

/**
 * Whether OctoCode draws its own window chrome.
 *
 * Several call sites have to agree on this — the workbench layout helper, the
 * panel opener, and activation — and they were getting it wrong independently:
 * one of them still reopened the host's side bar, which put a second task list
 * on screen seconds after launch. Reading the setting through one function keeps
 * them from drifting apart again.
 *
 * Mirrors `octocode.shell.ownWindowChrome` in the desktop shell, which defaults
 * to on; an unset value therefore means enabled.
 */
export function shellOwnsWindow(): boolean {
	return vscode.workspace.getConfiguration("octocode.shell").get<boolean>("ownWindowChrome") !== false
}
