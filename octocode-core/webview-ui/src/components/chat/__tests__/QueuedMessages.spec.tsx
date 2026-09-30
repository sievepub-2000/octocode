import { fireEvent, render, screen } from "@testing-library/react"
import { loadUiLanguage } from "@src/utils/test-i18n"
import { QueuedMessages } from "../QueuedMessages"

// The labels asserted below are Chinese, and locales other than English load on
// demand — without this the component renders raw keys.
beforeAll(() => loadUiLanguage())

vi.mock("../Mention", () => ({ Mention: ({ text }: { text: string }) => <span>{text}</span> }))
vi.mock("../../common/Thumbnails", () => ({ default: () => null }))

it("edits via an accessible button, preserves IME composition, and removes the queued message", () => {
	const update = vi.fn(),
		remove = vi.fn(),
		push = vi.fn()
	render(
		<QueuedMessages
			queue={[{ id: "q", text: "排队消息", images: [], timestamp: 1 }]}
			onUpdate={update}
			onRemove={remove}
			onPushNow={push}
		/>,
	)
	fireEvent.click(screen.getByRole("button", { name: "排队消息" }))
	const editor = screen.getByRole("textbox", { name: "编辑排队消息" })
	fireEvent.change(editor, { target: { value: "修改后的消息" } })
	fireEvent.keyDown(editor, { key: "Enter", isComposing: true })
	expect(update).not.toHaveBeenCalled()
	fireEvent.keyDown(editor, { key: "Enter", isComposing: false })
	expect(update).toHaveBeenCalledWith(0, "修改后的消息")
	fireEvent.click(screen.getByRole("button", { name: "删除排队消息" }))
	expect(remove).toHaveBeenCalledWith(0)
})

it("offers each queued message a way past the ones in front of it", () => {
	// The queue runs strictly in order, so without this a message typed as an
	// afterthought waits behind everything typed before it.
	const push = vi.fn()
	render(
		<QueuedMessages
			queue={[
				{ id: "a", text: "第一条", images: [], timestamp: 1 },
				{ id: "b", text: "第二条", images: [], timestamp: 2 },
			]}
			onUpdate={vi.fn()}
			onRemove={vi.fn()}
			onPushNow={push}
		/>,
	)
	const buttons = screen.getAllByRole("button", { name: "插队：让这条先跑" })
	expect(buttons).toHaveLength(2)
	fireEvent.click(buttons[1])
	expect(push).toHaveBeenCalledWith(1)
})

it("expands the message being edited and collapses the others to one line", () => {
	render(
		<QueuedMessages
			queue={[
				{ id: "a", text: "第一条\n第二行", images: [], timestamp: 1 },
				{ id: "b", text: "要编辑的消息\n它有很多行\n第三行\n第四行", images: [], timestamp: 2 },
			]}
			onUpdate={vi.fn()}
			onRemove={vi.fn()}
			onPushNow={vi.fn()}
		/>,
	)
	expect(screen.getByTestId("queued-messages").firstElementChild?.className).toContain("max-h-36")
	fireEvent.click(screen.getByRole("button", { name: /要编辑的消息/ }))
	const editor = screen.getByRole("textbox", { name: "编辑排队消息" }) as HTMLTextAreaElement
	expect(editor.value).toBe("要编辑的消息\n它有很多行\n第三行\n第四行")
	expect(editor.rows).toBe(4)
	expect(screen.getByTestId("queued-messages").firstElementChild?.className).toContain("max-h-[60vh]")
	const other = screen.getByRole("button", { name: "第一条" })
	expect(other).toHaveAttribute("data-collapsed", "true")
	expect(other.className).toContain("truncate")
})
