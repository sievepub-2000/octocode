import { legacyDark, themes, whiteHighContrastLight, type Palette, type ThemeId } from "./palettes"

/**
 * Generates VS Code colour themes from the same palette the webview uses.
 *
 * The product has two halves that must look like one thing: the workbench chrome
 * (activity bar, tabs, editor, status bar), themed by a VS Code colour theme, and
 * the agent UI, themed by `tokens.ts`. Before this existed only the second half
 * was ours — the workbench was still running a stock built-in theme, so changing
 * the palette visibly changed only part of the window.
 *
 * Emitting both from one palette removes that split. Nothing is mirrored by hand:
 * `__tests__/vscodeTheme.spec.ts` regenerates and compares against the committed
 * files, so the two can never drift.
 */

export type UiTheme = "vs" | "vs-dark" | "hc-black" | "hc-light"

export interface VsCodeTheme {
	name: string
	type: "light" | "dark" | "hc"
	semanticHighlighting: boolean
	colors: Record<string, string>
	tokenColors: Array<{ name?: string; scope: string | string[]; settings: Record<string, string> }>
}

/** Blend `overlay` onto `base` at `alpha`, producing an opaque colour. */
function mix(base: string, overlay: string, alpha: number): string {
	const parse = (h: string) => {
		const m = h.replace("#", "")
		return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16))
	}
	const [br, bgc, bb] = parse(base)
	const [or_, og, ob] = parse(overlay)
	const to = (b: number, o: number) =>
		Math.round(b + (o - b) * alpha)
			.toString(16)
			.padStart(2, "0")
	return `#${to(br, or_)}${to(bgc, og)}${to(bb, ob)}`
}

/** Append an 8-bit alpha to a hex colour. */
function alpha(hex: string, a: number): string {
	return `${hex}${Math.round(a * 255)
		.toString(16)
		.padStart(2, "0")}`
}

