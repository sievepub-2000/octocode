import { vi } from "vitest"
import nock from "nock"

const mocks = vi.hoisted(() => ({
	createMessage: vi.fn(),
	disposeHandler: vi.fn(),
	createModelsApiHandler: vi.fn(),
	getModels: vi.fn(),
	getModelEndpoints: vi.fn(),
}))

vi.mock("../../../api", () => ({
	createModelsApiHandler: mocks.createModelsApiHandler,
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({ getModels: mocks.getModels }))
vi.mock("../../../api/providers/fetchers/modelEndpointCache", () => ({ getModelEndpoints: mocks.getModelEndpoints }))

import { ModelsApiManager, toAnthropicMessages, type ProviderRoute } from "../ModelsApiManager"

const output = { appendLine: vi.fn() }

describe("ModelsApiManager", () => {
	beforeAll(() => nock.enableNetConnect("127.0.0.1"))
	afterAll(() => nock.disableNetConnect())

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.createModelsApiHandler.mockReturnValue({
			createMessage: mocks.createMessage,
			getModel: () => ({ id: "local-qwen", info: { contextWindow: 131072 } }),
			getThoughtSignature: () => "fixture-thought-signature",
			getReasoningDetails: () => [{ type: "reasoning.encrypted", data: "fixture-details" }],
			getEncryptedContent: () => ({ id: "reasoning-item", encrypted_content: "fixture-encrypted" }),
			dispose: mocks.disposeHandler,
		})
	})

	it("resolves effective context for direct HTTP routes", async () => {
		const manager = new ModelsApiManager(output)
		const route: ProviderRoute = {
			model: {
				model: "qwen3.8-27b",
				base_url: "http://192.168.10.2:8000/v1",
				api_backend: "responses",
				context_window: 262_144,
				max_completion_tokens: 32_768,
			},
		}

		const result = await manager.materialize(route, {
			apiProvider: "ollama",
			autoContextWindow: false,
			ollamaNumCtx: 262144,
		})
		expect(result).toMatchObject({ ...route.model, context: { source: "configuration", contextWindow: 262144 } })
		manager.dispose()
	})
	it("keeps the fetched OpenRouter model context when its separate metadata request times out", async () => {
		const modelId = "inclusionai/ling-3.0-flash-sante:free"
		mocks.getModels.mockResolvedValue({ [modelId]: { contextWindow: 262_144, maxTokens: 32_768 } })
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("metadata timeout"))
		mocks.createModelsApiHandler.mockReturnValue({
			getModel: () => ({ id: modelId, info: { contextWindow: 262_144, maxTokens: 32_768 } }),
			ensureModelFetched: async () => undefined,
			dispose: mocks.disposeHandler,
		})
		const manager = new ModelsApiManager(output)
		try {
			const result = await manager.materialize(
				{
					adapter_provider: "openrouter",
					model: {
						model: modelId,
						base_url: "models-api://provider",
						api_backend: "chat_completions",
						context_window: 131_072,
						max_completion_tokens: 32_768,
					},
				},
				{ apiProvider: "openrouter", openRouterModelId: modelId },
			)
			expect(result.context).toMatchObject({ source: "catalog", contextWindow: 262_144 })
			expect(mocks.getModels).toHaveBeenCalledWith({
				provider: "openrouter",
				baseUrl: undefined,
				apiKey: undefined,
			})
			expect(fetch).toHaveBeenCalledTimes(1)
		} finally {
			manager.dispose()
			fetch.mockRestore()
		}
	})
	it.each([true, false])("uses only the selected OpenRouter endpoint metadata (available=%s)", async (available) => {
		const modelId = "vendor/model"
		mocks.getModels.mockResolvedValue({ [modelId]: { contextWindow: 262_144 } })
		mocks.getModelEndpoints.mockResolvedValue(
			available ? { dedicated: { contextWindow: 32_768, maxTokens: 4_096 } } : {},
		)
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: modelId, context_length: 262_144 }] })))
		mocks.createModelsApiHandler.mockReturnValue({
			getModel: () => ({ id: modelId, info: { contextWindow: 32_768, maxTokens: 4_096 } }),
			ensureModelFetched: async () => undefined,
			dispose: mocks.disposeHandler,
		})
		const manager = new ModelsApiManager(output)
		try {
			const result = await manager.materialize(
				{
					adapter_provider: "openrouter",
					model: {
						model: modelId,
						base_url: "models-api://provider",
						api_backend: "chat_completions",
						context_window: 131_072,
						max_completion_tokens: 32_768,
					},
				},
				{ apiProvider: "openrouter", openRouterModelId: modelId, openRouterSpecificProvider: "dedicated" },
			)
			expect(result.context).toMatchObject(
				available
					? { source: "catalog", contextWindow: 32_768, maxOutputTokens: 4_096 }
					: { source: "fallback", contextWindow: 131_072 },
			)
			expect(fetch).not.toHaveBeenCalled()
		} finally {
			manager.dispose()
			fetch.mockRestore()
		}
	})
	it.each([
		{ openAiHeaders: { "x-test": "fixture" } },
		{ openAiUseAzure: true },
		{ openAiStreamingEnabled: false },
		{ modelTemperature: 0.4 },
	])("routes configured OpenAI advanced options through the SDK", async (advanced) => {
		const manager = new ModelsApiManager(output)
		const route: ProviderRoute = {
			model: {
				model: "local-qwen",
				base_url: "http://127.0.0.1:1/v1",
				api_backend: "chat_completions",
				context_window: 131072,
				max_completion_tokens: 4096,
			},
		}
		const settings = {
			apiProvider: "openai" as const,
			openAiModelId: "local-qwen",
			autoContextWindow: false,
			modelContextWindow: 131072,
			...advanced,
		}
		try {
			const model = await manager.materialize(route, settings)
			expect(model.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
			expect(model.base_url).not.toBe(route.model.base_url)
			expect(mocks.createModelsApiHandler).toHaveBeenCalledWith(settings)
			await expect(manager.materialize(route, { ...settings, apiFormat: "responses" })).rejects.toThrow(
				"Chat Completions",
			)
		} finally {
			manager.dispose()
		}
	})

	it("bridges VS Code LM through the same chat-completions harness contract", async () => {
		mocks.createMessage.mockImplementation(async function* () {
			yield { type: "text", text: "done" }
			yield { type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }
			yield { type: "usage", inputTokens: 11, outputTokens: 3 }
		})
		const manager = new ModelsApiManager(output)
		const route: ProviderRoute = {
			model: {
				model: "local-qwen",
				base_url: "vscode-lm://provider",
				api_backend: "chat_completions",
				context_window: 200_000,
				max_completion_tokens: 32_768,
			},
			vs_code_lm_model_selector: { vendor: "local", id: "local-qwen" },
		}

		const model = await manager.materialize(route)
		expect(mocks.createModelsApiHandler).toHaveBeenCalledWith({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "local", id: "local-qwen" },
		})
		const response = await fetch(`${model.base_url}/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${model.api_key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "local-qwen",
				stream: true,
				messages: [
					{ role: "system", content: "Obey the project rules" },
					{ role: "user", content: "Read a.ts" },
				],
				tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
			}),
		})
		const body = await response.text()

		expect(response.status).toBe(200)
		expect(mocks.createMessage).toHaveBeenCalledWith(
			"Obey the project rules",
			[{ role: "user", content: [{ type: "text", text: "Read a.ts" }] }],
			expect.objectContaining({
				tools: [expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) })],
			}),
		)
		expect(body).toContain('"content":"done"')
		expect(body).toContain('"finish_reason":"tool_calls"')
		expect(body).toContain("[DONE]")

		manager.dispose()
		await new Promise((resolve) => setImmediate(resolve))
		expect(mocks.disposeHandler).toHaveBeenCalledTimes(2)
	})

	it("rejects bridge requests with the wrong bearer token", async () => {
		const manager = new ModelsApiManager(output)
		const model = await manager.materialize({
			model: {
				model: "local-qwen",
				base_url: "vscode-lm://provider",
				api_backend: "chat_completions",
				context_window: 200_000,
				max_completion_tokens: 32_768,
			},
			vs_code_lm_model_selector: { id: "local-qwen" },
		})

		const response = await fetch(`${model.base_url}/chat/completions`, {
			method: "POST",
			headers: { authorization: "Bearer wrong", "content-type": "application/json" },
			body: JSON.stringify({ stream: true, messages: [] }),
		})

		expect(response.status).toBe(401)
		manager.dispose()
	})

	it.each(["bedrock", "vertex", "openai-codex"] as const)(
		"bridges %s partial tools and keeps other tasks alive",
		async (apiProvider) => {
			mocks.createMessage.mockImplementation(async function* () {
				yield { type: "tool_call_partial", index: 3, id: "one", name: "read_file", arguments: '{"path":' }
				yield { type: "tool_call_partial", index: 8, id: "two", name: "list_files", arguments: "{}" }
				yield { type: "tool_call_partial", index: 3, arguments: '"a.ts"}' }
			})
			const manager = new ModelsApiManager(output)
			try {
				const route: ProviderRoute = {
					adapter_provider: apiProvider,
					model: {
						model: "local-qwen",
						base_url: "models-api://provider",
						api_backend: "chat_completions",
						context_window: 131072,
						max_completion_tokens: 32768,
					},
				}
				const a = await manager.materialize(route, { apiProvider, apiModelId: "local-qwen" }, "a")
				const b = await manager.materialize(route, { apiProvider, apiModelId: "local-qwen" }, "b")
				expect(a.base_url).not.toBe(b.base_url)
				const fallback = await manager.materialize(
					route,
					{ apiProvider, apiModelId: "local-qwen" },
					"a:fallback:0",
				)
				manager.release("a")
				await expect(fetch(`${fallback.base_url}/models`)).rejects.toThrow()
				const response = await fetch(`${b.base_url}/chat/completions`, {
					method: "POST",
					headers: { authorization: `Bearer ${b.api_key}` },
					body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "tools" }] }),
				})
				const result = await response.json()
				expect(response.status).toBe(200)
				expect(result.choices[0].message.tool_calls).toEqual([
					{
						index: 0,
						id: "one",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"a.ts"}' },
					},
					{ index: 1, id: "two", type: "function", function: { name: "list_files", arguments: "{}" } },
				])
				expect(mocks.createMessage).toHaveBeenCalledWith(
					expect.any(String),
					expect.any(Array),
					expect.objectContaining({ taskId: "b", abortSignal: expect.any(AbortSignal) }),
				)
			} finally {
				manager.dispose()
			}
		},
	)

	it("preserves images and rejects malformed tool JSON instead of silently replacing it", () => {
		const converted = toAnthropicMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
				],
			},
		])
		expect(converted.messages[0].content).toEqual([
			{ type: "text", text: "describe" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
		])
		expect(() =>
			toAnthropicMessages([
				{
					role: "assistant",
					tool_calls: [{ id: "call", function: { name: "write_file", arguments: "broken" } }],
				},
			]),
		).toThrow()
		expect(() =>
			toAnthropicMessages([
				{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///private.png" } }] },
			]),
		).toThrow("Unsupported image")
	})

	it("cancels the upstream request when the harness disconnects", async () => {
		let upstreamSignal: AbortSignal | undefined
		let finished = false
		mocks.createMessage.mockImplementation(async function* (_system, _messages, metadata) {
			upstreamSignal = metadata.abortSignal
			try {
				yield { type: "text", text: "started" }
				await new Promise<void>((resolve) =>
					metadata.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
				)
			} finally {
				finished = true
			}
		})
		const manager = new ModelsApiManager(output)
		try {
			const model = await manager.materialize(
				{
					adapter_provider: "bedrock",
					model: {
						model: "local-qwen",
						base_url: "models-api://provider",
						api_backend: "chat_completions",
						context_window: 131072,
						max_completion_tokens: 32768,
					},
				},
				{ apiProvider: "bedrock" },
				"cancel",
			)
			const response = await fetch(`${model.base_url}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${model.api_key}` },
				body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "wait" }] }),
			})
			await response.body!.cancel()
			await vi.waitFor(() => {
				expect(upstreamSignal?.aborted).toBe(true)
				expect(finished).toBe(true)
			})
		} finally {
			manager.dispose()
		}
	})

	it.each(["bedrock", "openai-codex"] as const)(
		"preserves signed tool reasoning and counts %s cached input once",
		async (apiProvider) => {
			mocks.createMessage
				.mockImplementationOnce(async function* () {
					yield { type: "reasoning", text: "plan" }
					yield { type: "thinking_complete", signature: "signed-plan" }
					yield { type: "tool_call", id: "signed-call", name: "read_file", arguments: "{}" }
					yield {
						type: "usage",
						inputTokens: 100,
						cacheReadTokens: 20,
						cacheWriteTokens: 10,
						outputTokens: 5,
					}
				})
				.mockImplementationOnce(async function* () {
					yield { type: "text", text: "done" }
				})
			const manager = new ModelsApiManager(output)
			try {
				const model = await manager.materialize(
					{
						adapter_provider: apiProvider,
						model: {
							model: "local-qwen",
							base_url: "models-api://provider",
							api_backend: "chat_completions",
							context_window: 131072,
							max_completion_tokens: 32768,
						},
					},
					{ apiProvider },
					"reasoning",
				)
				const post = (messages: unknown[]) =>
					fetch(`${model.base_url}/chat/completions`, {
						method: "POST",
						headers: { authorization: `Bearer ${model.api_key}` },
						body: JSON.stringify({ stream: false, messages }),
					})
				const first = await (await post([{ role: "user", content: "read" }])).json()
				expect(first.usage.prompt_tokens).toBe(apiProvider === "bedrock" ? 130 : 100)
				await (
					await post([
						{ role: "user", content: "read" },
						{ role: "assistant", tool_calls: first.choices[0].message.tool_calls },
						{ role: "tool", tool_call_id: "signed-call", content: "contents" },
					])
				).json()
				expect(mocks.createMessage.mock.calls[1][1][1].content[0]).toEqual({
					type: "thinking",
					thinking: "plan",
					signature: "signed-plan",
				})
				expect(mocks.createMessage.mock.calls[1][2]).toMatchObject({
					toolThoughtSignatures: { "signed-call": "fixture-thought-signature" },
					toolReasoningDetails: { "signed-call": [{ type: "reasoning.encrypted", data: "fixture-details" }] },
					toolEncryptedContent: {
						"signed-call": { id: "reasoning-item", encrypted_content: "fixture-encrypted" },
					},
				})
			} finally {
				manager.dispose()
			}
		},
	)
})
