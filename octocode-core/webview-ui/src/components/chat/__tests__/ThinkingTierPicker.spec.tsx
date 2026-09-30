import { render, screen, fireEvent } from "@/utils/test-utils"

import { ThinkingTierPicker } from "../ThinkingTierPicker"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { tier?: string }) => (options?.tier !== undefined ? `${key}:${options.tier}` : key),
	}),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

describe("ThinkingTierPicker", () => {
	it("is greyed out and inert for a model whose thinking is pinned off", () => {
		const onChange = vi.fn()
		render(<ThinkingTierPicker modelId="qwen38-flash-next:instruct" apiConfiguration={{}} onChange={onChange} />)
		const trigger = screen.getByTestId("thinking-tier-trigger")
		expect(trigger).toBeDisabled()
		expect(trigger).toHaveAttribute("aria-label", "chat:thinking.unsupported")
		fireEvent.click(trigger)
		expect(onChange).not.toHaveBeenCalled()
	})

	it("offers the detected tiers and saves the choice with the model's thinking style", () => {
		const onChange = vi.fn()
		render(
			<ThinkingTierPicker
				modelId="qwen38-flash-next"
				apiConfiguration={{ reasoningEffort: "low" }}
				onChange={onChange}
			/>,
		)
		const trigger = screen.getByTestId("thinking-tier-trigger")
		expect(trigger).toHaveTextContent("chat:thinking.tiers.low")
		fireEvent.click(trigger)
		for (const tier of ["disable", "low", "medium", "high"]) {
			expect(screen.getByTestId(`thinking-tier-${tier}`)).toBeInTheDocument()
		}
		fireEvent.click(screen.getByTestId("thinking-tier-disable"))
		expect(onChange).toHaveBeenCalledWith({
			reasoningEffort: "disable",
			enableReasoningEffort: false,
			reasoningStyle: "template",
		})
	})

	it("shows the fallback tier when the saved tier does not fit the model", () => {
		render(
			<ThinkingTierPicker modelId="qwen38-flash-next" apiConfiguration={{ reasoningEffort: "xhigh" }} onChange={vi.fn()} />,
		)
		expect(screen.getByTestId("thinking-tier-trigger")).toHaveTextContent("chat:thinking.tiers.disable")
	})
})