function buildColors(p: Palette, kind: "light" | "dark"): Record<string, string> {
	const toward = (amount: number) => mix(p.bg, p.fg, amount)
	const hover = toward(0.06)
	const active = toward(0.1)
	const shadow = kind === "dark" ? "#00000066" : "#0000001f"
	const textAccent = kind === "dark" ? mix(p.accent, p.fgStrong, 0.45) : p.accent

	return {
		// --- base ---
		foreground: p.fg,
		descriptionForeground: p.fgMuted,
		disabledForeground: p.fgMuted,
		errorForeground: p.danger,
		focusBorder: p.accent,
		"widget.border": p.border,
		"widget.shadow": shadow,
		"selection.background": alpha(p.accent, 0.35),
		"icon.foreground": p.fg,
		"sash.hoverBorder": p.accent,

		// --- window chrome ---
		"titleBar.activeBackground": p.bg,
		"titleBar.activeForeground": p.fgStrong,
		"titleBar.inactiveBackground": p.bg,
		"titleBar.inactiveForeground": p.fgMuted,
		"titleBar.border": p.border,
		"menubar.selectionBackground": hover,
		"menu.background": p.bgElevated,
		"menu.foreground": p.fg,
		"menu.border": p.border,
		"menu.selectionBackground": mix(p.bg, p.accent, 0.18),
		"menu.separatorBackground": p.border,

		/*
		 * The activity bar reads as recessed chrome, the same surface the shell's
		 * own rail paints. It is only visible when the shell is turned off, but it
		 * has to agree with the rail when it is.
		 */
		"activityBar.background": p.bgSunken,
		"activityBar.foreground": p.fgStrong,
		"activityBar.inactiveForeground": p.fgMuted,
		"activityBar.border": p.border,
		"activityBar.activeBorder": p.accent,
		"activityBar.activeBackground": "#00000000",
		"activityBarBadge.background": p.accent,
		"activityBarBadge.foreground": p.accentFg,

		// --- sidebar ---
		"sideBar.background": p.bgElevated,
		"sideBar.foreground": p.fg,
		"sideBar.border": p.border,
		"sideBarTitle.foreground": p.fgStrong,
		"sideBarSectionHeader.background": p.bgSunken,
		"sideBarSectionHeader.foreground": p.fgStrong,
		"sideBarSectionHeader.border": p.border,

		// --- editor ---
		"editor.background": p.bg,
		"editor.foreground": p.fg,
		"editorLineNumber.foreground": p.fgMuted,
		"editorLineNumber.activeForeground": p.fgStrong,
		"editorCursor.foreground": p.accent,
		"editor.selectionBackground": alpha(p.accent, 0.3),
		"editor.inactiveSelectionBackground": alpha(p.accent, 0.16),
		"editor.lineHighlightBackground": hover,
		"editorWhitespace.foreground": mix(p.bg, p.fg, 0.2),
		"editorIndentGuide.background1": p.border,
		"editorIndentGuide.activeBackground1": p.borderStrong,
		"editorGroup.border": p.border,
		"editorGroupHeader.tabsBackground": p.bgSunken,
		"editorGroupHeader.tabsBorder": p.border,
		"editorWidget.background": p.bgElevated,
		"editorWidget.border": p.border,
		"editorHoverWidget.background": p.bgElevated,
		"editorHoverWidget.border": p.border,
		"editorSuggestWidget.background": p.bgElevated,
		"editorSuggestWidget.border": p.border,
		"editorSuggestWidget.selectedBackground": mix(p.bg, p.accent, 0.18),
		"editorError.foreground": p.danger,
		"editorWarning.foreground": p.warning,
		"editorInfo.foreground": p.info,
		"editorBracketMatch.background": alpha(p.accent, 0.2),
		"editorBracketMatch.border": p.accent,

		// --- tabs ---
		"tab.activeBackground": p.bg,
		"tab.activeForeground": p.fgStrong,
		"tab.inactiveBackground": p.bgSunken,
		"tab.inactiveForeground": p.fgMuted,
		"tab.border": p.border,
		"tab.activeBorderTop": p.accent,
		"tab.hoverBackground": hover,

		// --- lists ---
		"list.hoverBackground": hover,
		"list.hoverForeground": p.fgStrong,
		"list.focusBackground": active,
		"list.activeSelectionBackground": mix(p.bg, p.accent, 0.18),
		"list.activeSelectionForeground": p.fgStrong,
		"list.inactiveSelectionBackground": active,
		"list.highlightForeground": textAccent,
		"list.errorForeground": p.danger,
		"list.warningForeground": p.warning,

		// --- inputs / buttons / dropdowns ---
		"input.background": p.bgElevated,
		"input.foreground": p.fg,
		"input.border": p.border,
		"input.placeholderForeground": p.fgMuted,
		"inputOption.activeBorder": p.accent,
		"inputValidation.errorBackground": mix(p.bg, p.danger, 0.14),
		"inputValidation.errorBorder": p.danger,
		"inputValidation.warningBackground": mix(p.bg, p.warning, 0.14),
		"inputValidation.warningBorder": p.warning,
		"inputValidation.infoBackground": mix(p.bg, p.info, 0.14),
		"inputValidation.infoBorder": p.info,
		"button.background": p.accent,
		"button.foreground": p.accentFg,
		"button.hoverBackground": mix(p.accent, p.fgStrong, 0.15),
		"button.secondaryBackground": p.bgSunken,
		"button.secondaryForeground": p.fg,
		"dropdown.background": p.bgElevated,
		"dropdown.foreground": p.fg,
		"dropdown.border": p.border,
		"checkbox.background": p.bgElevated,
		"checkbox.border": p.borderStrong,

		// --- badges / progress / scrollbar ---
		"badge.background": p.accent,
		"badge.foreground": p.accentFg,
		"progressBar.background": p.accent,
		"scrollbarSlider.background": alpha(p.fgMuted, 0.3),
		"scrollbarSlider.hoverBackground": alpha(p.fgMuted, 0.45),
		"scrollbarSlider.activeBackground": alpha(p.fgMuted, 0.6),

		// --- panel / terminal / status ---
		"panel.background": p.bg,
		"panel.border": p.border,
		"panelTitle.activeForeground": p.fgStrong,
		"panelTitle.inactiveForeground": p.fgMuted,
		"panelTitle.activeBorder": p.accent,
		"statusBar.background": p.bgSunken,
		"statusBar.foreground": p.fg,
		"statusBar.border": p.border,
		"statusBar.noFolderBackground": p.bgSunken,
		"statusBarItem.hoverBackground": hover,
		"statusBarItem.remoteBackground": p.accent,
		"statusBarItem.remoteForeground": p.accentFg,
		"terminal.background": p.bg,
		"terminal.foreground": p.fg,
		"terminalCursor.foreground": p.accent,

		// --- notifications / banner / quick input ---
		"notifications.background": p.bgElevated,
		"notifications.foreground": p.fg,
		"notifications.border": p.border,
		"notificationCenterHeader.background": p.bgSunken,
		"banner.background": p.bgSunken,
		"banner.foreground": p.fg,
		"quickInput.background": p.bgElevated,
		"quickInput.foreground": p.fg,
		"quickInputList.focusBackground": mix(p.bg, p.accent, 0.18),
		"pickerGroup.foreground": p.fgMuted,
		"pickerGroup.border": p.border,

		// --- diffs / git ---
		"diffEditor.insertedTextBackground": alpha(p.diff.addedFg, 0.18),
		"diffEditor.removedTextBackground": alpha(p.diff.removedFg, 0.18),
		"gitDecoration.addedResourceForeground": p.success,
		"gitDecoration.modifiedResourceForeground": p.warning,
		"gitDecoration.deletedResourceForeground": p.danger,
		"gitDecoration.untrackedResourceForeground": p.info,
		"gitDecoration.ignoredResourceForeground": p.fgMuted,

		// --- links / text ---
		"textLink.foreground": textAccent,
		"textLink.activeForeground": mix(textAccent, p.fgStrong, 0.25),
		"textPreformat.foreground": p.syntax.string,
		"textBlockQuote.background": p.bgSunken,
		"textBlockQuote.border": p.borderStrong,
		"textCodeBlock.background": p.bgSunken,
	}
}

