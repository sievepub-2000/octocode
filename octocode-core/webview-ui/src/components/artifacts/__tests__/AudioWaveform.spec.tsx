import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import AudioWaveform from "../AudioWaveform"
import { requestRuntime } from "@src/utils/runtimeRequest"
import { loadUiLanguage } from "@src/utils/test-i18n"
vi.mock("@src/utils/runtimeRequest", () => ({ requestRuntime: vi.fn() }))

// The labels asserted below are Chinese, and locales other than English load on
// demand — without this the component renders raw keys.
beforeAll(() => loadUiLanguage())
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

it("enables transcription after decoding and cancels owned requests when the source changes or closes", async () => {
	vi.stubGlobal(
		"AudioContext",
		class {
			decodeAudioData = async () => ({ getChannelData: () => new Float32Array(32000), sampleRate: 16000 })
			close = async () => {}
		},
	)
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Uint8Array([1]))),
	)
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
	let resolve: (value: { text: string }) => void = () => undefined
	vi.mocked(requestRuntime).mockImplementation(async (method) =>
		method === "audio.finish"
			? ((await new Promise<{ text: string }>((r) => {
					resolve = r
				})) as never)
			: ({} as never),
	)
	const { rerender, unmount } = render(<AudioWaveform src="first.wav" />)
	const begin = () => screen.getAllByRole("button").find((button) => !button.getAttribute("aria-label"))!
	await waitFor(() => expect(begin()).toBeEnabled())
	fireEvent.click(begin())
	await waitFor(() => expect(requestRuntime).toHaveBeenCalledWith("audio.finish", expect.any(Object)))
	const first = vi.mocked(requestRuntime).mock.calls.find(([method]) => method === "audio.start")![1]
	rerender(<AudioWaveform src="second.wav" />)
	await waitFor(() => expect(requestRuntime).toHaveBeenCalledWith("audio.cancel", first))
	await act(async () => resolve({ text: "stale result" }))
	expect(screen.queryByText("stale result")).not.toBeInTheDocument()
	await waitFor(() => expect(begin()).toBeEnabled())
	fireEvent.click(begin())
	await screen.findByRole("button", { name: "取消语音转写" })
	unmount()
	expect(
		vi.mocked(requestRuntime).mock.calls.filter(([method]) => method === "audio.cancel").length,
	).toBeGreaterThanOrEqual(2)
})
