import * as vscode from "vscode"

/**
 * OctoCode's workbench has exactly three editor groups (see
 * `activate/workbenchLayout.ts`):
 *
 * - {@link CHAT_VIEW_COLUMN} — the conversation. Text only: the user's messages,
 *   the model's replies, and grey inline progress/reasoning lines.
 * - {@link ARTIFACT_VIEW_COLUMN} — the right-hand multimodal slot. *Every*
 *   visual surface belongs here: browser pages, files and diffs, images, audio,
 *   video, 3D scenes, markdown previews, build output.
 * - {@link EXECUTION_VIEW_COLUMN} — the real PowerShell terminal. Raw commands
 *   and their stdout/stderr only.
 *
 * Opening a document without naming a column sends it to the *active* group,
 * which is normally the conversation — that is how visual content used to leak
 * into the chat. Route every such call through the helpers here so there is one
 * place that decides where a surface lands.
 */
// Written as the literal `ViewColumn` values rather than as
// `vscode.ViewColumn.One`, because this module is imported by code whose tests
// stub the `vscode` namespace: reading the enum at module-evaluation time makes
// importing this file throw in every suite whose stub omits `ViewColumn`. The
// suite in `__tests__/artifactSlot.spec.ts` asserts these stay in step with the
// real enum.
export const CHAT_VIEW_COLUMN = 1 as vscode.ViewColumn
export const ARTIFACT_VIEW_COLUMN = 2 as vscode.ViewColumn
export const EXECUTION_VIEW_COLUMN = 3 as vscode.ViewColumn

/**
 * Show options pinned to the multimodal slot. Callers may override presentation
 * details (`preview`, `preserveFocus`, `selection`, …) but not the column.
 */
export function artifactShowOptions(
	overrides: Omit<vscode.TextDocumentShowOptions, "viewColumn"> = {},
): vscode.TextDocumentShowOptions {
	return { preserveFocus: true, ...overrides, viewColumn: ARTIFACT_VIEW_COLUMN }
}

/** Open a text document in the multimodal slot. */
export async function showTextDocumentInArtifactSlot(
	target: vscode.TextDocument | vscode.Uri,
	overrides: Omit<vscode.TextDocumentShowOptions, "viewColumn"> = {},
): Promise<vscode.TextEditor> {
	// `showTextDocument` accepts a document or a URI at runtime; only the typings
	// split it into overloads. Narrowing with `instanceof vscode.Uri` would make
	// this helper depend on `Uri` being a real constructor, which breaks every
	// suite that stubs the `vscode` namespace with plain objects.
	const show = vscode.window.showTextDocument as (
		target: vscode.TextDocument | vscode.Uri,
		options: vscode.TextDocumentShowOptions,
	) => Thenable<vscode.TextEditor>
	return show(target, artifactShowOptions(overrides))
}

/**
 * Make the multimodal slot the active editor group.
 *
 * Some built-in commands (`markdown.showPreview`, extension previews) have no
 * column argument and always target the active group; focusing the slot first is
 * the only way to keep their output out of the conversation.
 */
export async function focusArtifactSlot(): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.focusSecondEditorGroup")
}

/**
 * Open a resource in the multimodal slot with the editor VS Code picks for it
 * (image viewer, media player, notebook, …), rather than in the active group.
 */
export async function openResourceInArtifactSlot(
	uri: vscode.Uri,
	overrides: Omit<vscode.TextDocumentShowOptions, "viewColumn"> = {},
): Promise<void> {
	await vscode.commands.executeCommand("vscode.open", uri, artifactShowOptions(overrides))
}
