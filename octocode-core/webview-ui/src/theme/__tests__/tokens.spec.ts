import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { buildThemeVariables, applyTheme } from "../tokens"
import { themes, type ThemeId } from "../palettes"

const THEME_IDS = Object.keys(themes) as ThemeId[]

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

/** Every `--vscode-*` custom property the UI source actually reads. */
function collectUsedTokens(): Set<string> {
	const used = new Set<string>()
	const skip = new Set(["node_modules", "build", "dist", "__tests__", ".turbo"])

	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || skip.has(entry.name)) continue
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
				continue
			}
			if (!/\.(tsx?|css)$/.test(entry.name)) continue
			const text = fs.readFileSync(full, "utf8")
			// `-` sits last in each class, where it is a literal and needs no escape.
			for (const m of text.matchAll(/--vscode-[a-zA-Z0-9.-]+/g)) {
				// Trailing dots/dashes come from CSS syntax around the name.
				used.add(m[0].replace(/[.-]+$/, ""))
			}
		}
	}

	walk(srcDir)
	return used
}

describe("theme token bridge", () => {
	it.each(THEME_IDS)("%s defines every token the UI reads", (themeId) => {
		// A token a component reads but the theme never sets resolves to nothing,
		// which paints transparent or black instead of failing — invisible in tests
		// and obvious to the user. So this must be exhaustive, not approximate.
		const emitted = new Set(Object.keys(buildThemeVariables(themeId)))
		const missing = [...collectUsedTokens()].filter((t) => !emitted.has(t)).sort()

		// The array itself names the missing tokens on failure, so no message arg is
		// needed (this project's `expect` typing takes only one argument).
		expect(missing).toEqual([])
	})

	it.each(THEME_IDS)("%s produces valid CSS values for every variable", (themeId) => {
		const entries = Object.entries(buildThemeVariables(themeId))

		const empty = entries.filter(([, value]) => !value).map(([name]) => name)
		expect(empty).toEqual([])

		const badHex = entries
			.filter(([, value]) => /^#/.test(value) && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
			.map(([name, value]) => `${name}=${value}`)
		expect(badHex).toEqual([])
	})

	it("gives the two themes genuinely different surfaces", () => {
		const light = buildThemeVariables("solarized-light")
		const dark = buildThemeVariables("midnight-purple")
		expect(light["--vscode-editor-background"]).not.toBe(dark["--vscode-editor-background"])
		expect(light["--vscode-foreground"]).not.toBe(dark["--vscode-foreground"])
	})

	it("exposes semantic aliases so new code need not use VS Code names", () => {
		const vars = buildThemeVariables("midnight-purple")
		expect(vars["--octo-bg"]).toBe(themes["midnight-purple"].palette.bg)
		expect(vars["--octo-accent"]).toBe(themes["midnight-purple"].palette.accent)
		expect(vars["--octo-fg-muted"]).toBe(themes["midnight-purple"].palette.fgMuted)
	})

	it("derives hover tints from the palette rather than hardcoding grey", () => {
		// Hardcoded greys are the usual reason a theme looks fine in dark and muddy
		// in light; derived tints track whatever palette is active.
		const light = buildThemeVariables("solarized-light")
		const dark = buildThemeVariables("midnight-purple")
		expect(light["--vscode-list-hoverBackground"]).not.toBe(dark["--vscode-list-hoverBackground"])
	})

	it("applies variables and stamps the theme onto the root element", () => {
		const root = document.createElement("div")
		const vars = applyTheme("solarized-light", root)

		expect(root.dataset.octocodeTheme).toBe("solarized-light")
		expect(root.dataset.octocodeThemeKind).toBe("light")
		expect(root.style.getPropertyValue("--vscode-editor-background")).toBe(vars["--vscode-editor-background"])
		// Read from the palette rather than repeating the literal, so a deliberate
		// palette change does not look like a bug in the bridge.
		expect(root.style.getPropertyValue("--octo-accent")).toBe(themes["solarized-light"].palette.accent)
	})

	it("sets terminal ANSI colours so terminal output is not unstyled", () => {
		for (const themeId of THEME_IDS) {
			const vars = buildThemeVariables(themeId)
			for (const name of ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"]) {
				expect(vars[`--vscode-terminal-ansi${name}`]).toBeTruthy()
				expect(vars[`--vscode-terminal-ansiBright${name}`]).toBeTruthy()
			}
		}
	})
})
