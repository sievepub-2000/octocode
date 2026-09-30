// `__INDEX_CSS__` is the contents of src/index.css, injected by vitest.config.ts.
// Under jsdom the stylesheet is unreachable from a spec -- `node:fs` does not
// resolve and CSS imports are stubbed to an empty string -- so the config reads
// it in Node and hands it over as a constant.
declare const __INDEX_CSS__: string
const css = __INDEX_CSS__

describe("theme token wiring", () => {
	it("keeps borders driven by VS Code tokens without a circular input-border override", () => {
		expect(css).toContain("--border: var(--vscode-input-border, var(--vscode-panel-border, transparent));")
		expect(css).not.toMatch(/body\s*\{\s*--vscode-input-border:\s*var\(--border\)/)
		expect(css).toContain("--color-vscode-sideBar-border: var(--vscode-sideBar-border);")
		expect(css).toContain("--color-vscode-panel-border: var(--vscode-panel-border);")
	})

	it("keeps the waiting indicators on composited properties", () => {
		/*
		 * These used to be asserted as stepped (`steps(12)`, `steps(4)`), on the
		 * theory that fewer frames meant fewer repaints. The stylesheet says why
		 * that was undone: every one of them animates `transform` or `opacity`,
		 * which the compositor handles without re-running paint, so stepping cost
		 * the smoothness and saved nothing — at four frames a turn the hourglass
		 * read as stuck. What is worth guarding is the property being animated, so
		 * that is what this checks now: an edit that animates width, height, top or
		 * left instead should fail here.
		 */
		expect(css).toMatch(/\.animate-spin,\s*\.motion-safe\\:animate-spin \{[^}]*animation: octo-spin/)
		expect(css).toMatch(/\.animate-pulse,\s*\.motion-safe\\:animate-pulse \{[^}]*animation: pulse/)
		expect(css).toContain(".octo-hourglass-flip {")
		expect(css).toContain(".octo-wait-label {")

		const keyframes = [...css.matchAll(/@keyframes (octo-spin|pulse|octo-wait-label) \{([\s\S]*?)\n\}/g)]
		expect(keyframes.map(([, name]) => name).sort()).toEqual(["octo-spin", "octo-wait-label", "pulse"])
		for (const [, name, body] of keyframes) {
			const animated = [...body.matchAll(/^\s*([a-z-]+):/gm)].map(([, property]) => property)
			expect({ name, uncomposited: animated.filter((p) => !["transform", "opacity"].includes(p)) }).toEqual({
				name,
				uncomposited: [],
			})
		}
	})

	it("disables the waiting animations under prefers-reduced-motion", () => {
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none/)
	})

	it("keeps the standard backdrop-filter last in the attachment overlay rule", () => {
		/*
		 * The frost on the floating attachment card is the whole point of it, and
		 * it survived the pipeline exactly once: as the *standard* property. The
		 * CSS minifier collapses a prefixed and an unprefixed declaration of the
		 * same property and keeps the last one, and Chromium 148 (the webview in
		 * the test instance) ignores `-webkit-backdrop-filter` altogether. An
		 * earlier revision listed the `-webkit-` line last, the shipped bundle
		 * dropped the standard declaration, and the card rendered as a flat,
		 * unfrosted panel -- visible only by inspecting computed style.
		 */
		const rule = css.match(/\.octo-attach-overlay \{[\s\S]*?\n\}/)
		expect(rule).not.toBeNull()
		const backdropLines = (rule![0].match(/[-a-z]*backdrop-filter:/g) ?? []).map((d) => d.slice(0, -1))
		expect(backdropLines).toEqual(["-webkit-backdrop-filter", "backdrop-filter"])
		expect(rule![0]).toMatch(/backdrop-filter: blur\(/)
	})
})
