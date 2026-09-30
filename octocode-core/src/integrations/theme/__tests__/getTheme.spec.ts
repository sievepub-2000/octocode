vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: () => "Colors Only" }) },
	extensions: {
		all: [{ extensionPath: "C:/theme", packageJSON: { contributes: { themes: [{ label: "Colors Only", path: "theme.json" }] } } }],
		getExtension: () => ({ extensionUri: { fsPath: "C:/octocode" } }),
	},
}))
vi.mock("fs/promises", () => ({ readFile: vi.fn(async () => JSON.stringify({ colors: { "editor.background": "#fff" } })) }))
const { convertTheme } = vi.hoisted(() => ({
	convertTheme: vi.fn((theme: { colors?: object; tokenColors?: unknown[] }) => ({
		base: "vs-dark",
		colors: theme.colors,
		rules: theme.tokenColors,
	})),
}))
vi.mock("monaco-vscode-textmate-theme-converter/lib/cjs", () => ({ convertTheme }))
vi.mock("../../../shared/package", () => ({ Package: { publisher: "OctoCode", name: "octocode" } }))

import { getTheme } from "../getTheme"

it("supports color-only VS Code themes without logging an error", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {})

	await expect(getTheme()).resolves.toMatchObject({ base: "vs-dark" })
	expect(convertTheme).toHaveBeenCalledOnce()
	expect(convertTheme).toHaveBeenCalledWith({ colors: { "editor.background": "#fff" }, tokenColors: [] })
	expect(log).not.toHaveBeenCalled()
})
