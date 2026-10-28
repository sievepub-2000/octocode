import { render, screen } from "@testing-library/react"

import RuntimeTranscript, { isNearBottom } from "../RuntimeTranscript"

vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}))

describe("RuntimeTranscript message times", () => {
	it("centers stable local times above reasoning, execution, and each answer, excluding user turns", () => {
		const start = new Date(2026, 9, 18, 12, 59, 7).getTime()
		const event = (kind: string, text: string, created_at: number) => ({
			task_id: "task",
			session_id: "session",
			kind,
			payload: { data: text },
			created_at,
		})
		const events = [
			event("thought", "planning", start),
			event("thought", " carefully", start + 60_000),
			event("tool_call", "read source", start + 120_000),
			event("text", "first answer", start + 180_000),
			event("user.message", "try again", start + 240_000),
			event("text", "revised answer", start + 300_000),
		]
		const props = {
			prompt: "initial input",
			events,
			running: true,
			phase: "thinking" as const,
			onSelectOption: vi.fn(),
		}
		const { container, rerender, unmount } = render(<RuntimeTranscript {...props} />)
		const labels = [
			"--2026-10-18 12:59:07--",
			"--2026-10-18 13:01:07--",
			"--2026-10-18 13:02:07--",
			"--2026-10-18 13:04:07--",
		]
		expect(Array.from(container.querySelectorAll("time"), (item) => item.textContent)).toEqual(labels)
		for (const time of container.querySelectorAll("time")) {
			expect(time).toHaveClass("block", "w-full", "text-center")
			expect(time.dateTime).toBeTruthy()
		}
		expect(
			screen.getByText(labels[0]).compareDocumentPosition(screen.getByText("planning carefully")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
		// More streamed text keeps the start of this answer, rather than its latest token's time.
		rerender(<RuntimeTranscript {...props} events={[...events, event("text", " extended", start + 360_000)]} />)
		expect(Array.from(container.querySelectorAll("time"), (item) => item.textContent)).toEqual(labels)
		unmount()
		const reopened = render(<RuntimeTranscript {...props} running={false} />)
		expect(Array.from(reopened.container.querySelectorAll("time"), (item) => item.textContent)).toEqual(labels)
	})

	it("does not invent current times for missing or invalid historical timestamps", () => {
		const events = [undefined, NaN, Infinity, 9e20].map((created_at, index) => ({
			task_id: `task-${index}`,
			session_id: "session",
			kind: "text",
			payload: { data: `old answer ${index}` },
			created_at,
		}))
		const { container } = render(
			<RuntimeTranscript
				prompt="old input"
				events={events}
				running={false}
				phase="thinking"
				onSelectOption={vi.fn()}
			/>,
		)
		expect(container.querySelector("time")).toBeNull()
		expect(screen.getByText("old answer 0")).toBeVisible()
	})
})

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
