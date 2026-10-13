import * as vscode from "vscode"
import * as path from "node:path"

export async function previewRuntimeArtifact(
	filePath: string,
	show: (filePath: string) => Promise<void>,
	reportFailure: (name: string) => Promise<void>,
	check: (filePath: string) => Promise<unknown> = async (filePath) =>
		vscode.workspace.fs.stat(vscode.Uri.file(filePath)),
): Promise<void> {
	try {
		await check(filePath)
		await show(filePath)
	} catch {
		const basename =
			path.win32.isAbsolute(filePath) && !path.posix.isAbsolute(filePath)
				? path.win32.basename(filePath)
				: path.basename(filePath)
		const name = [...basename].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("")
		await reportFailure(name)
	}
}
