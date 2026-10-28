import { midnightPurple, solarizedLight, themes, DEFAULT_THEME_BY_KIND, shape, type Palette } from "../palettes"

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
	const m = hex.replace("#", "")
	const rgb = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255)
	const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
	return (hi + 0.05) / (lo + 0.05)
}

/** Every colour in a palette. All of them are opaque; none carries alpha. */
const opaqueColors = (p: Palette): string[] => [
	p.bg,
	p.bgElevated,
	p.bgSunken,
	p.border,
	p.borderStrong,
	p.fg,
	p.fgStrong,
	p.fgMuted,
	p.accent,
	p.accentFg,
	p.success,
	p.warning,
	p.danger,
	p.info,
	...Object.values(p.syntax),
	...Object.values(p.diff),
]

describe("theme palettes", () => {
	it("defines exactly the two shipped themes", () => {
		expect(Object.keys(themes).sort()).toEqual(["midnight-purple", "solarized-light"])
		expect(DEFAULT_THEME_BY_KIND).toEqual({ light: "solarized-light", dark: "midnight-purple" })
	})

	it.each(Object.values(themes))("$label uses well-formed hex colours throughout", ({ palette }) => {
		// Collected rather than asserted per-colour so a failure names every offender
		// at once. Six digits only: an 8-digit value carries alpha, which silently
		// breaks the contrast guarantees measured below.
		const malformed = opaqueColors(palette).filter((c) => !/^#[0-9a-f]{6}$/i.test(c))
		expect(malformed).toEqual([])
	})

	describe("fidelity to the design references", () => {
		it("uses Solarized's own published values for the light theme", () => {
			// Solarized is a specification, not a mood. If these drift the theme stops
			// being the thing it claims to be, and the drift is invisible in review —
			// every neighbouring cream is still a plausible cream.
			expect(solarizedLight.bg).toBe("#fdf6e3") // base3
			expect(solarizedLight.bgSunken).toBe("#eee8d5") // base2
			expect(solarizedLight.fg).toBe("#586e75") // base01
			expect(solarizedLight.fgStrong).toBe("#073642") // base02
			expect(solarizedLight.fgMuted).toBe("#657b83") // base00
			expect(solarizedLight.accent).toBe("#268bd2") // blue
			expect(solarizedLight.danger).toBe("#dc322f") // red
			expect(solarizedLight.warning).toBe("#b58900") // yellow
			expect(solarizedLight.success).toBe("#859900") // green
		})

		it("uses the supplied black, charcoal and copper reference for the dark theme", () => {
			expect(midnightPurple.bg).toBe("#000000")
			expect(midnightPurple.bgElevated).toBe("#0e0e10")
			expect(midnightPurple.accent).toBe("#9b6b50")
			expect(contrast(midnightPurple.accent, midnightPurple.bg)).toBeGreaterThanOrEqual(4.5)
			expect(contrast(midnightPurple.accentFg, midnightPurple.accent)).toBeGreaterThanOrEqual(4.5)
		})

		it("keeps the two themes on opposite sides of the light/dark divide", () => {
			expect(luminance(solarizedLight.bg)).toBeGreaterThan(0.5)
			expect(luminance(midnightPurple.bg)).toBeLessThan(0.1)
		})
	})

	describe("legibility", () => {
		it.each(Object.values(themes))("$label body text meets WCAG AA on its background", ({ palette }) => {
			expect(contrast(palette.fg, palette.bg)).toBeGreaterThanOrEqual(4.5)
		})

		it.each(Object.values(themes))("$label body text is also readable on raised cards", ({ palette }) => {
			// Cards are a different surface from the page; text must clear AA on both.
			expect(contrast(palette.fg, palette.bgElevated)).toBeGreaterThanOrEqual(4.5)
		})

		it.each(Object.values(themes))("$label emphasised text is at least as readable as body", ({ palette }) => {
			expect(contrast(palette.fgStrong, palette.bg)).toBeGreaterThanOrEqual(contrast(palette.fg, palette.bg))
		})

		it.each(Object.values(themes))("$label muted text still clears the 3:1 large-text floor", ({ palette }) => {
			expect(contrast(palette.fgMuted, palette.bg)).toBeGreaterThanOrEqual(3)
		})

		it.each(Object.values(themes))("$label accent text is readable on the accent fill", ({ palette }) => {
			expect(contrast(palette.accentFg, palette.accent)).toBeGreaterThanOrEqual(3)
		})

		it.each(Object.values(themes))("$label diff text is readable on its diff background", ({ palette }) => {
			expect(contrast(palette.diff.addedFg, palette.diff.addedBg)).toBeGreaterThanOrEqual(4.5)
			expect(contrast(palette.diff.removedFg, palette.diff.removedBg)).toBeGreaterThanOrEqual(4.5)
		})

		it.each(Object.values(themes))("$label keeps the recessed surface distinct from the page", ({ palette }) => {
			// Chrome — the icon rail, tab strips, code blocks — has to read as a
			// different plane. Raised surfaces are not checked here: they are allowed
			// to share the page's fill and be separated by a hairline instead.
			expect(contrast(palette.bgSunken, palette.bg)).toBeGreaterThan(1.01)
		})

		it.each(Object.values(themes).filter((theme) => theme.kind === "dark"))(
			"$label paints no surface pure white",
			({ palette }) => {
				// A white panel on a Solarized ground reads as a hole punched in the
				// theme. That is exactly how the task list and the chat box were
				// reported, and nothing in the palette's own rules would have caught it.
				const white = [palette.bg, palette.bgElevated, palette.bgSunken].filter(
					(surface) => surface.toLowerCase() === "#ffffff",
				)
				expect(white).toEqual([])
			},
		)
	})

	describe("shape language", () => {
		it("exposes a radius scale in ascending order", () => {
			const px = (v: string) => parseInt(v, 10)
			expect(px(shape.radius.sm)).toBeLessThan(px(shape.radius.md))
			expect(px(shape.radius.md)).toBeLessThan(px(shape.radius.lg))
			expect(px(shape.radius.lg)).toBeLessThan(px(shape.radius.xl))
			expect(shape.radius.pill).toBe("999px")
		})
	})
})
