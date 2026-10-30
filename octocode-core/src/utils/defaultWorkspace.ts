import { exec } from "child_process"
import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import { promisify } from "util"
import * as vscode from "vscode"

const execAsync = promisify(exec)

/**
 * What a fresh workspace starts with.
 *
 * Only the agent's own scratch output. Everything else here is the user's work
 * and belongs in history.
 */
const DEFAULT_GITIGNORE = `# OctoCode scratch output
.agents/tmp/
*.log
`

/**
 * Puts the workspace under version control.
 *
 * Without this the default workspace is an ordinary directory, and a whole class
 * of the product's own behaviour quietly does nothing: diffs, checkpoints,
 * rollback and every worktree feature need a repository to work against. It was
 * not initialised anywhere — a health check found the shipped workspace was not a
 * repository at all — so the agent could edit files it had no way to undo.
 *
 * Best effort on purpose. A workspace that cannot become a repository is still a
 * usable workspace, so a failure is recorded and the caller carries on.
 */
async function ensureGitRepository(workspacePath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	try {
		await fs.access(path.join(workspacePath, ".git"))
		return
	} catch {
		// Not a repository yet.
	}

	try {
		await execAsync("git init", { cwd: workspacePath })

		const gitignorePath = path.join(workspacePath, ".gitignore")
		try {
			await fs.access(gitignorePath)
		} catch {
			await fs.writeFile(gitignorePath, DEFAULT_GITIGNORE, "utf8")
		}

		outputChannel.appendLine(`[workspace] Initialised git repository: ${workspacePath}`)
	} catch (error) {
		outputChannel.appendLine(
			`[workspace] Could not initialise git repository: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/** The sole workspace source: user configuration, otherwise the installation default. */
export function configuredWorkspacePath(appRoot = vscode.env.appRoot): string {
	const configured = (vscode.workspace.getConfiguration("octocode").get<string>("workspace.path", "") ?? "").trim()
	if (configured && !path.isAbsolute(configured)) throw new Error("OctoCode 工作区路径必须是绝对路径")
	return configured ? path.normalize(configured) : path.resolve(appRoot, "..", "..", "workspace")
}

export async function ensureDefaultWorkspace(
	_context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
	appRoot = vscode.env.appRoot,
): Promise<string | undefined> {
	const workspacePath = configuredWorkspacePath(appRoot)
	await fs.mkdir(workspacePath, { recursive: true })
	await fs.access(workspacePath, constants.W_OK)
	const installationWorkspace = path.resolve(appRoot, "..", "..", "workspace")
	const isInstallationWorkspace =
		process.platform === "win32"
			? workspacePath.toLowerCase() === installationWorkspace.toLowerCase()
			: workspacePath === installationWorkspace
	if (isInstallationWorkspace) {
		await fs.writeFile(path.join(workspacePath, "Program"), "", { flag: "a" })
		if (process.platform === "win32") {
			const legacyMarker = path.join(path.parse(workspacePath).root, "Program")
			const legacy = await fs.lstat(legacyMarker).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error
				return undefined
			})
			// Only migrate the empty legacy marker; named user files and links are preserved.
			if (legacy?.isFile() && legacy.size === 0) await fs.unlink(legacyMarker)
		}
		await ensureGitRepository(workspacePath, outputChannel)
	}
	const openFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	const same =
		openFolder &&
		(process.platform === "win32"
			? path.resolve(openFolder).toLowerCase() === workspacePath.toLowerCase()
			: path.resolve(openFolder) === workspacePath)
	outputChannel.appendLine(`[workspace] Effective configured workspace: ${workspacePath}`)
	if (same && vscode.workspace.workspaceFolders?.length === 1) return undefined
	await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspacePath), false)
	return workspacePath
}
