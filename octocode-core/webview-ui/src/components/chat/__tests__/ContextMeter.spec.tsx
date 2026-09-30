// npx vitest src/components/chat/__tests__/ContextMeter.spec.tsx

import { render, screen } from "@testing-library/react"

import { ContextMeter } from "../ContextMeter"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? "" }),
}))

vi.mock("@src/components/ui", () => ({
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const wedge = () => document.querySelector("path")?.getAttribute("d") ?? ""

/**
 * The meter is a filled sector, not a ring.
 *
 * A wedge that sweeps from the centre states how much of the window is taken;
 * the two cases that break naive arc maths are an empty window and a full one —
 * at exactly one turn an SVG arc returns to its start and disappears, so a full
 * window has to be drawn as the whole disc.
 */
describe("ContextMeter", () => {
	it("reports the share of the window in use", () => {
		render(<ContextMeter used={45_000} total={100_000} condenseAtPercent={90} />)

		expect(screen.getByTestId("context-meter")).toHaveAttribute("data-percent", "45")
	})

	it("draws a wedge that grows with usage", () => {
		const { rerender } = render(<ContextMeter used={10_000} total={100_000} condenseAtPercent={90} />)
		const small = wedge()

		rerender(<ContextMeter used={70_000} total={100_000} condenseAtPercent={90} />)
		const large = wedge()

		// Both start at twelve o'clock from the centre; only the sweep differs.
		expect(small).toContain("M 8 8 L 8 1")
		expect(large).toContain("M 8 8 L 8 1")
		expect(large).not.toBe(small)
		// Past the half turn the arc has to be flagged as the long way round.
		expect(small).toContain("0 0 1")
		expect(large).toContain("0 1 1")
	})

	it("draws the whole disc when the window is full", () => {
		render(<ContextMeter used={100_000} total={100_000} condenseAtPercent={90} />)

		// A sector of exactly one turn would collapse to nothing.
		expect(wedge()).not.toContain("L 8 8")
		expect(screen.getByTestId("context-meter")).toHaveAttribute("data-percent", "100")
	})

	it("never reports more than a full window", () => {
		render(<ContextMeter used={250_000} total={100_000} condenseAtPercent={90} />)

		expect(screen.getByTestId("context-meter")).toHaveAttribute("data-percent", "100")
	})

	it("renders nothing without a window to measure against", () => {
		const { container } = render(<ContextMeter used={1_000} total={0} condenseAtPercent={90} />)

		expect(container).toBeEmptyDOMElement()
	})
})
