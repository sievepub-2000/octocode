import { render, screen } from "@testing-library/react"

import { ReasoningBlock } from "../ReasoningBlock"

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ reasoningBlockCollapsed: false }),
}))

vi.mock("../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

describe("ReasoningBlock", () => {
	it("shows an accessible progress state while reasoning streams", () => {
		render(<ReasoningBlock content="checking" ts={1} isStreaming isLast />)

		// Substring, not equality: the status region also carries the elapsed-time
		// counter, and the exact wording belongs to the translation files rather
		// than to this test. Asserting the full string previously only passed
		// because the `chat` namespace was failing to load, so `t()` was returning
		// the component's own `defaultValue` instead of the real translation.
		expect(screen.getByRole("status")).toHaveTextContent(/Thinking/)
		expect(screen.getByTestId("hourglass-indicator")).toHaveClass("motion-safe:animate-spin")
	})

	it("does not render an empty completed reasoning block", () => {
		const { container } = render(<ReasoningBlock content="  " ts={1} isStreaming={false} isLast />)

		expect(container).toBeEmptyDOMElement()
	})
})
