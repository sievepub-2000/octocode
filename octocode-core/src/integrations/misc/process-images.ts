import * as vscode from "vscode"
import fs from "fs/promises"
import * as path from "path"

/**
 * Extensions the model side can actually take as pictures.
 *
 * Kept next to `getMimeType`, which throws on anything else — the two have to
 * agree, or the attach control offers a file it cannot then read.
 */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"])

/** Reads already-chosen images. The picker and the reader are separate so one
 * dialog can hand its images here and its documents somewhere else. */
export async function readImagesAsDataUrls(imagePaths: string[]): Promise<string[]> {
	return await Promise.all(
		imagePaths.map(async (imagePath) => {
			const buffer = await fs.readFile(imagePath)
			return `data:${getMimeType(imagePath)};base64,${buffer.toString("base64")}`
		}),
	)
}

export async function selectImages(): Promise<string[]> {
	const options: vscode.OpenDialogOptions = {
		canSelectMany: true,
		openLabel: "Select",
		filters: {
			Images: ["png", "jpg", "jpeg", "webp"], // supported by anthropic and openrouter
		},
	}

	const fileUris = await vscode.window.showOpenDialog(options)

	if (!fileUris || fileUris.length === 0) {
		return []
	}

	return await Promise.all(
		fileUris.map(async (uri) => {
			const imagePath = uri.fsPath
			const buffer = await fs.readFile(imagePath)
			const base64 = buffer.toString("base64")
			const mimeType = getMimeType(imagePath)
			const dataUrl = `data:${mimeType};base64,${base64}`
			return dataUrl
		}),
	)
}

function getMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase()
	switch (ext) {
		case ".png":
			return "image/png"
		case ".jpeg":
		case ".jpg":
			return "image/jpeg"
		case ".webp":
			return "image/webp"
		default:
			throw new Error(`Unsupported file type: ${ext}`)
	}
}
