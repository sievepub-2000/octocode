import { render, screen } from "@testing-library/react"

import RuntimeTranscript, { isNearBottom } from "../RuntimeTranscript"

vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}))

describe("RuntimeTranscript waiting state", () => {
	it("renders images for the initial prompt and later user turns", () => {
		const image = "data:image/png;base64,aGVsbG8="
		render(
			<RuntimeTranscript
				prompt="first"
				images={[image]}
				events={[
					{
						session_id: "s",
						task_id: "t",
						kind: "user.message",
						payload: { text: "second", images: [image] },
					},
				]}
				phase="thinking"
				running={false}
				onSelectOption={() => undefined}
			/>,
		)
		expect(screen.getAllByRole("img")).toHaveLength(2)
	})
	it("shows model reasoning summaries inline as subdued small text", () => {
		const { getByText } = render(
			<RuntimeTranscript
				prompt="test"
				events={[
					{
						task_id: "task-1",
						session_id: "session-1",
						kind: "thought",
						payload: { data: "检查输入并选择工具" },
					},
				]}
				phase="thinking"
				running={false}
				onSelectOption={() => undefined}
			/>,
		)
		const thought = getByText("检查输入并选择工具")
		expect(thought).toHaveClass("text-xs", "text-vscode-descriptionForeground")
		expect(thought.closest("details")).toBeNull()
	})

	it("renders inline after prior output with a subtle animated label and flipping hourglass", () => {
		render(
			<RuntimeTranscript
				prompt="test"
				events={[
					{
						task_id: "task-1",
						session_id: "session-1",
						kind: "text",
						payload: { text: "previous answer" },
					},
				]}
				phase="thinking"
				running
				onSelectOption={() => undefined}
			/>,
		)

		const answer = screen.getByText("previous answer")
		const status = screen.getByTestId("runtime-wait-placeholder")
		expect(answer.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(status).toHaveClass("items-center", "py-1", "text-sm")
		expect(status).not.toHaveClass("justify-center", "py-4")
		expect(status.querySelector("span")).toHaveClass("octo-wait-label")
		expect(status.querySelector("svg")).toHaveClass("octo-hourglass-flip")
	})
})

describe("RuntimeTranscript scrolling", () => {
	it("follows new output only near the end of the transcript", () => {
		expect(isNearBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 })).toBe(true)
		expect(isNearBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1520 })).toBe(true)
		expect(isNearBottom({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1000 })).toBe(false)
		expect(isNearBottom({ scrollHeight: 300, clientHeight: 100, scrollTop: 160 })).toBe(true)
	})

	it("renders the user's own messages with the dedicated bubble style", () => {
		render(
			<RuntimeTranscript prompt="你好" events={[]} running={false} phase="executing" onSelectOption={vi.fn()} />,
		)
		const bubble = screen.getByText("你好")
		expect(bubble.className).toContain("octo-user-bubble")
		expect(bubble.className).not.toContain("bg-vscode-button-background")
	})
})
