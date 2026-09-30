// npx vitest src/components/shell/__tests__/OctoCodeShell.spec.tsx

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { OctoCodeShell, type ShellRailItem } from "../OctoCodeShell"

/**
 * The side column is resizable, and the grip has to be reachable to be so.
 *
 * The first implementation put the grip inside the panel, which clips its
 * overflow: half the grip was cut away and what remained was a three-pixel
 * target that could not be hit. It is a sibling of the panel now, positioned by
 * the same width the grid column uses, and these tests hold both halves of that
 * — that it exists outside the clipped panel, and that dragging it actually
 * changes the column.
 */
const rail: ShellRailItem[] = [{ id: "chat", label: "Chat", icon: <span>c</span> }]

const renderShell = () =>
	render(
		<OctoCodeShell
			rail={rail}
			activeRailId="chat"
			onRailSelect={() => {}}
			side={<div>tasks</div>}
			sideTitle="Tasks">
			<div>conversation</div>
		</OctoCodeShell>,
	)

const gridColumns = () => (screen.getByRole("navigation").parentElement as HTMLElement).style.gridTemplateColumns

describe("OctoCodeShell", () => {
	beforeEach(() => {
		try {
			localStorage.clear()
		} catch {
			// Storage is optional here; the component falls back to its default.
		}
	})

	it("puts the resize grip outside the panel that clips its overflow", () => {
		renderShell()

		const grip = screen.getByRole("separator", { name: /resize/i })
		const panel = screen.getByRole("complementary", { name: "Tasks" })

		expect(panel).not.toContainElement(grip)
	})

	it("widens the column when the grip is dragged right", async () => {
		const user = userEvent.setup()
		renderShell()
		expect(gridColumns()).toContain("300px")

		const grip = screen.getByRole("separator", { name: /resize/i })
		await user.pointer([
			{ target: grip, keys: "[MouseLeft>]", coords: { clientX: 356, clientY: 200 } },
			{ target: document.body, coords: { clientX: 436, clientY: 200 } },
			{ keys: "[/MouseLeft]" },
		])

		expect(gridColumns()).toContain("380px")
	})

	it("resizes from the keyboard and remembers the width", async () => {
		const { unmount } = renderShell()

		const grip = screen.getByRole("separator", { name: /resize/i })
		// Reachable without a pointer at all. Asserted as the attribute rather than
		// through .focus(), because jsdom does not emulate focus for a div that is
		// focusable only by tabindex.
		expect(grip).toHaveAttribute("tabindex", "0")

		// Dispatched at the grip rather than through the global keyboard: the
		// handler is bound to this element, and that binding is what is under test.
		fireEvent.keyDown(grip, { key: "ArrowRight" })
		fireEvent.keyDown(grip, { key: "ArrowRight" })

		expect(gridColumns()).toContain("332px")
		expect(localStorage.getItem("octocode.shell.sideWidth")).toBe("332")

		// A remembered width is only useful if it survives a reload.
		unmount()
		renderShell()
		expect(gridColumns()).toContain("332px")
	})

	it("refuses a width that would make the column unusable", async () => {
		const user = userEvent.setup()
		renderShell()

		const grip = screen.getByRole("separator", { name: /resize/i })
		await user.pointer([
			{ target: grip, keys: "[MouseLeft>]", coords: { clientX: 356, clientY: 200 } },
			{ target: document.body, coords: { clientX: 0, clientY: 200 } },
			{ keys: "[/MouseLeft]" },
		])

		expect(gridColumns()).toContain("200px")
	})

	/**
	 * Hiding the history has to be reversible.
	 *
	 * The collapse control lived inside the panel, so collapsing it removed the
	 * only way back and the conversation history appeared to have been deleted —
	 * reported by users as the history "not staying". Collapsing now leaves a
	 * strip whose button reopens the column, and the choice is remembered.
	 */
	it("offers a way back after the column is collapsed", async () => {
		const user = userEvent.setup()
		renderShell()

		expect(screen.getByRole("complementary", { name: "Tasks" })).toBeInTheDocument()

		await user.click(screen.getByRole("button", { name: /collapse tasks/i }))

		expect(screen.queryByRole("complementary", { name: "Tasks" })).not.toBeInTheDocument()
		// The wide track is gone; only the sliver that offers to restore it remains.
		expect(gridColumns()).toContain("34px")

		const restore = screen.getByRole("button", { name: /show tasks/i })
		await user.click(restore)

		expect(screen.getByRole("complementary", { name: "Tasks" })).toBeInTheDocument()
		expect(gridColumns()).toContain("300px")
	})

	it("keeps the column hidden across a reload once it is collapsed", async () => {
		const user = userEvent.setup()
		const { unmount } = renderShell()

		await user.click(screen.getByRole("button", { name: /collapse tasks/i }))
		expect(localStorage.getItem("octocode.shell.sideOpen")).toBe("false")

		unmount()
		renderShell()

		expect(screen.queryByRole("complementary", { name: "Tasks" })).not.toBeInTheDocument()
		// ... and the way back survives the reload too.
		expect(screen.getByRole("button", { name: /show tasks/i })).toBeInTheDocument()
	})

	it("shows the column by default when nothing has been remembered", () => {
		renderShell()

		expect(screen.getByRole("complementary", { name: "Tasks" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /show tasks/i })).not.toBeInTheDocument()
	})

	it("renders no restore strip when there is no side panel to restore", () => {
		render(
			<OctoCodeShell rail={rail} activeRailId="chat" onRailSelect={() => {}}>
				<div>conversation</div>
			</OctoCodeShell>,
		)

		expect(screen.queryByRole("complementary", { name: "Tasks" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /show tasks/i })).not.toBeInTheDocument()
	})
})
