import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useOctoCodeTheme } from "../useOctoCodeTheme"

afterEach(() => {
	cleanup()
	document.documentElement.removeAttribute("style")
	delete document.body.dataset.vscodeThemeKind
})

it("restores the legacy purple palette only for high contrast dark", async () => {
	document.body.dataset.vscodeThemeKind = "vscode-high-contrast"
	document.documentElement.style.setProperty("--vscode-editor-background", "#1c1a2b")
	renderHook(useOctoCodeTheme)
	expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#1c1a2b")
	expect(document.documentElement.style.getPropertyValue("--octo-accent")).toBe("#D4554F")
	act(() => {
		document.body.dataset.vscodeThemeKind = "vscode-dark"
		document.documentElement.style.setProperty("--vscode-editor-background", "#000000")
	})
	await waitFor(() => expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#000000"))
	expect(document.documentElement.style.getPropertyValue("--octo-accent")).toBe("#9b6b50")
	act(() => {
		document.body.dataset.vscodeThemeKind = "vscode-high-contrast"
	})
	await waitFor(() => expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#1c1a2b"))
})

it("uses warm semantic surfaces in high contrast light without replacing host colours", () => {
	document.body.dataset.vscodeThemeKind = "vscode-high-contrast-light"
	document.documentElement.style.setProperty("--vscode-editor-background", "#ffffff")
	renderHook(useOctoCodeTheme)
	expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#fdf6e3")
	expect(document.documentElement.style.getPropertyValue("--octo-bg-elevated")).toBe("#fdf6e3")
	expect(document.documentElement.style.getPropertyValue("--vscode-editor-background")).toBe("#ffffff")
})

it("preserves host-derived colours while applying the legacy high contrast palette", () => {
	document.body.dataset.vscodeThemeKind = "vscode-high-contrast"
	document.documentElement.style.setProperty("--vscode-editor-background", "#1c1a2b")
	const host = {
		"--vscode-textBlockQuote-border": "#4e4868",
		"--vscode-scrollbarSlider-background": "#9a95b066",
		"--vscode-editor-inactiveSelectionBackground": "#D4554F29",
	}
	for (const [name, value] of Object.entries(host)) document.documentElement.style.setProperty(name, value)
	renderHook(useOctoCodeTheme)
	for (const [name, value] of Object.entries(host)) {
		expect(document.documentElement.style.getPropertyValue(name)).toBe(value)
	}
	expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#1c1a2b")
})

it("updates semantic surfaces when switching between the two light themes", async () => {
	document.body.dataset.vscodeThemeKind = "vscode-light"
	document.documentElement.style.setProperty("--vscode-editor-background", "#fdf6e3")
	renderHook(useOctoCodeTheme)
	expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#ffffff")
	act(() => {
		document.body.dataset.vscodeThemeKind = "vscode-high-contrast-light"
	})
	await waitFor(() => expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#fdf6e3"))
	act(() => {
		document.body.dataset.vscodeThemeKind = "vscode-light"
	})
	await waitFor(() => expect(document.documentElement.style.getPropertyValue("--octo-bg")).toBe("#ffffff"))
})
