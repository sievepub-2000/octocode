import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ExtensionKind } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { ExtensionList } from "../ExtensionList"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))

const state = (entries: unknown[], error?: string, nextCursor?: string) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "extensionState",
					payload: {
						entries,
						error,
						nextCursor,
						requestId: (
							vi.mocked(vscode.postMessage).mock.calls.at(-1)?.[0].payload as { requestId?: string }
						)?.requestId,
					},
				},
			}),
		)
	})

describe("ExtensionList", () => {
	it("fills a partial last page before advancing so newly fetched entries are not skipped", () => {
		render(<ExtensionList kind="skill" tabs />)
		state([...items(0, 20), { ...items(99, 1)[0], id: "installed", installed: true }], undefined, "cursor20")
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(1)
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		state(items(20, 20))
		expect(screen.getByText("2", { selector: "button" })).toHaveAttribute("aria-current", "page")
		expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(20)
		expect(screen.getAllByTestId(/^extension-item/)[0]).toHaveAttribute("data-testid", "extension-item19")
		expect(screen.getAllByTestId(/^extension-item/).at(-1)).toHaveAttribute("data-testid", "extension-item38")
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(1)
		expect(screen.getByTestId("extension-item39")).toBeInTheDocument()
	})
	const items = (start: number, count: number) =>
		Array.from({ length: count }, (_, index) => ({
			kind: "skill",
			id: `item${start + index}`,
			name: `Item ${start + index}`,
			scope: "global",
			installed: false,
			builtIn: false,
			actions: [],
			rank: 100 - start - index,
		}))
	it("fetches cursor pages, keeps cached pages and retries failed pages", () => {
		render(<ExtensionList kind="skill" tabs />)
		state(items(0, 20), undefined, "cursor20")
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "extensionRequest",
			payload: {
				action: "list",
				kind: "skill",
				page: "market",
				requestId: expect.any(String),
				cursor: "cursor20",
			},
		})
		state([], "network unavailable")
		expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(20)
		expect(screen.getByRole("button", { name: "common:extensions.nextPage" })).toBeEnabled()
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		state(items(20, 20), undefined, "cursor40")
		expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(20)
		expect(screen.getAllByTestId(/^extension-item/)[0]).toHaveAttribute("data-testid", "extension-item20")
		expect(screen.getByText("2", { selector: "button" })).toHaveAttribute("aria-current", "page")
		const calls = vi.mocked(vscode.postMessage).mock.calls.length
		fireEvent.click(screen.getByText("1", { selector: "button" }))
		expect(screen.getAllByTestId(/^extension-item/)[0]).toHaveAttribute("data-testid", "extension-item0")
		expect(vi.mocked(vscode.postMessage).mock.calls).toHaveLength(calls)
		fireEvent.click(screen.getByText("2", { selector: "button" }))
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		state(items(20, 20))
		expect(screen.getByText("2", { selector: "button" })).toHaveAttribute("aria-current", "page")
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.previousPage" }))
		expect(screen.getByText("1", { selector: "button" })).toHaveAttribute("aria-current", "page")
	})
	it("resets to the first page when the search changes", async () => {
		render(<ExtensionList kind="skill" searchable />)
		state(items(0, 43))
		fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Item 42" } })
		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenLastCalledWith({
				type: "extensionRequest",
				payload: { action: "list", kind: "skill", query: "Item 42", requestId: expect.any(String) },
			}),
		)
		state(items(42, 1))
		expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(1)
		expect(screen.getByText("1", { selector: "button" })).toHaveAttribute("aria-current", "page")
		expect(screen.getByRole("button", { name: "common:extensions.previousPage" })).toBeDisabled()
	})
	it.each(["extension", "skill", "mcp", "environment"] satisfies ExtensionKind[])(
		"limits every %s page to 20 and puts installed entries first",
		(kind) => {
			render(<ExtensionList kind={kind} searchable />)
			state(
				Array.from({ length: 43 }, (_, rank) => ({
					kind,
					id: `item${rank}`,
					name: `Item ${rank}`,
					scope: "global",
					installed: rank === 42,
					builtIn: false,
					actions: [],
					rank,
				})),
			)
			expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(20)
			expect(screen.getAllByTestId(/^extension-item/)[0]).toHaveAttribute("data-testid", "extension-item42")
			fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
			expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(20)
			expect(screen.getAllByTestId(/^extension-item/)[0]).toHaveAttribute("data-testid", "extension-item22")
			fireEvent.click(screen.getByRole("button", { name: "common:extensions.nextPage" }))
			expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(3)
			expect(screen.getByRole("button", { name: "common:extensions.nextPage" })).toBeDisabled()
			fireEvent.click(screen.getByRole("button", { name: "common:extensions.previousPage" }))
			expect(screen.getAllByTestId(/^extension-item/)).toHaveLength(20)
		},
	)
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
