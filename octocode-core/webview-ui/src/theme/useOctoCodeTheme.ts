import { useEffect } from "react"

import { DEFAULT_THEME_BY_KIND, legacyDark, solarizedLight } from "./palettes"
import { buildThemeVariables } from "./tokens"

/**
 * Puts the OctoCode palette on the document.
 *
 * The palette generates two things: the colour theme the workbench loads, and
 * the `--octo-*` custom properties this UI reads. Only the first half was wired
 * up — `applyTheme` existed and was unit-tested, but nothing ever called it, so
 * every `var(--octo-…)` in the stylesheets resolved to nothing, and the shell's
 * own surfaces fell through to their fallbacks.
 *
 * The host tells the webview which side of light/dark it is on by putting
 * `vscode-light` / `vscode-dark` / `vscode-high-contrast` on <body>, so that is
 * what selects the palette. Following it keeps this UI in step when the user
 * switches themes without a reload.
 */
export function useOctoCodeTheme(): void {
	useEffect(() => {
		const root = document.documentElement

		/**
		 * Light or dark, decided from the colour the host actually injected.
		 *
		 * The obvious signal is the `vscode-light` / `vscode-dark` class the host
		 * puts on `<body>` — but that is set on the webview's OUTER frame, and this
		 * app runs in the inner one, where the class never appears. Reading it there
		 * silently returned "not light" and painted the dark palette over a light
		 * theme; the icon rail came out near-black against a cream window.
		 *
		 * `--vscode-editor-background` is injected into this document, so its
		 * luminance is a fact rather than a convention.
		 */
		const isLightTheme = () => {
			const raw = getComputedStyle(root).getPropertyValue("--vscode-editor-background").trim()
			const m = raw.match(/^#?([0-9a-f]{6})/i) ?? raw.match(/rgba?\(([^)]+)\)/i)
			if (!m) {
				return !document.body.className.includes("vscode-dark")
			}
			const [r, g, b] = m[1].includes(",")
				? m[1]
						.split(",")
						.slice(0, 3)
						.map((v) => Number(v.trim()))
				: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
			// Rec. 601 luma is enough to separate the two families.
			return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5
		}

		let applied: string | undefined

		const apply = () => {
			const themeId = DEFAULT_THEME_BY_KIND[isLightTheme() ? "light" : "dark"]
			const highContrastLight = document.body.dataset.vscodeThemeKind === "vscode-high-contrast-light"
			const highContrastDark = document.body.dataset.vscodeThemeKind === "vscode-high-contrast"
			const selection = `${themeId}:${highContrastLight}:${highContrastDark}`

			// This function writes custom properties onto the same element the
			// observer below watches, so re-applying an unchanged theme would feed
			// the observer its own mutations forever.
			if (selection === applied) {
				return
			}
			applied = selection

			/*
			 * Only the `--octo-*` half is published.
			 *
			 * `buildThemeVariables` also emits ~110 `--vscode-*` properties, which
			 * exist so this palette can drive a UI that has none. Here the host
			 * already injects them from the `octocode-themes` extension — generated
			 * from this very palette — so writing them again would override the
			 * live theme with a second copy that cannot follow a user's own theme.
			 */
			for (const [name, value] of Object.entries(
				buildThemeVariables(
					themeId,
					highContrastLight ? solarizedLight : highContrastDark ? legacyDark : undefined,
				),
			)) {
				if (name.startsWith("--octo-")) {
					root.style.setProperty(name, value)
				}
			}
			root.dataset.octocodeTheme = themeId
		}

		apply()

		/*
		 * The host rewrites the injected custom properties on `<html>` when the
		 * colour theme changes, so watching that element's `style` is what tracks a
		 * theme switch here. Watching the body class would miss it entirely: that
		 * class lives on the outer frame.
		 */
		const observer = new MutationObserver(apply)
		observer.observe(root, { attributes: true, attributeFilter: ["style", "class"] })
		observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind"] })
		return () => observer.disconnect()
	}, [])
}
