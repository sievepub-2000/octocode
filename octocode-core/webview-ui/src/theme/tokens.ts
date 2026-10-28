import { shape, themes, type Palette, type ThemeId } from "./palettes"

/**
 * Bridges OctoCode's semantic palette onto the CSS custom properties the UI
 * already consumes.
 *
 * The webview's ~110 distinct `--vscode-*` variables are read directly by more
 * than a hundred components. Re-authoring all of them to use new names would be
 * a large, risky, entirely cosmetic diff. Instead the theme layer *owns* those
 * variable names and sets them from our palettes, so OctoCode controls its own
 * appearance while every existing component keeps working untouched.
 *
 * The `--vscode-` prefix is therefore now an internal implementation detail of
 * this file, not a dependency on VS Code's theme service.
 */

/** ANSI colours for terminal output. A VS Code concern, so it lives here. */
interface AnsiColors {
	black: string
	red: string
	green: string
	yellow: string
	blue: string
	magenta: string
	cyan: string
	white: string
	brightBlack: string
	brightRed: string
	brightGreen: string
	brightYellow: string
	brightBlue: string
	brightMagenta: string
	brightCyan: string
	brightWhite: string
}

/**
 * Terminal ANSI for Solarized Light — Solarized's own 16-colour mapping, not a
 * re-derivation of it. The eight accent hues are the normal colours; the bright
 * slots carry orange, violet and the four base tones, which is what makes
 * Solarized-aware programs render as their authors intended.
 */
const solarizedLightAnsi: AnsiColors = {
	black: "#073642",
	red: "#dc322f",
	green: "#859900",
	yellow: "#b58900",
	blue: "#268bd2",
	magenta: "#d33682",
	cyan: "#2aa198",
	white: "#eee8d5",
	brightBlack: "#002b36",
	brightRed: "#cb4b16",
	brightGreen: "#586e75",
	brightYellow: "#657b83",
	brightBlue: "#839496",
	brightMagenta: "#6c71c4",
	brightCyan: "#93a1a1",
	brightWhite: "#fdf6e3",
}

/** Terminal ANSI retains semantic colours on the charcoal ground. */
const midnightPurpleAnsi: AnsiColors = {
	black: "#0e0e10",
	red: "#f0757f",
	green: "#5cc79a",
	yellow: "#e0b354",
	blue: "#7aa7f0",
	magenta: "#c39cf0",
	cyan: "#7fd4c1",
	white: "#e5e5e5",
	brightBlack: "#737373",
	brightRed: "#ff9aa2",
	brightGreen: "#82ddb4",
	brightYellow: "#f0cb7d",
	brightBlue: "#9dc0f7",
	brightMagenta: "#d5b8f7",
	brightCyan: "#a0e5d6",
	brightWhite: "#f3f1f8",
}

const ansiByTheme: Record<ThemeId, AnsiColors> = {
	"solarized-light": solarizedLightAnsi,
	"midnight-purple": midnightPurpleAnsi,
}

/** Blend `overlay` onto `base` at `alpha`, producing an opaque colour. */
function mix(base: string, overlay: string, alpha: number): string {
	const parse = (h: string) => {
		const m = h.replace("#", "")
		return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16))
	}
	const [br, bg, bb] = parse(base)
	const [or_, og, ob] = parse(overlay)
	const to = (b: number, o: number) =>
		Math.round(b + (o - b) * alpha)
			.toString(16)
			.padStart(2, "0")
	return `#${to(br, or_)}${to(bg, og)}${to(bb, ob)}`
}

/**
 * Every CSS custom property the UI reads, derived from one palette.
 *
 * Returned as a plain map so it can be asserted in tests and applied either to
 * `document.documentElement` or serialised into a stylesheet.
 */
