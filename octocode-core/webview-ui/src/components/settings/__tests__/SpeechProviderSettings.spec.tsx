import type React from "react"
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react"
import { vi } from "vitest"
import { SpeechProviderSettings } from "../SpeechProviderSettings"
import { requestRuntime } from "@src/utils/runtimeRequest"
import { loadUiLanguage, WithTranslations } from "@src/utils/test-i18n"
vi.mock("@src/utils/runtimeRequest", () => ({ requestRuntime: vi.fn() }))

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

it("defaults to local FunASR, configures the shared Provider fields, and checks the selected endpoint", async () => {
	vi.mocked(requestRuntime).mockImplementation(async (method) =>
		method === "provider.speech.info"
			? ({ modelDirectory: "C:/OctoCode/environments/funasr/models" } as never)
			: ({ ready: true } as never),
	)
	const onChange = vi.fn()
	const { rerender } = render(<SpeechProviderSettings settings={{}} onChange={onChange} />)
	expect(screen.getByLabelText("语音服务")).toHaveValue("funasr-local")
	await waitFor(() =>
		expect(screen.getByLabelText("语音模型目录")).toHaveAttribute(
			"placeholder",
			"C:/OctoCode/environments/funasr/models",
		),
	)
	fireEvent.change(screen.getByLabelText("语音模型名称"), { target: { value: "replacement.gguf" } })
	expect(onChange).toHaveBeenCalledWith("speechModelId", "replacement.gguf")
	fireEvent.click(screen.getByRole("button", { name: "检查语音接口" }))
	await screen.findByText(/接口连接正常/)
	rerender(
		<SpeechProviderSettings
			settings={{ speechProvider: "openai-compatible", speechBaseUrl: "http://localhost/v1" }}
			onChange={onChange}
		/>,
	)
	expect(screen.queryByLabelText("语音模型目录")).not.toBeInTheDocument()
	fireEvent.change(screen.getByLabelText("语音 API 密钥"), { target: { value: "secret" } })
	expect(onChange).toHaveBeenCalledWith("speechApiKey", "secret")
	expect(screen.getByLabelText("语音 API 密钥")).toHaveAttribute("type", "password")
	vi.mocked(requestRuntime).mockRejectedValueOnce(new Error("HTTP 401"))
	fireEvent.click(screen.getByRole("button", { name: "检查语音接口" }))
	await screen.findByText("HTTP 401")
})