function buildTokenColors(p: Palette): VsCodeTheme["tokenColors"] {
	const s = p.syntax
	return [
		{
			name: "Comment",
			scope: ["comment", "punctuation.definition.comment"],
			settings: { foreground: s.comment, fontStyle: "italic" },
		},
		{
			name: "String",
			scope: ["string", "string.quoted", "punctuation.definition.string"],
			settings: { foreground: s.string },
		},
		{
			name: "Number / Constant",
			scope: ["constant.numeric", "constant.language", "constant.character"],
			settings: { foreground: s.number },
		},
		{
			name: "Keyword",
			scope: ["keyword", "storage", "storage.type", "keyword.control"],
			settings: { foreground: s.keyword },
		},
		{
			name: "Operator",
			scope: ["keyword.operator", "punctuation.separator", "punctuation.terminator"],
			settings: { foreground: s.operator },
		},
		{
			name: "Function",
			scope: ["entity.name.function", "support.function", "meta.function-call"],
			settings: { foreground: s.function },
		},
		{
			name: "Type / Class",
			scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
			settings: { foreground: s.type },
		},
		{
			name: "Variable",
			scope: ["variable", "meta.definition.variable.name", "support.variable"],
			settings: { foreground: s.variable },
		},
		{ name: "Tag", scope: ["entity.name.tag"], settings: { foreground: s.keyword } },
		{ name: "Attribute", scope: ["entity.other.attribute-name"], settings: { foreground: s.type } },
		{ name: "Invalid", scope: ["invalid", "invalid.illegal"], settings: { foreground: p.danger } },
	]
}

/**
 * Build the VS Code theme for one of OctoCode's palettes.
 *
 * The name is derived from `kind`, not from the palette's own label, so it
 * matches the `id` in the extension manifest. VS Code shows the manifest label
 * in the picker and this name in a few diagnostics; two spellings of one theme
 * is a needless way to make a report unreadable.
 */
export function buildVsCodeTheme(themeId: ThemeId): VsCodeTheme {
	const { palette, kind } = themes[themeId]
	return {
		name: `OctoCode ${kind === "light" ? "Light" : "Dark"}`,
		type: kind,
		semanticHighlighting: true,
		colors: buildColors(palette, kind),
		tokenColors: buildTokenColors(palette),
	}
}

/**
 * High-contrast variants.
 *
 * VS Code switches to these automatically when the OS reports high-contrast mode
 * (`window.autoDetectHighContrast`), so removing the stock high-contrast themes
 * without providing replacements would leave that path with no theme at all.
 * They keep the palette's hues but push grounds to the extremes and add the
 * visible borders high-contrast users rely on.
 */
