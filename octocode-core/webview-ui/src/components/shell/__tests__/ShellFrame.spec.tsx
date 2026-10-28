import { fireEvent, render, screen, within } from "@testing-library/react"
import { ShellFrame } from "../ShellFrame"

vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ renderContext: "editor" }) }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@src/components/history/TaskNavigationView", () => ({ default: () => <div>tasks</div> }))
vi.mock("@src/components/chat/OctoCodeAuthBadge", () => ({ OctoCodeAuthBadge: () => <span>account</span> }))
vi.mock("../UpdateRailBadge", () => ({ UpdateRailBadge: () => null }))
vi.mock("@src/components/chat/IndexingStatusBadge", () => ({
	IndexingStatusBadge: () => <span>standalone index</span>,
}))

it("keeps component management in the market and index management in settings", () => {
	const onSelect = vi.fn()
	render(
		<ShellFrame tab="chat" onSelect={onSelect}>
			<div>chat</div>
		</ShellFrame>,
	)
	const rail = within(screen.getByRole("navigation"))
	expect(rail.queryByRole("button", { name: "settings:sections.skills" })).not.toBeInTheDocument()
	expect(rail.queryByRole("button", { name: "settings:sections.mcp" })).not.toBeInTheDocument()
	expect(rail.queryByText("standalone index")).not.toBeInTheDocument()
	fireEvent.click(rail.getByRole("button", { name: "common:ui.marketplace" }))
	expect(onSelect).toHaveBeenCalledWith("marketplace")
	fireEvent.click(rail.getByRole("button", { name: "settings:common.title" }))
	expect(onSelect).toHaveBeenCalledWith("settings")
})
