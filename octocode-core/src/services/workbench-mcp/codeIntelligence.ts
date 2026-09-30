export const CODE_INTELLIGENCE_ACTIONS = [
	"diagnostics",
	"definition",
	"references",
	"hover",
	"symbols",
	"rename",
	"rename_file",
	"code_actions",
	"type_definition",
	"implementation",
	"status",
	"reload",
	"capabilities",
	"request",
] as const

import { requireWorkbenchPermission, type WorkbenchTaskIdentity } from "./toolPermissions"

const RAW_LANGUAGE_COMMANDS = new Set([
	"vscode.executeDefinitionProvider",
	"vscode.executeReferenceProvider",
	"vscode.executeHoverProvider",
	"vscode.executeDocumentSymbolProvider",
	"vscode.executeWorkspaceSymbolProvider",
	"vscode.executeTypeDefinitionProvider",
	"vscode.executeImplementationProvider",
	"vscode.executeCodeActionProvider",
])

export function rawLspCommand(command: string): string {
	if (!RAW_LANGUAGE_COMMANDS.has(command)) throw new Error(`Raw language request is not allowed: ${command}`)
	return command
}

export type CodeIntelligenceRequest = {
	action: (typeof CODE_INTELLIGENCE_ACTIONS)[number]
	path?: string
	line?: number
	column?: number
	query?: string
	newName?: string
	newPath?: string
	command?: string
	arguments?: unknown[]
}

const POSITION_ACTIONS = new Set(["definition", "references", "hover", "rename", "type_definition", "implementation"])

export function validateCodeIntelligenceRequest(value: unknown): CodeIntelligenceRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Code intelligence request must be an object")
	const request = value as Record<string, unknown>
	if (!CODE_INTELLIGENCE_ACTIONS.includes(request.action as CodeIntelligenceRequest["action"]))
		throw new Error(`Unknown code intelligence action: ${String(request.action)}`)
	if (POSITION_ACTIONS.has(request.action as string)) {
		if (typeof request.path !== "string" || !request.path.trim()) throw new Error(`${request.action} requires path`)
		if (!positiveInteger(request.line) || !positiveInteger(request.column))
			throw new Error(`${request.action} requires positive line and column`)
	}
	if (request.action === "rename" && (typeof request.newName !== "string" || !request.newName.trim()))
		throw new Error("rename requires newName")
	if (request.action === "rename_file") {
		if (typeof request.path !== "string" || !request.path.trim()) throw new Error("rename_file requires path")
		if (typeof request.newPath !== "string" || !request.newPath.trim())
			throw new Error("rename_file requires newPath")
	}
	if (request.action === "request") {
		if (typeof request.command !== "string") throw new Error("request requires command")
		rawLspCommand(request.command)
	}
	return request as CodeIntelligenceRequest
}

/**
 * Language servers only analyse open documents, so a file the agent just wrote
 * reported no diagnostics at all. Open it (without showing it) and wait until its
 * diagnostics stop changing; a clean file publishes nothing, hence the cap.
 */
async function diagnosticsFor(
	uri: vscode.Uri,
	settleMs = 1_500,
	maxMs = 10_000,
): Promise<readonly vscode.Diagnostic[]> {
	const key = uri.toString()
	if (vscode.workspace.textDocuments.some((document) => document.uri.toString() === key))
		return vscode.languages.getDiagnostics(uri)
	await new Promise<void>((resolve) => {
		let settle: ReturnType<typeof setTimeout> | undefined
		const cap = setTimeout(done, maxMs)
		const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
			if (!event.uris.some((changed) => changed.toString() === key)) return
			clearTimeout(settle)
			settle = setTimeout(done, settleMs)
		})
		function done() {
			clearTimeout(cap)
			clearTimeout(settle)
			subscription.dispose()
			resolve()
		}
		vscode.workspace.openTextDocument(uri).then(undefined, done)
	})
	return vscode.languages.getDiagnostics(uri)
}

export async function dispatchCodeIntelligence(value: unknown, task?: WorkbenchTaskIdentity): Promise<unknown> {
	const request = validateCodeIntelligenceRequest(value)
	if (["rename", "rename_file", "code_actions"].includes(request.action)) {
		requireWorkbenchPermission("write", task)
	}
	const uri = request.path ? resolveUri(request.path) : undefined
	const position =
		request.line && request.column ? new vscode.Position(request.line - 1, request.column - 1) : undefined
	switch (request.action) {
		case "diagnostics": {
			const entries = uri ? [[uri, await diagnosticsFor(uri)] as const] : vscode.languages.getDiagnostics()
			return entries.map(([entryUri, diagnostics]) => ({
				path: entryUri.fsPath,
				diagnostics: diagnostics.map((item) => ({
					message: item.message,
					severity: item.severity,
					line: item.range.start.line + 1,
					column: item.range.start.character + 1,
					source: item.source,
					code: typeof item.code === "object" ? item.code.value : item.code,
				})),
			}))
		}
		case "definition":
			return vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, position)
		case "references":
			return vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position)
		case "hover":
			return vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position)
		case "type_definition":
			return vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", uri, position)
		case "implementation":
			return vscode.commands.executeCommand("vscode.executeImplementationProvider", uri, position)
		case "symbols":
			if (request.query !== undefined)
				return vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", request.query)
			if (!uri) throw new Error("symbols requires path or query")
			return vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)
		case "rename": {
			const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
				"vscode.executeDocumentRenameProvider",
				uri,
				position,
				request.newName,
			)
			if (!edit) throw new Error("No rename edit was returned by the language provider")
			return { applied: await vscode.workspace.applyEdit(edit) }
		}
		case "rename_file": {
			const edit = new vscode.WorkspaceEdit()
			edit.renameFile(uri!, resolveUri(request.newPath!), { overwrite: false })
			return { applied: await vscode.workspace.applyEdit(edit) }
		}
		case "code_actions": {
			if (!uri) throw new Error("code_actions requires path")
			const point = position ?? new vscode.Position(0, 0)
			return vscode.commands.executeCommand(
				"vscode.executeCodeActionProvider",
				uri,
				new vscode.Range(point, point),
			)
		}
		case "status":
			return {
				adapter: "vscode",
				workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
				diagnosticFiles: vscode.languages.getDiagnostics().length,
			}
		case "reload":
			return { reloaded: false, reason: "VS Code has no generic language-server reload API" }
		case "capabilities":
			return { adapter: "vscode", actions: CODE_INTELLIGENCE_ACTIONS }
		case "request":
			return vscode.commands.executeCommand(rawLspCommand(request.command!), ...(request.arguments ?? []))
	}
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function resolveUri(file: string): vscode.Uri {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
	return vscode.Uri.file(path.isAbsolute(file) ? file : path.resolve(root, file))
}
import * as path from "node:path"
import * as vscode from "vscode"