export function buildHighContrastTheme(base: "dark" | "light"): VsCodeTheme {
	const p = base === "dark" ? legacyDark : whiteHighContrastLight
	const ground = base === "dark" ? "#000000" : "#ffffff"
	const ink = base === "dark" ? "#ffffff" : "#000000"

	const colors = buildColors(p, base)
	const overrides: Record<string, string> =
		base === "dark"
			? {
					contrastBorder: ink,
					contrastActiveBorder: p.accent,
					"widget.border": ink,
					focusBorder: p.accent,
				}
			: {
					foreground: ink,
					"editor.background": ground,
					"editor.foreground": ink,
					"sideBar.background": ground,
					"sideBar.foreground": ink,
					"panel.background": ground,
					"terminal.background": ground,
					"terminal.foreground": ink,
					"statusBar.background": ground,
					"statusBar.foreground": ink,
					"titleBar.activeBackground": ground,
					"titleBar.activeForeground": ink,
					"tab.activeBackground": ground,
					"tab.activeForeground": ink,
					"tab.inactiveBackground": ground,
					"input.background": ground,
					"input.foreground": ink,
					"dropdown.background": ground,
					"dropdown.foreground": ink,
					"quickInput.background": ground,
					"quickInput.foreground": ink,
					// High contrast is defined by visible edges, so every border is drawn.
					contrastBorder: ink,
					contrastActiveBorder: p.accent,
					"widget.border": ink,
					focusBorder: p.accent,
				}

	return {
		name: `OctoCode High Contrast ${base === "dark" ? "Dark" : "Light"}`,
		type: "hc",
		semanticHighlighting: true,
		colors: { ...colors, ...overrides },
		tokenColors: buildTokenColors(p),
	}
}

/**
 * Source for the workbench's pre-theme paint.
 *
 * The workbench paints the window from a hardcoded colour map before the theme
 * extension has loaded, purely to avoid a flash. Upstream that map is VS Code
 * blue, which in this product would flash blue and then resolve to the OctoCode
 * palette on every cold start. Deriving it from the same palette removes the
 * flash rather than shortening it.
 */
export function buildInitialColorsModule(): string {
	const emit = (name: string, colors: Record<string, string>) => {
		const body = Object.entries(colors)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `\t'${k}': '${v}',`)
			.join("\n")
		return `export const ${name} = {\n${body}\n};`
	}

	return [
		"/*---------------------------------------------------------------------------------------------",
		" *  Copyright (c) Microsoft Corporation. All rights reserved.",
		" *  Licensed under the MIT License. See License.txt in the project root for license information.",
		" *--------------------------------------------------------------------------------------------*/",
		"",
		"// GENERATED FILE - DO NOT EDIT.",
		"// Produced by octocode-core/webview-ui/scripts/generate-vscode-themes.ts from the",
		"// product palette. Re-run that script after changing the palette; the drift test in",
		"// webview-ui/src/theme/__tests__/vscodeTheme.spec.ts fails if this file is stale.",
		"//",
		"// These colours paint the workbench before the theme extension loads, so they exist",
		"// only to keep a cold start from flashing a different palette than the one that",
		"// resolves a moment later.",
		"",
		emit("COLOR_THEME_DARK_INITIAL_COLORS", buildColors(themes["midnight-purple"].palette, "dark")),
		"",
		emit("COLOR_THEME_LIGHT_INITIAL_COLORS", buildColors(themes["solarized-light"].palette, "light")),
		"",
		emit("COLOR_THEME_HC_DARK_INITIAL_COLORS", buildHighContrastTheme("dark").colors),
		"",
		emit("COLOR_THEME_HC_LIGHT_INITIAL_COLORS", buildHighContrastTheme("light").colors),
		"",
	].join("\n")
}

/**
 * Miniature of the workbench, used as the theme preview on the welcome page.
 *
 * The previews that shipped here were screenshots of the upstream themes, so
 * after the swap they showed one product under another product's name. Drawing
 * them from the palette means they cannot misrepresent the theme they label.
 */
