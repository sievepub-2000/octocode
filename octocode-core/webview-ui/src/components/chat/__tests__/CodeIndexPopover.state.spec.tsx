import { act, fireEvent, render, screen, within } from "@src/utils/test-utils"
import type { ExtensionState } from "@roo-code/types"
import { PopoverTrigger } from "@src/components/ui"
import { CodeIndexPopover, type CodeIndexSettingsActions } from "../CodeIndexPopover"
import { createRef } from "react"
import { vscode } from "@src/utils/vscode"

let state: Partial<ExtensionState>
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const latestSaveRequestId = () =>
	vi
		.mocked(vscode.postMessage)
		.mock.calls.findLast(([message]) => message.type === "saveCodeIndexSettingsAtomic")?.[0].requestId

it.each([true, false])(
	"coordinates parent save and waits for backend acknowledgement (success: %s)",
	async (success) => {
		state = {
			codeIndexWorkspacePath: "/workspace",
			apiConfiguration: {},
			codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: "native" },
		}
		const settingsRef = createRef<CodeIndexSettingsActions>()
		const onDirtyChange = vi.fn()
		render(
			<CodeIndexPopover
				inline
				settingsRef={settingsRef}
				onDirtyChange={onDirtyChange}
				indexingStatus={{ systemStatus: "Standby", processedItems: 0, totalItems: 0 }}
			/>,
		)
		fireEvent.click(screen.getByText("settings:codeIndex.advancedConfigLabel"))
		const results = within(screen.getByTestId("search-max-results-slider")).getByRole("slider")
		fireEvent.keyDown(results, { key: "ArrowRight" })
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		let saved: Promise<boolean> | undefined
		act(() => {
			saved = settingsRef.current?.save()
		})
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "saveCodeIndexSettingsAtomic" }),
		)
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "codeIndexSettingsSaved", requestId: latestSaveRequestId(), success },
				}),
			)
			expect(await saved).toBe(success)
		})
		expect(onDirtyChange).toHaveBeenLastCalledWith(!success)
		if (!success) {
			act(() => settingsRef.current?.discard())
			expect(onDirtyChange).toHaveBeenLastCalledWith(false)
		}
	},
)

it("ignores the timed-out save acknowledgement while a newer save is pending", async () => {
	state = {
		codeIndexWorkspacePath: "/workspace",
		apiConfiguration: {},
		codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: "native" },
	}
	const settingsRef = createRef<CodeIndexSettingsActions>()
	const onDirtyChange = vi.fn()
	render(
		<CodeIndexPopover
			inline
			settingsRef={settingsRef}
			onDirtyChange={onDirtyChange}
			indexingStatus={{ systemStatus: "Standby", processedItems: 0, totalItems: 0 }}
		/>,
	)
	fireEvent.click(screen.getByText("settings:codeIndex.advancedConfigLabel"))
	fireEvent.keyDown(within(screen.getByTestId("search-max-results-slider")).getByRole("slider"), {
		key: "ArrowRight",
	})
	vi.useFakeTimers()
	try {
		let saved: Promise<boolean> | undefined
		act(() => {
			saved = settingsRef.current?.save()
		})
		const oldRequestId = latestSaveRequestId()
		await act(async () => {
			vi.advanceTimersByTime(15_000)
			expect(await saved).toBe(false)
		})
		act(() => {
			saved = settingsRef.current?.save()
		})
		const requestId = latestSaveRequestId()
		expect(requestId).toEqual(expect.any(String))
		expect(requestId).not.toBe(oldRequestId)
		const completed = vi.fn()
		void saved?.then(completed)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "codeIndexSettingsSaved", requestId: oldRequestId, success: true },
				}),
			),
		)
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		expect(completed).not.toHaveBeenCalled()
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "codeIndexSettingsSaved", requestId, success: true } }),
			)
			expect(await saved).toBe(true)
		})
		expect(onDirtyChange).toHaveBeenLastCalledWith(false)
	} finally {
		vi.useRealTimers()
	}
})

it("rejects invalid indexing settings without sending a save request", async () => {
	state = {
		codeIndexWorkspacePath: "/workspace",
		apiConfiguration: {},
		codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: "ollama" },
	}
	const settingsRef = createRef<CodeIndexSettingsActions>()
	render(
		<CodeIndexPopover
			inline
			settingsRef={settingsRef}
			indexingStatus={{ systemStatus: "Standby", processedItems: 0, totalItems: 0 }}
		/>,
	)
	const savesBefore = vi
		.mocked(vscode.postMessage)
		.mock.calls.filter(([message]) => message.type === "saveCodeIndexSettingsAtomic").length
	await act(async () => {
		expect(await settingsRef.current?.save()).toBe(false)
	})
	expect(
		vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "saveCodeIndexSettingsAtomic"),
	).toHaveLength(savesBefore)
	expect(screen.getByRole("button", { name: "settings:codeIndex.setupConfigLabel" })).toHaveAttribute(
		"aria-expanded",
		"true",
	)
	expect(screen.getByRole("alert")).not.toBeEmptyDOMElement()
})

it("preserves dirty index settings across state refreshes and clears the save state after acknowledgement", () => {
	state = {
		codeIndexWorkspacePath: "/workspace",
		apiConfiguration: {},
		codebaseIndexConfig: {
			codebaseIndexEnabled: true,
			codebaseIndexEmbedderProvider: "ollama",
			codebaseIndexEmbedderBaseUrl: "http://localhost:11434",
			codebaseIndexQdrantUrl: "http://old:6333",
			codebaseIndexEmbedderModelId: "model",
		},
	}
	const component = () => (
		<CodeIndexPopover indexingStatus={{ systemStatus: "Standby", processedItems: 0, totalItems: 0 }}>
			<PopoverTrigger>index settings</PopoverTrigger>
		</CodeIndexPopover>
	)
	const view = render(component())
	fireEvent.click(screen.getByText("index settings"))
	fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))
	const url = screen.getByPlaceholderText("settings:codeIndex.qdrantUrlPlaceholder")
	fireEvent.input(url, { target: { value: "http://edited:6333" } })
	state = {
		...state,
		codebaseIndexConfig: { ...state.codebaseIndexConfig, codebaseIndexQdrantUrl: "http://refresh:6333" },
	}
	view.rerender(component())
	expect(url).toHaveValue("http://edited:6333")
	expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeEnabled()
	fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "codeIndexSettingsSaved", requestId: latestSaveRequestId(), success: true },
			}),
		),
	)
	expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeDisabled()
})

it.each(["native", "semble"] as const)(
	"renders %s settings through the working offline index and reports unsaved changes",
	(provider) => {
		state = {
			codeIndexWorkspacePath: "/workspace",
			apiConfiguration: {},
			codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: provider },
		}
		const onDirtyChange = vi.fn()
		render(
			<CodeIndexPopover
				inline
				onDirtyChange={onDirtyChange}
				indexingStatus={{ systemStatus: "Standby", processedItems: 0, totalItems: 0 }}
			/>,
		)
		expect(screen.getByText("settings:codeIndex.enableLabel")).toBeInTheDocument()
		fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))
		expect(screen.queryByPlaceholderText("settings:codeIndex.qdrantUrlPlaceholder")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:codeIndex.startIndexingButton" })).toBeEnabled()
		fireEvent.click(screen.getByText("settings:codeIndex.advancedConfigLabel"))
		const results = within(screen.getByTestId("search-max-results-slider")).getByRole("slider")
		fireEvent.keyDown(results, { key: "ArrowRight" })
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		fireEvent.keyDown(document, { key: "Escape" })
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
	},
)
