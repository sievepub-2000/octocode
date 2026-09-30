import { afterEach, describe, expect, it, vi } from "vitest"
import { ModelContextDiscovery, compressionBudget, contextFromModel } from "../ModelContext"

const model = {
	model: "qwen",
	base_url: "http://127.0.0.1:8000/v1",
	api_backend: "chat_completions" as const,
	context_window: 999_999,
	max_completion_tokens: 32_768,
}
afterEach(() => vi.restoreAllMocks())

describe("effective model context", () => {
	it("discovers metadata from the configured failover endpoint list", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(new Response('{"data":[{"id":"qwen","max_model_len":262144}]}'))
		const result = await new ModelContextDiscovery().resolve({
			...model,
			base_url: "http://127.0.0.1:1/v1,http://127.0.0.1:2/v1",
		})
		expect(result).toMatchObject({ contextWindow: 262144, source: "server" })
		expect(result.warning).toBeUndefined()
		expect(fetch.mock.calls[1][0].toString()).toBe("http://127.0.0.1:2/v1/models")
	})
	it("uses the selected server model, deduplicates requests and separates credentials", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "another", max_model_len: 1_000_000 },
							{ id: "qwen", max_model_len: 65_536 },
						],
					}),
				),
		)
		const discovery = new ModelContextDiscovery()
		const [a, b] = await Promise.all([discovery.resolve(model), discovery.resolve(model)])
		expect(a).toEqual(b)
		expect(a.contextWindow).toBe(65_536)
		expect(a.source).toBe("server")
		expect(fetch).toHaveBeenCalledTimes(1)
		await discovery.resolve({ ...model, api_key: "different-test-key" })
		expect(fetch).toHaveBeenCalledTimes(2)
		expect(compressionBudget(a, 90)).toEqual({ percent: 69, triggerTokens: 45_219, reserveTokens: 3_277 })
		expect(compressionBudget(a, 0).percent).toBe(0)
	})
	it("falls back to 131072 instead of a stale hardcoded context", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
		const result = await new ModelContextDiscovery().resolve(model)
		expect(result).toMatchObject({ contextWindow: 131_072, source: "fallback" })
		expect(result.warning).toBeTruthy()
		expect(contextFromModel({ max_model_len: -1 })).toBeUndefined()
		expect(contextFromModel({ context_length: 1.5 })).toBeUndefined()
	})
	it("keeps explicit local context and rejects accidental settings from other providers", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"data":[]}'))
		const discovery = new ModelContextDiscovery()
		expect(
			(await discovery.resolve(model, { apiProvider: "ollama", autoContextWindow: false, ollamaNumCtx: 8192 }))
				.contextWindow,
		).toBe(8192)
		expect(fetch).not.toHaveBeenCalled()
		expect(
			(await discovery.resolve(model, { apiProvider: "openai-native", ollamaNumCtx: 8192 })).contextWindow,
		).toBe(131072)
	})
	it("reads Ollama metadata and bounds completion allocation", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response('{"model_info":{"qwen.context_length":8192}}'))
		const context = await new ModelContextDiscovery().resolve(model, { apiProvider: "ollama" })
		expect(context).toMatchObject({ contextWindow: 8192, maxOutputTokens: 2048, source: "server" })
		expect(fetch.mock.calls[0][0].toString()).toBe("http://127.0.0.1:8000/api/show")
		expect(compressionBudget(context, 90).percent).toBe(62)
	})
	it("uses the OpenAI custom output budget without treating it as automatic context", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"data":[]}'))
		const result = await new ModelContextDiscovery().resolve(model, {
			apiProvider: "openai",
			openAiCustomModelInfo: { contextWindow: 8192, maxTokens: 2048, supportsPromptCache: false },
		})
		expect(result).toMatchObject({ contextWindow: 131072, source: "fallback", maxOutputTokens: 2048 })
	})
})
