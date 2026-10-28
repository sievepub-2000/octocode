import { act, fireEvent, render, screen } from "@testing-library/react"
import { CodeIndexSearch } from "../CodeIndexSearch"
import { vscode } from "@src/utils/vscode"

const state = vi.hoisted(() => ({ codeIndexWorkspacePath: "D:\\fixture-a" as string | undefined }))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

it("queries the selected project and drops late results after a project switch", () => {
	const { rerender } = render(<CodeIndexSearch />)
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "find_symbol" } })
	fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.searchButton" }))
	const first = vi.mocked(vscode.postMessage).mock.calls.at(-1)![0]
	expect(first).toMatchObject({
		type: "searchCodeIndex",
		text: "find_symbol",
		values: { workspacePath: "D:\\fixture-a" },
	})
	state.codeIndexWorkspacePath = "D:\\fixture-b"
	rerender(<CodeIndexSearch />)
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "codeIndexSearchResult",
					requestId: first.requestId,
					codeIndexSearch: {
						workspacePath: "D:\\fixture-a",
						matches: [{ filePath: "D:\\fixture-a\\private.rs", startLine: 1, endLine: 1, text: "private" }],
					},
				},
			}),
		),
	)
	expect(screen.queryByText("private")).not.toBeInTheDocument()
	expect(screen.getByRole("textbox")).toHaveValue("")
	state.codeIndexWorkspacePath = undefined
	rerender(<CodeIndexSearch />)
	expect(screen.getByRole("textbox")).toBeDisabled()
})
