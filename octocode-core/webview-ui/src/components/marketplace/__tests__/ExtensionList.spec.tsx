import { act, fireEvent, render, screen } from "@testing-library/react"

import { vscode } from "@src/utils/vscode"

import { ExtensionList } from "../ExtensionList"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))

const state = (entries: unknown[], error?: string) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "extensionState",
					payload: {
						entries,
						error,
						requestId: (
							vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0].payload as { requestId?: string }
						)?.requestId,
					},
				},
			}),
		)
	})

describe("ExtensionList", () => {
	beforeEach(() => vi.clearAllMocks())
	it("ignores obsolete market results after switching to installed tools", () => {
		render(<ExtensionList kind="skill" tabs searchable />)
		const first = (vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0].payload as { requestId: string }).requestId
		fireEvent.click(screen.getByRole("tab", { name: "common:extensions.installed" }))
		state([])
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "extensionState", payload: { requestId: first, entries: [], error: "stale error" } },
				}),
			),
		)
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(screen.getByRole("tab", { name: "common:extensions.installed" })).toHaveAttribute(
			"aria-selected",
			"true",
		)
	})

	it("lists one kind through the shared request and offers only the allowed actions", () => {
		render(<ExtensionList kind="environment" />)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "extensionRequest",
			payload: { action: "list", kind: "environment", requestId: expect.any(String) },
		})
		state([
			{
				kind: "environment",
				id: "node",
				name: "Node.js",
				scope: "system",
				installed: true,
				builtIn: true,
				actions: [],
			},
			{
				kind: "environment",
				id: "go",
				name: "Go",
				scope: "system",
				installed: false,
				builtIn: false,
				actions: ["install"],
				detail: "~300 MB",
			},
			{
				kind: "mcp",
				id: "other",
				name: "Other",
				scope: "global",
				installed: true,
				builtIn: false,
				actions: ["uninstall"],
			},
		])
		expect(screen.queryByTestId("extension-other")).not.toBeInTheDocument()
		expect(screen.getByTestId("extension-node").querySelectorAll("button")).toHaveLength(0)
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.install" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "extensionRequest",
			payload: { action: "install", kind: "environment", id: "go", requestId: expect.any(String) },
		})
		expect(screen.getByRole("button", { name: "common:extensions.working" })).toBeDisabled()
	})

	it("shows a refused action and re-enables the list", () => {
		render(<ExtensionList kind="mcp" />)
		state([
			{
				kind: "mcp",
				id: "wiki",
				name: "Wiki",
				scope: "global",
				installed: true,
				builtIn: false,
				actions: ["disable", "uninstall"],
			},
		])
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.disable" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "extensionRequest",
			payload: { action: "disable", kind: "mcp", id: "wiki", scope: "global", requestId: expect.any(String) },
		})
		state(
			[
				{
					kind: "mcp",
					id: "wiki",
					name: "Wiki",
					scope: "global",
					installed: true,
					builtIn: false,
					actions: ["disable", "uninstall"],
				},
			],
			"boom",
		)
		expect(screen.getByRole("alert")).toHaveTextContent("boom")
		expect(screen.getByRole("button", { name: "common:extensions.disable" })).toBeEnabled()
	})
})
