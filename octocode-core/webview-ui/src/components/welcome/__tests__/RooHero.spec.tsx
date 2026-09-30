import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import RooHero from "../RooHero"

describe("RooHero", () => {
	it("renders compact OCTO and CODE words with one gap and accent initials", () => {
		render(<RooHero showWordmark />)

		const wordmark = screen.getByLabelText("OCTO CODE")
		const words = within(wordmark).getAllByTestId("octocode-wordmark-word")

		expect(screen.getByAltText("OctoCode")).toHaveClass("h-6", "w-6")
		expect(wordmark).toHaveStyle({ marginLeft: "24px" })
		expect(wordmark).toHaveClass("gap-[0.5ch]")
		expect(words).toHaveLength(2)
		expect(words[0]).toHaveTextContent(/^OCTO$/)
		expect(words[1]).toHaveTextContent(/^CODE$/)
		expect(within(words[0]).getByText("O")).toHaveStyle({ color: "#D4554F" })
		expect(within(words[1]).getByText("C")).toHaveStyle({ color: "#D4554F" })

		// The remainder must follow the theme, not a literal colour: the wordmark
		// previously hardcoded #000000 and was invisible on a dark background.
		expect(within(words[0]).getByText("CTO")).toHaveStyle({ color: "var(--vscode-foreground)" })
		expect(within(words[1]).getByText("ODE")).toHaveStyle({ color: "var(--vscode-foreground)" })
	})
})
