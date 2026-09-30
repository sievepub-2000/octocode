import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	open: [] as { uri: { toString(): string } }[],
	diagnostics: new Map<string, unknown[]>(),
	listeners: [] as ((event: { uris: { toString(): string }[] }) => void)[],
	opened: [] as string[],
}))

vi.mock("vscode", () => {
	const uri = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` })
	return {
		Uri: { file: uri },
		Position: class {},
		workspace: {
			workspaceFolders: undefined,
			get textDocuments() {
				return state.open
			},
			openTextDocument: vi.fn(async (target: { fsPath: string; toString(): string }) => {
				state.opened.push(target.fsPath)
				// The language server answers shortly after the document opens.
				setTimeout(() => {
					state.diagnostics.set(target.toString(), [
						{
							message: "Type 'string' is not assignable to type 'number'.",
							severity: 0,
							range: { start: { line: 1, character: 4 } },
							source: "ts",
							code: 2322,
						},
					])
					state.listeners.forEach((listener) => listener({ uris: [target] }))
				}, 5)
				return {}
			}),
		},
		languages: {
			getDiagnostics: (target?: { toString(): string }) =>
				target ? (state.diagnostics.get(target.toString()) ?? []) : [],
			onDidChangeDiagnostics: (listener: (event: { uris: { toString(): string }[] }) => void) => {
				state.listeners.push(listener)
				return { dispose: () => state.listeners.splice(state.listeners.indexOf(listener), 1) }
			},
		},
	}
})

import { dispatchCodeIntelligence } from "../codeIntelligence"

describe("code_intelligence diagnostics", () => {
	afterEach(() => {
		state.open = []
		state.diagnostics.clear()
		state.opened = []
	})

	it("opens a file that is not loaded and reports the diagnostics its language server publishes", async () => {
		const result = (await dispatchCodeIntelligence({ action: "diagnostics", path: "C:/work/bad.ts" })) as {
			diagnostics: { message: string; line: number; code: number }[]
		}[]
		expect(state.opened).toEqual(["C:/work/bad.ts"])
		expect(result[0].diagnostics).toEqual([
			expect.objectContaining({ line: 2, code: 2322, message: expect.stringContaining("not assignable") }),
		])
	})

	it("does not reopen a document the editor already has", async () => {
		state.open = [{ uri: { toString: () => "file://C:/work/open.ts" } }]
		await dispatchCodeIntelligence({ action: "diagnostics", path: "C:/work/open.ts" })
		expect(state.opened).toEqual([])
	})
})
