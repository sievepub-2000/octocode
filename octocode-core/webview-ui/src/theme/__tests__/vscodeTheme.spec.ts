import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import {
	buildAllThemePreviews,
	buildAllVsCodeThemes,
	buildHighContrastTheme,
	buildInitialColorsModule,
	buildVsCodeTheme,
} from "../vscodeTheme"
import { themes } from "../palettes"

const here = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.resolve(here, "../../../../../desktop-shell")
const THEMES_DIR = path.join(SHELL, "extensions/octocode-themes/themes")
const MANIFEST = path.join(SHELL, "extensions/octocode-themes/package.json")
const INITIAL_COLORS = path.join(SHELL, "src/vs/workbench/services/themes/common/octocodeInitialColors.ts")
const PREVIEWS = path.join(SHELL, "src/vs/workbench/contrib/welcomeGettingStarted/common/media")
const PICKERS = PREVIEWS

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
	const c = hex.replace("#", "").slice(0, 6)
	const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
	const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(c.slice(i, i + 2), 16) / 255))
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
	return (hi + 0.05) / (lo + 0.05)
}

describe("generated VS Code themes", () => {
	// The point of generating these is that the committed files cannot disagree
	// with the palette. If they can, the palette has stopped being the source of
	// truth and the workbench would show colours nobody chose.
	it("has committed theme files that match the palette", () => {
		const stale: string[] = []
		for (const [filename, theme] of Object.entries(buildAllVsCodeThemes())) {
			const committed = fs.readFileSync(path.join(THEMES_DIR, filename), "utf8").replace(/\r\n/g, "\n")
			if (committed !== `${JSON.stringify(theme, null, "\t")}\n`) stale.push(filename)
		}
		// Re-run: pnpm --filter webview-ui generate:themes
		expect(stale).toEqual([])
	})

	it("has a committed initial-colours module that matches the palette", () => {
		expect(fs.readFileSync(INITIAL_COLORS, "utf8").replace(/\r\n/g, "\n")).toBe(buildInitialColorsModule())
	})

	it("has committed welcome-page previews that match the palette", () => {
		const stale: string[] = []
		for (const [filename, svg] of Object.entries(buildAllThemePreviews())) {
			if (fs.readFileSync(path.join(PREVIEWS, filename), "utf8").replace(/\r\n/g, "\n") !== svg)
				stale.push(filename)
		}
		expect(stale).toEqual([])
	})

	it("shows a different preview for every theme", () => {
		// These previews used to be screenshots of the upstream themes, so they
		// labelled one product with another product's picture. Identical previews
		// would be the same failure in a new form.
		const rendered = Object.values(buildAllThemePreviews())
		expect(new Set(rendered).size).toBe(rendered.length)
	})

	it("references the previews it generates, and no stale ones", () => {
		const generated = Object.keys(buildAllThemePreviews()).sort()
		for (const picker of ["theme_picker.ts", "theme_picker_small.ts"]) {
			const source = fs.readFileSync(path.join(PICKERS, picker), "utf8")
			const referenced = [...source.matchAll(/src="\.\/([^"]+)"/g)].map((m) => m[1]).sort()
			expect(referenced).toEqual(generated)
		}
	})

	it("declares in the manifest exactly the theme files it ships", () => {
		const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
		const declared = manifest.contributes.themes.map((t: { path: string }) => path.basename(t.path)).sort()
		const generated = Object.keys(buildAllVsCodeThemes()).sort()
		expect(declared).toEqual(generated)

		// A theme whose file is present but undeclared never loads; a declared file
		// that is missing makes the whole extension fail to activate.
		const onDisk = fs.readdirSync(THEMES_DIR).sort()
		expect(onDisk).toEqual(generated)
	})

	it("names each theme the same way the manifest does", () => {
		const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
		const byFile = new Map<string, string>(
			manifest.contributes.themes.map((t: { id: string; path: string }) => [path.basename(t.path), t.id]),
		)
		for (const [filename, theme] of Object.entries(buildAllVsCodeThemes())) {
			expect(theme.name).toBe(byFile.get(filename))
		}
	})

	it("produces the internal theme ids the workbench hardcodes", () => {
		// `validateThemeId` in desktop-shell's workbenchThemeService.ts migrates the
		// legacy `workbench.colorTheme: "vs"` form onto full internal ids, which it
		// has to spell out as strings. Those strings are derived from this manifest,
		// so renaming the extension or a theme file there would leave them pointing
		// at nothing — and a theme id that resolves to nothing fails silently.
		const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
		const extensionId = `${manifest.publisher}.${manifest.name}`

		// Mirrors toCSSSelector() in colorThemeData.ts.
		const selectorFor = (themePath: string) =>
			`${extensionId}-${themePath.replace(/^\.\//, "")}`.replace(/[^_a-zA-Z0-9-]/g, "-")

		const byId = new Map<string, string>(
			manifest.contributes.themes.map((t: { id: string; path: string }) => [t.id, selectorFor(t.path)]),
		)

		const shellSource = fs.readFileSync(
			path.join(SHELL, "src/vs/workbench/services/themes/browser/workbenchThemeService.ts"),
			"utf8",
		)
		for (const [uiTheme, themeId] of [
			["vs", "OctoCode Light"],
			["vs-dark", "OctoCode Dark"],
			["hc-black", "OctoCode High Contrast Dark"],
			["hc-light", "OctoCode High Contrast Light"],
		] as const) {
			const selector = byId.get(themeId)
			expect(selector).toBeTruthy()
			// The shell builds these with a template literal around a shared prefix
			// constant, so assert on the tail that actually varies per theme.
			const tail = selector!.replace(/^octocode-octocode-themes/, "")
			expect(shellSource).toContain(
				`case ThemeTypeSelector.${
					{ vs: "VS", "vs-dark": "VS_DARK", "hc-black": "HC_BLACK", "hc-light": "HC_LIGHT" }[uiTheme]
				}: return \`${uiTheme} \${defaultThemeExtensionId}${tail}\`;`,
			)
		}
	})

	it("gives the activity bar the palette's recessed surface, opaquely", () => {
		// The activity bar only appears when the shell is switched off, and it has
		// to read as the same surface the shell's own rail paints. It was once
		// translucent so a backdrop-filter could frost it; that needed a translucent
		// window to have anything real to blur, which never worked here, and a
		// half-alpha fill left over from it would show the editor through the bar.
		for (const [id, filename] of [
			["solarized-light", "octocode-light.json"],
			["midnight-purple", "octocode-dark.json"],
		] as const) {
			const p = themes[id].palette
			const colors = buildAllVsCodeThemes()[filename].colors
			expect(colors["activityBar.background"]).toBe(p.bgSunken)
			expect(colors["activityBar.border"]).toBe(p.border)
		}
	})

	it("emits only well-formed colour values", () => {
		for (const [filename, theme] of Object.entries(buildAllVsCodeThemes())) {
			const bad = Object.entries(theme.colors)
				.filter(([, v]) => !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v))
				.map(([k, v]) => `${filename}:${k}=${v}`)
			expect(bad).toEqual([])
		}
	})

	it("keeps editor text legible in both regular themes", () => {
		for (const id of ["solarized-light", "midnight-purple"] as const) {
			const theme = buildVsCodeTheme(id)
			const ratio = contrast(theme.colors["editor.foreground"], theme.colors["editor.background"])
			expect(ratio).toBeGreaterThanOrEqual(4.5)
		}
	})

	it("keeps every syntax colour readable on the editor background", () => {
		// Syntax colours are the one place a palette usually fails quietly: the body
		// text is checked, the comments and strings are not, and the result is a
		// theme that looks fine in a screenshot and is unusable in a file.
		for (const id of ["solarized-light", "midnight-purple"] as const) {
			const theme = buildVsCodeTheme(id)
			const bg = theme.colors["editor.background"]
			const failures = Object.entries(themes[id].palette.syntax)
				.map(([name, colour]) => [name, contrast(colour, bg)] as const)
				.filter(([, ratio]) => ratio < 3)
				.map(([name, ratio]) => `${id}/${name}=${ratio.toFixed(2)}`)
			expect(failures).toEqual([])
		}
	})

	it("pushes high contrast themes past the regular ones", () => {
		// These are what `window.autoDetectHighContrast` selects. If they were just
		// copies of the regular themes, that accessibility path would be a no-op.
		for (const base of ["light", "dark"] as const) {
			const hc = buildHighContrastTheme(base)
			const regular = buildVsCodeTheme(base === "light" ? "solarized-light" : "midnight-purple")

			const hcRatio = contrast(hc.colors["editor.foreground"], hc.colors["editor.background"])
			const regularRatio = contrast(regular.colors["editor.foreground"], regular.colors["editor.background"])
			expect(hcRatio).toBeGreaterThan(regularRatio)
			expect(hcRatio).toBeGreaterThanOrEqual(7)

			// High contrast is defined by visible edges, not just by ratios.
			expect(hc.colors["contrastBorder"]).toBeTruthy()
			expect(hc.type).toBe("hc")
		}
	})
})
