/**
 * The two themes OctoCode ships.
 *
 * These are palettes, not a theming mechanism: they define *what* the colours
 * are. `tokens.ts` decides how they reach the DOM. Keeping the two apart means
 * the palette values can be checked against their references without reading any
 * application code.
 *
 * Light is classic Solarized Light — Ethan Schoonover's published values, not an
 * approximation of them. Dark follows the supplied black/charcoal/copper reference.
 * High Contrast Light uses white and neutral grey surfaces.
 *
 * Every surface is opaque. An earlier revision carried a frosted-glass surface
 * for the left rail; it needed the window itself to be translucent to have
 * anything real to blur, which never worked on this platform, and a blur over a
 * flat fill returns the same flat fill.
 */

export interface Palette {
	/** Page background. */
	bg: string
	/** Slightly raised surface: panels, cards, input wells. */
	bgElevated: string
	/** Recessed surface: code blocks, inline fills, the canvas behind cards. */
	bgSunken: string
	/** Hairlines and dividers. */
	border: string
	/** Stronger border for focused/active edges. */
	borderStrong: string

	/** Body text. */
	fg: string
	/** Emphasised text: headings, active items. */
	fgStrong: string
	/** De-emphasised text: hints, timestamps, comments. */
	fgMuted: string

	/** Primary accent: fills, focus rings, selected state. */
	accent: string
	/** Text placed on top of `accent`. */
	accentFg: string

	success: string
	warning: string
	danger: string
	info: string

	/** Syntax colours, used by code blocks and diffs. */
	syntax: {
		keyword: string
		string: string
		number: string
		comment: string
		function: string
		type: string
		variable: string
		operator: string
	}

	/** Diff backgrounds, kept separate so they can be tuned for contrast. */
	diff: {
		addedBg: string
		removedBg: string
		addedFg: string
		removedFg: string
	}
}

/**
 * Classic Solarized Light.
 *
 * The ground, the accents and the syntax colours are Solarized's own values:
 * base3 `#fdf6e3` as the page, base2 `#eee8d5` as the recessed chrome, and the
 * eight accent hues unchanged.
 *
 * The text roles are shifted one step darker than Solarized's own
 * body/emphasis/secondary assignment, and that is deliberate. Solarized pairs
 * base00 `#657b83` with base3 at 4.1:1, which is below WCAG AA; using base01 for
 * body, base02 for emphasis and base00 for muted keeps every role inside the
 * palette while clearing the thresholds measured in __tests__/palettes.spec.ts.
 *
 * Raised surfaces sit on base3 too, not on white. Elevation here is carried by
 * the hairline between panes, which is how Solarized itself separates surfaces;
 * a white card on this ground reads as a hole punched in the theme, which is how
 * the task list and the chat box were reported. base2 is not the alternative
 * either — body text on it measures 4.4:1, just under AA — so it stays the
 * recessed tone for chrome: the icon rail, tab strips and code blocks.
 */
export const solarizedLight: Palette = {
	// base3
	bg: "#fdf6e3",
	bgElevated: "#fdf6e3",
	// base2
	bgSunken: "#eee8d5",
	border: "#ddd6c1",
	borderStrong: "#c5bda6",

	// base01 / base02 / base00
	fg: "#586e75",
	fgStrong: "#073642",
	fgMuted: "#657b83",

	// blue
	accent: "#268bd2",
	accentFg: "#ffffff",

	success: "#859900",
	warning: "#b58900",
	danger: "#dc322f",
	info: "#268bd2",

	/*
	 * Solarized's own syntax assignment: green keywords, cyan strings, magenta
	 * constants, blue functions, yellow types, base1 comments.
	 *
	 * Four of the eight hues are one step deeper than Solarized publishes them.
	 * Solarized tunes its accents for equal perceived lightness, not for contrast
	 * against base3, and green, cyan and yellow land at 2.93–2.98:1 there while
	 * base1 comments land at 2.5:1 — under the 3:1 floor that
	 * __tests__/vscodeTheme.spec.ts measures on every syntax colour. Red, orange,
	 * magenta, violet and blue already clear it and are untouched.
	 */
	syntax: {
		keyword: "#7a8c00",
		string: "#258f88",
		number: "#d33682",
		comment: "#78888a",
		function: "#268bd2",
		type: "#a37c00",
		variable: "#268bd2",
		operator: "#7a8c00",
	},

	diff: {
		addedBg: "#e9edd0",
		removedBg: "#f9e0de",
		addedFg: "#4f5c00",
		removedFg: "#8f201d",
	},
}

