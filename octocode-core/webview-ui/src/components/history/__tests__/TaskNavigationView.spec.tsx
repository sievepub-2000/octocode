import { fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import TaskNavigationView from "../TaskNavigationView"

vi.mock("@src/utils/vscode")
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ cwd: "C:/project" }),
}))
vi.mock("../RuntimeHistoryView", () => ({ default: () => <div>Recent tasks</div> }))
vi.mock("../HistoryView", () => ({ default: () => <div>Recent tasks</div> }))

// These tests are about navigation, not about search. The real hook reaches for
// the extension-state context, which this suite deliberately does not stand up.
vi.mock("../useTaskSearch", () => ({
	useTaskSearch: () => ({ tasks: [], searchQuery: "", setSearchQuery: vi.fn() }),
}))
// The searchable history this view now embeds pulls in the real i18n setup,
// which calls `i18next.use(initReactI18next)` at module scope — so the mock has
// to carry that export as well as the hook.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { defaultValue?: string }) =>
			(
				({
					"octocode.newTask": "New task",
					"octocode.tasks": "OctoCode tasks",
				}) as Record<string, string>
			)[key] ??
			options?.defaultValue ??
			key,
	}),
	initReactI18next: { type: "3rdParty", init: () => {} },
	Trans: ({ children }: { children?: React.ReactNode }) => children,
}))

describe("TaskNavigationView", () => {
	it("keeps the directory and all host actions in task context", () => {
		render(<TaskNavigationView />)
		expect(screen.getByText("C:/project")).toBeInTheDocument()
		fireEvent.click(screen.getByText("C:/project"))
		for (const action of ["openFolder", "openRecent", "findFile", "commands", "keyboardShortcuts"]) {
			fireEvent.click(screen.getByText(`ui.${action}`))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "workspaceAction", text: action })
		}
	})
	it("starts a fresh task from the permanent task navigator", () => {
		render(<TaskNavigationView />)

		fireEvent.click(screen.getByRole("button", { name: "New task" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "clearTask" })
		expect(screen.getByRole("navigation", { name: "OctoCode tasks" })).toBeInTheDocument()
	})

	it("keeps task actions left aligned and management pages in settings", () => {
		render(<TaskNavigationView />)

		expect(screen.getByTestId("task-navigation-actions")).toHaveClass("justify-start")
		expect(screen.queryByRole("button", { name: "octocode.moreActions" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "octocode.research" })).not.toBeInTheDocument()
		expect(screen.queryByText("Configure Display Language")).not.toBeInTheDocument()
		expect(screen.queryByText("Color Theme")).not.toBeInTheDocument()
		expect(screen.queryByText("OCTOCODE")).not.toBeInTheDocument()
	})

	it("keeps logs out of the left management window", () => {
		render(<TaskNavigationView />)

		expect(screen.queryByRole("button", { name: "octocode.logs" })).not.toBeInTheDocument()
	})
})