export function buildThemePreviewSvg(theme: VsCodeTheme): string {
	const c = theme.colors
	const s = (key: string) => c[key]
	// The themes leave the activity bar transparent so the frosted pane can show
	// through. A flat preview has no frost, so it stands in with the same sunken
	// surface the real bar is layered over.
	const activityBar = s("statusBar.background")

	const codeLines = [
		{ x: 74, w: 26, fill: s("editorLineNumber.foreground") },
		{ x: 104, w: 40, fill: theme.tokenColors.find((t) => t.name === "Keyword")!.settings.foreground },
		{ x: 148, w: 34, fill: theme.tokenColors.find((t) => t.name === "Function")!.settings.foreground },
	]

	const rows = [0, 1, 2, 3, 4].map((i) => {
		const y = 40 + i * 13
		const cells = codeLines.map((l, j) => {
			const w = Math.max(10, l.w - i * 4 - j * 2)
			return `<rect x="${l.x}" y="${y}" width="${w}" height="5" rx="2.5" fill="${l.fill}" opacity="${
				i === 0 ? 0.95 : 0.75
			}"/>`
		})
		return cells.join("")
	})

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 124" width="200" height="124" role="img">`,
		`<rect width="200" height="124" rx="6" fill="${s("editor.background")}"/>`,
		// title bar
		`<rect width="200" height="14" rx="6" fill="${s("titleBar.activeBackground")}"/>`,
		`<rect y="8" width="200" height="6" fill="${s("titleBar.activeBackground")}"/>`,
		`<rect x="0" y="13.5" width="200" height="0.5" fill="${s("titleBar.border")}"/>`,
		// activity bar
		`<rect x="0" y="14" width="16" height="96" fill="${activityBar}"/>`,
		...[22, 38, 54].map(
			(y, i) =>
				`<rect x="4" y="${y}" width="8" height="8" rx="2" fill="${
					i === 0 ? s("activityBar.foreground") : s("activityBar.inactiveForeground")
				}"/>`,
		),
		`<rect x="0" y="20" width="1.5" height="12" fill="${s("activityBar.activeBorder")}"/>`,
		// side bar
		`<rect x="16" y="14" width="48" height="96" fill="${s("sideBar.background")}"/>`,
		...[24, 36, 48, 60, 72].map(
			(y, i) =>
				`<rect x="22" y="${y}" width="${34 - i * 3}" height="4" rx="2" fill="${
					i === 1 ? s("list.activeSelectionForeground") : s("sideBar.foreground")
				}" opacity="${i === 1 ? 0.9 : 0.45}"/>`,
		),
		// tab strip
		`<rect x="64" y="14" width="136" height="12" fill="${s("editorGroupHeader.tabsBackground")}"/>`,
		`<rect x="64" y="14" width="40" height="12" fill="${s("tab.activeBackground")}"/>`,
		`<rect x="64" y="14" width="40" height="1.5" fill="${s("tab.activeBorderTop")}"/>`,
		// code
		...rows,
		// accent button, so the accent is visible in the preview
		`<rect x="150" y="92" width="40" height="12" rx="4" fill="${s("button.background")}"/>`,
		// status bar
		`<rect x="0" y="110" width="200" height="14" fill="${s("statusBar.background")}"/>`,
		`<rect x="6" y="115" width="24" height="4" rx="2" fill="${s("statusBar.foreground")}" opacity="0.6"/>`,
		`<rect x="170" y="115" width="24" height="4" rx="2" fill="${s("statusBar.foreground")}" opacity="0.6"/>`,
		`</svg>`,
		"",
	].join("\n")
}

/** Theme previews for the welcome page, keyed by filename. */
export function buildAllThemePreviews(): Record<string, string> {
	const themesByFile = buildAllVsCodeThemes()
	return {
		"light.svg": buildThemePreviewSvg(themesByFile["octocode-light.json"]),
		"dark.svg": buildThemePreviewSvg(themesByFile["octocode-dark.json"]),
		"light-hc.svg": buildThemePreviewSvg(themesByFile["octocode-hc-light.json"]),
		"dark-hc.svg": buildThemePreviewSvg(themesByFile["octocode-hc-dark.json"]),
	}
}

/** Every theme file the shipped extension contains, keyed by filename. */
export function buildAllVsCodeThemes(): Record<string, VsCodeTheme> {
	return {
		"octocode-light.json": buildVsCodeTheme("solarized-light"),
		"octocode-dark.json": buildVsCodeTheme("midnight-purple"),
		"octocode-hc-light.json": buildHighContrastTheme("light"),
		"octocode-hc-dark.json": buildHighContrastTheme("dark"),
	}
}
