import * as fsPromises from "fs/promises"
import * as path from "path"

import { describe, expect, it, vi } from "vitest"

import { ARTIFACT_VIEW_COLUMN, CHAT_VIEW_COLUMN, EXECUTION_VIEW_COLUMN, artifactShowOptions } from "../artifactSlot"

vi.mock("vscode", () => ({
	ViewColumn: { One: 1, Two: 2, Three: 3, Active: -1 },
	window: { showTextDocument: vi.fn() },
	commands: { executeCommand: vi.fn() },
}))

const SOURCE_ROOT = path.resolve(__dirname, "..", "..", "..")

/**
 * Call sites that open a visual surface. Each must route through the artifact
 * slot helpers, or name a column explicitly, so nothing lands in the group that
 * happens to be focused.
 */
const SURFACE_CALLS = [
	"vscode.window.showTextDocument(",
	'executeCommand("vscode.open"',
	'executeCommand("markdown.showPreview"',
]

const SLOT_AWARE = [
	"artifactShowOptions",
	"showTextDocumentInArtifactSlot",
	"openResourceInArtifactSlot",
	"focusArtifactSlot",
	"viewColumn:",
	"ARTIFACT_VIEW_COLUMN",
]

/**
 * Files that legitimately open a surface without the slot helpers.
 * `artifactSlot.ts` is the helper itself; the diff provider restores the user's
 * own editor to the column it came from.
 */
const ALLOWED = new Set([path.join("integrations", "misc", "artifactSlot.ts")])

function isComment(line: string): boolean {
	const trimmed = line.trim()
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

async function collectSourceFiles(directory: string): Promise<string[]> {
	const entries = await fsPromises.readdir(directory, { withFileTypes: true })
	const files = await Promise.all(
		entries.map(async (entry) => {
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				if (["node_modules", "dist", "build", "__tests__", "__mocks__", "webview-ui"].includes(entry.name)) {
					return []
				}
				return collectSourceFiles(full)
			}
			return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts") ? [full] : []
		}),
	)
	return files.flat()
}

describe("artifact slot", () => {
	it("gives each surface its own editor group", async () => {
		// The constants are literals so importing this module never depends on a
		// `vscode` stub; this keeps them in step with the real enum.
		const vscode = await import("vscode")
		expect(CHAT_VIEW_COLUMN).toBe(vscode.ViewColumn.One)
		expect(ARTIFACT_VIEW_COLUMN).toBe(vscode.ViewColumn.Two)
		expect(EXECUTION_VIEW_COLUMN).toBe(vscode.ViewColumn.Three)
	})

	it("pins options to the multimodal slot even when a caller passes its own", () => {
		const options = artifactShowOptions({ preview: true } as never)
		expect(options.viewColumn).toBe(ARTIFACT_VIEW_COLUMN)
		expect(options.preview).toBe(true)
	})

	it("preserves focus by default so opening a surface does not steal the prompt", () => {
		expect(artifactShowOptions().preserveFocus).toBe(true)
		expect(artifactShowOptions({ preserveFocus: false }).preserveFocus).toBe(false)
	})

	// This one reads every source file in the extension, so it is a repo-wide
	// scan rather than a unit test; the suite-wide 20s deadline is not a budget
	// it can meet on a machine that is also building.
	it("never lets a visual surface open in whichever group is focused", async () => {
		const files = await collectSourceFiles(SOURCE_ROOT)
		const offenders: string[] = []

		for (const file of files) {
			const relative = path.relative(SOURCE_ROOT, file)
			if (ALLOWED.has(relative)) continue
			const source = await fsPromises.readFile(file, "utf8")
			const lines = source.split("\n")

			lines.forEach((line, index) => {
				// Prose that names the old behaviour is documentation, not a call.
				if (isComment(line)) return
				if (line.includes("ViewColumn.Active")) {
					offenders.push(`${relative}:${index + 1} targets the focused group`)
				}
				if (!SURFACE_CALLS.some((call) => line.includes(call))) return
				// The routing decision may sit just above the call (a focus switch)
				// or below it (an options object spanning several lines).
				const window = lines
					.slice(Math.max(index - 3, 0), index + 6)
					.filter((candidate) => !isComment(candidate))
					.join("\n")
				if (SLOT_AWARE.some((marker) => window.includes(marker))) return
				offenders.push(`${relative}:${index + 1} opens a surface without naming a group`)
			})
		}

		expect(offenders).toEqual([])
	}, 120_000)
})
