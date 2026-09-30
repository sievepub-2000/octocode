import type React from "react"
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react"
import { vi } from "vitest"
import { ModelContextSettings } from "../ModelContextSettings"
import { vscode } from "@src/utils/vscode"
import { loadUiLanguage, WithTranslations } from "@src/utils/test-i18n"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// The labels asserted below are Chinese, and locales other than English load on
// demand — without this the component renders raw keys.
beforeAll(() => loadUiLanguage())

/*
 * Render inside a translation context that actually translates.
 *
 * `useAppTranslation` returns the key unchanged when nothing provides it, which
 * is what left every assertion below looking for text the DOM never contained.
 */
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: WithTranslations })

describe("provider context controls", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})
	it("requests derived context, displays the effective budget, and emits saved profile fields", async () => {
		vi.useFakeTimers()
		const onChange = vi.fn()
		const { rerender } = render(
			<ModelContextSettings settings={{ apiProvider: "openai", openAiModelId: "qwen" }} onChange={onChange} />,
		)
		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.queryByLabelText("手动上下文长度")).not.toBeInTheDocument()
		await act(async () => {
			vi.advanceTimersByTime(650)
		})
		const message = vi.mocked(vscode.postMessage).mock.calls[0][0]
		expect(message).toMatchObject({
			type: "runtimeRequest",
			payload: { method: "provider.context", params: { openAiModelId: "qwen" } },
		})
		const requestId = (message.payload as { requestId: string }).requestId
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "runtimeResponse",
						payload: {
							requestId,
							result: {
								contextWindow: 65536,
								source: "server",
								maxOutputTokens: 16384,
								percent: 69,
								triggerTokens: 45219,
							},
						},
					},
				}),
			),
		)
		expect(screen.getByRole("status")).toHaveTextContent("69%")
		fireEvent.click(screen.getByRole("checkbox"))
		expect(onChange).toHaveBeenLastCalledWith("autoContextWindow", false)
		fireEvent.change(screen.getByLabelText("请求协议"), { target: { value: "responses" } })
		expect(onChange).toHaveBeenLastCalledWith("apiFormat", "responses")
		rerender(
			<ModelContextSettings
				settings={{ apiProvider: "openai", autoContextWindow: false, modelContextWindow: 131072 }}
				onChange={onChange}
			/>,
		)
		for (const value of ["", "6", "65", "655", "6553", "65536"]) {
			fireEvent.change(screen.getByLabelText("手动上下文长度"), { target: { value } })
			expect((screen.getByLabelText("手动上下文长度") as HTMLInputElement).value).toBe(value)
		}
		expect(onChange).toHaveBeenLastCalledWith("modelContextWindow", 65536)
	})
})