export function buildThemeVariables(themeId: ThemeId, p: Palette = themes[themeId].palette): Record<string, string> {
	const { kind } = themes[themeId]
	const textAccent = kind === "dark" ? mix(p.accent, p.fgStrong, 0.45) : p.accent
	const ansi = ansiByTheme[themeId]

	// Hover/selection tints are derived rather than hand-picked so they stay
	// consistent between the two themes and with any future palette.
	const towardFg = (amount: number) => mix(p.bg, p.fg, amount)
	const subtle = towardFg(0.06)
	const subtler = towardFg(0.1)

	const vars: Record<string, string> = {
		// --- base ---
		"--vscode-foreground": p.fg,
		"--vscode-descriptionForeground": p.fgMuted,
		"--vscode-disabledForeground": p.fgMuted,
		"--vscode-errorForeground": p.danger,
		"--vscode-focusBorder": p.accent,
		// The shell's own drag handles read this, so the webview needs it as a
		// variable and not only in the generated editor theme, where it was the
		// single token the UI read that no palette emitted.
		"--vscode-sash-hoverBorder": p.accent,
		"--vscode-widget-border": p.border,
		"--vscode-widget-shadow": kind === "dark" ? "#00000066" : "#0000001f",
		"--vscode-panel-border": p.border,

		// --- editor surface ---
		"--vscode-editor-background": p.bg,
		"--vscode-editor-foreground": p.fg,
		"--vscode-editorGroup-border": p.border,
		"--vscode-editor-inactiveSelectionBackground": subtler,
		"--vscode-editorInlayHint-foreground": p.fgMuted,
		"--vscode-editorError-foreground": p.danger,
		"--vscode-editorWarning-foreground": p.warning,
		"--vscode-editorWarning-background": mix(p.bg, p.warning, 0.12),
		"--vscode-editorHoverWidget-background": p.bgElevated,
		"--vscode-editorHoverWidget-foreground": p.fg,
		"--vscode-editorHoverWidget-border": p.border,

		// --- sidebar / lists ---
		"--vscode-sideBar-background": p.bgElevated,
		"--vscode-sideBar-foreground": p.fg,
		"--vscode-sideBar-border": p.border,
		"--vscode-sideBarSectionHeader-background": p.bgSunken,
		"--vscode-sideBarSectionHeader-foreground": p.fgStrong,
		"--vscode-sideBarSectionHeader-border": p.border,
		"--vscode-list-hoverBackground": subtle,
		"--vscode-list-hoverForeground": p.fgStrong,
		"--vscode-list-focusBackground": subtler,
		"--vscode-list-activeSelectionBackground": mix(p.bg, p.accent, 0.18),
		"--vscode-list-activeSelectionForeground": p.fgStrong,

		// --- buttons ---
		"--vscode-button-background": p.accent,
		"--vscode-button-foreground": p.accentFg,
		"--vscode-button-border": "transparent",
		"--vscode-button-hoverBackground": mix(p.accent, p.fgStrong, 0.15),
		"--vscode-button-secondaryBackground": p.bgSunken,
		"--vscode-button-secondaryForeground": p.fg,
		"--vscode-button-secondaryBorder": p.border,

		// --- inputs / dropdowns ---
		"--vscode-input-background": p.bgElevated,
		"--vscode-input-foreground": p.fg,
		"--vscode-input-border": p.border,
		"--vscode-dropdown-background": p.bgElevated,
		"--vscode-dropdown-foreground": p.fg,
		"--vscode-dropdown-border": p.border,
		"--vscode-inputValidation-infoBackground": mix(p.bg, p.info, 0.14),
		"--vscode-inputValidation-infoForeground": p.fgStrong,
		"--vscode-inputValidation-infoBorder": p.info,
		"--vscode-inputValidation-warningBackground": mix(p.bg, p.warning, 0.14),
		"--vscode-inputValidation-warningForeground": p.fgStrong,
		"--vscode-inputValidation-warningBorder": p.warning,

		// --- menus / notifications / banners ---
		"--vscode-menu-background": p.bgElevated,
		"--vscode-menu-foreground": p.fg,
		"--vscode-menu-border": p.border,
		"--vscode-menu-selectionBackground": mix(p.bg, p.accent, 0.18),
		"--vscode-menu-separatorBackground": p.border,
		"--vscode-notifications-background": p.bgElevated,
		"--vscode-notifications-foreground": p.fg,
		"--vscode-notifications-border": p.border,
		"--vscode-banner-background": p.bgSunken,
		"--vscode-banner-foreground": p.fg,
		"--vscode-badge-background": p.accent,
		"--vscode-badge-foreground": p.accentFg,

		// --- title bar / toolbar / scrollbar ---
		"--vscode-titleBar-activeForeground": p.fgStrong,
		"--vscode-titleBar-inactiveForeground": p.fgMuted,
		"--vscode-toolbar-hoverBackground": subtle,
		"--vscode-toolbar-hoverOutline": p.border,
		"--vscode-scrollbarSlider-background": mix(p.bg, p.fg, 0.18),
		"--vscode-scrollbarSlider-hoverBackground": mix(p.bg, p.fg, 0.28),
		"--vscode-scrollbarSlider-activeBackground": mix(p.bg, p.fg, 0.38),
		"--vscode-progressBar-background": p.accent,

		// --- text / links / code ---
		"--vscode-textLink-foreground": textAccent,
		"--vscode-textLink-activeForeground": mix(textAccent, p.fgStrong, 0.25),
		"--vscode-textCodeBlock-background": p.bgSunken,
		"--vscode-textPreformat-background": p.bgSunken,
		"--vscode-textPreformat-foreground": p.syntax.string,
		"--vscode-textBlockQuote-background": p.bgSunken,
		"--vscode-textBlockQuote-border": p.accent,
		"--vscode-symbolIcon-stringForeground": p.syntax.string,

		// --- diffs / testing ---
		"--vscode-diffEditor-insertedTextBackground": p.diff.addedBg,
		"--vscode-diffEditor-removedTextBackground": p.diff.removedBg,
		"--vscode-testing-iconPassed": p.success,
		"--vscode-testing-iconFailed": p.danger,

		// --- charts ---
		"--vscode-charts-blue": p.info,
		"--vscode-charts-green": p.success,
		"--vscode-charts-yellow": p.warning,
		"--vscode-charts-orange": p.syntax.operator,
		"--vscode-charts-red": p.danger,
		"--vscode-charts-purple": p.syntax.keyword,

		// --- terminal ---
		"--vscode-terminal-background": p.bg,
		"--vscode-terminal-foreground": p.fg,
		"--vscode-terminal-ansiBlack": ansi.black,
		"--vscode-terminal-ansiRed": ansi.red,
		"--vscode-terminal-ansiGreen": ansi.green,
		"--vscode-terminal-ansiYellow": ansi.yellow,
		"--vscode-terminal-ansiBlue": ansi.blue,
		"--vscode-terminal-ansiMagenta": ansi.magenta,
		"--vscode-terminal-ansiCyan": ansi.cyan,
		"--vscode-terminal-ansiWhite": ansi.white,
		"--vscode-terminal-ansiBrightBlack": ansi.brightBlack,
		"--vscode-terminal-ansiBrightRed": ansi.brightRed,
		"--vscode-terminal-ansiBrightGreen": ansi.brightGreen,
		"--vscode-terminal-ansiBrightYellow": ansi.brightYellow,
		"--vscode-terminal-ansiBrightBlue": ansi.brightBlue,
		"--vscode-terminal-ansiBrightMagenta": ansi.brightMagenta,
		"--vscode-terminal-ansiBrightCyan": ansi.brightCyan,
		"--vscode-terminal-ansiBrightWhite": ansi.brightWhite,

		// --- typography (kept as variables because components read them) ---
		"--vscode-font-family":
			'-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
		"--vscode-font-size": "13px",
		"--vscode-editor-font-family": '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
		"--vscode-editor-font-size": "13px",
		"--vscode-editor-line-height": "1.5",
	}

	// Semantic aliases, so new code can stop referring to VS Code names at all.
	for (const [role, value] of Object.entries({
		bg: p.bg,
		"bg-elevated": p.bgElevated,
		"bg-sunken": p.bgSunken,
		border: p.border,
		"border-strong": p.borderStrong,
		fg: p.fg,
		"fg-strong": p.fgStrong,
		"fg-muted": p.fgMuted,
		accent: p.accent,
		"accent-fg": p.accentFg,
		success: p.success,
		warning: p.warning,
		danger: p.danger,
		info: p.info,
	})) {
		vars[`--octo-${role}`] = value
	}

	// Shape language, shared by both themes so surfaces stay consistent.
	for (const [step, value] of Object.entries(shape.radius)) {
		vars[`--octo-radius-${step}`] = value
	}
	for (const [step, value] of Object.entries(shape.space)) {
		vars[`--octo-space-${step}`] = value
	}
	vars["--octo-hairline"] = shape.hairline
	vars["--octo-shadow-card"] = shape.shadow.card
	vars["--octo-shadow-raised"] = shape.shadow.raised

	return vars
}

/** Apply a theme to a root element. Returns the variables that were set. */
export function applyTheme(themeId: ThemeId, root: HTMLElement): Record<string, string> {
	const vars = buildThemeVariables(themeId)
	for (const [name, value] of Object.entries(vars)) {
		root.style.setProperty(name, value)
	}
	root.dataset.octocodeTheme = themeId
	root.dataset.octocodeThemeKind = themes[themeId].kind
	return vars
}

export type { Palette }