/** Keep the saved theme identifier; the current palette is black, charcoal and copper. */
export const midnightPurple: Palette = {
	bg: "#000000",
	bgElevated: "#0e0e10",
	bgSunken: "#0a0a0a",
	border: "#2d2d2d",
	borderStrong: "#626262",

	fg: "#e5e5e5",
	fgStrong: "#ffffff",
	fgMuted: "#a3a3a3",

	accent: "#9b6b50",
	accentFg: "#ffffff",

	success: "#8cb88b",
	warning: "#d8b483",
	danger: "#eb9090",
	info: "#adbdc9",

	syntax: {
		keyword: "#d4d4d4",
		string: "#d7b18e",
		number: "#c5c5c5",
		comment: "#8b8b8b",
		function: "#f5f5f5",
		type: "#c1b4aa",
		variable: "#dadada",
		operator: "#b5b5b5",
	},

	diff: {
		addedBg: "#17251b",
		removedBg: "#301c1c",
		addedFg: "#9adcb4",
		removedFg: "#f2a3ab",
	},
}

/** Original OctoCode Dark colours, retained by High Contrast Dark. */
export const legacyDark: Palette = {
	bg: "#1c1a2b",
	bgElevated: "#272438",
	bgSunken: "#15131f",
	border: "#3a3550",
	borderStrong: "#4e4868",
	fg: "#d6d3e3",
	fgStrong: "#f3f1f8",
	fgMuted: "#9a95b0",
	accent: "#D4554F",
	accentFg: "#ffffff",
	success: "#5cc79a",
	warning: "#e0b354",
	danger: "#f0757f",
	info: "#7aa7f0",
	syntax: {
		keyword: "#c39cf0",
		string: "#e0a878",
		number: "#a8d5a2",
		comment: "#7d7891",
		function: "#e8d29a",
		type: "#7fd4c1",
		variable: "#a8c8f0",
		operator: "#d6d3e3",
	},
	diff: {
		addedBg: "#1e3527",
		removedBg: "#3a1f28",
		addedFg: "#9adcb4",
		removedFg: "#f2a3ab",
	},
}

export const whiteHighContrastLight: Palette = {
	bg: "#ffffff",
	bgElevated: "#ffffff",
	bgSunken: "#f7f7f7",
	border: "#c4c4c4",
	borderStrong: "#8a8a8a",
	fg: "#1f1f1f",
	fgStrong: "#000000",
	fgMuted: "#616161",
	accent: "#242424",
	accentFg: "#ffffff",
	success: "#26734d",
	warning: "#875d14",
	danger: "#b42318",
	info: "#24598a",
	syntax: {
		keyword: "#242424",
		string: "#5b4232",
		number: "#654a36",
		comment: "#626262",
		function: "#1f4b6a",
		type: "#365c46",
		variable: "#343434",
		operator: "#484848",
	},
	diff: {
		addedBg: "#e5f3e9",
		removedBg: "#fce8e6",
		addedFg: "#216339",
		removedFg: "#9b2525",
	},
}

export type ThemeId = "solarized-light" | "midnight-purple"

export const themes: Record<ThemeId, { id: ThemeId; label: string; kind: "light" | "dark"; palette: Palette }> = {
	"solarized-light": { id: "solarized-light", label: "Solarized Light", kind: "light", palette: solarizedLight },
	"midnight-purple": { id: "midnight-purple", label: "Charcoal Dark", kind: "dark", palette: midnightPurple },
}

export const DEFAULT_THEME_BY_KIND: Record<"light" | "dark", ThemeId> = {
	light: "solarized-light",
	dark: "midnight-purple",
}

/**
 * Shape language shared by every surface.
 *
 * Depth is carried by a hairline plus a soft shadow rather than by heavy borders
 * or translucency, so the measured contrast of every text surface stays a fixed
 * number.
 */
export const shape = {
	radius: { sm: "6px", md: "10px", lg: "14px", xl: "18px", pill: "999px" },
	hairline: "1px",
	shadow: {
		card: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)",
		raised: "0 2px 6px rgba(0,0,0,0.08), 0 16px 40px rgba(0,0,0,0.10)",
	},
	space: { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px" },
} as const
