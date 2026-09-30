import type { ExtensionMessage, ModelInfo, ModelRecord, ProviderSettings } from "@roo-code/types"
import { MODELS_BY_PROVIDER } from "@roo-code/types"

import {
	PROVIDER_MODEL_LIST_CACHE_KEY,
	type ProviderModelListDeps,
	type ProviderModelListHost,
	fetchProviderModelIds,
	getProviderModelListKey,
	handleRequestProviderModels,
} from "../providerModelList"

const info: ModelInfo = { contextWindow: 1000, supportsPromptCache: false }

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function makeDeps(overrides: Partial<ProviderModelListDeps> = {}) {
	const getModels = vi.fn<ProviderModelListDeps["getModels"]>(async () => ({ "router/a": info, "router/b": info }))
	const flushModels = vi.fn<ProviderModelListDeps["flushModels"]>(async () => {})
	const getOpenAiModels = vi.fn<ProviderModelListDeps["getOpenAiModels"]>(async () => ["gpt-x", "gpt-y"])
	const getVsCodeLmModels = vi.fn<ProviderModelListDeps["getVsCodeLmModels"]>(async () => [
		{ vendor: "copilot", family: "gpt-4o" },
	])
	const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ id: "remote-1" }, { id: "remote-2" }] }))
	const deps: ProviderModelListDeps = {
		getModels,
		flushModels,
		getOpenAiModels,
		getVsCodeLmModels,
		fetch: fetchMock,
		timeoutMs: 1000,
		...overrides,
	}
	return { deps, getModels, flushModels, getOpenAiModels, getVsCodeLmModels, fetchMock }
}

function makeHost(initial: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(initial))
	const messages: ExtensionMessage[] = []
	const host: ProviderModelListHost = {
		context: {
			globalState: {
				get: <T>(key: string) => store.get(key) as T | undefined,
				update: async (key: string, value: unknown) => {
					store.set(key, value)
				},
			},
		},
		postMessageToWebview: async (message) => {
			messages.push(message)
		},
	}
	return { host, store, messages }
}

const headersOf = (fetchMock: ReturnType<typeof makeDeps>["fetchMock"]) => {
	const init = fetchMock.mock.calls[0]?.[1]
	return (init?.headers ?? {}) as Record<string, string>
}

describe("fetchProviderModelIds", () => {
	it("flushes and reads router providers with their credentials", async () => {
		const { deps, getModels, flushModels } = makeDeps()
		const config: ProviderSettings = { openRouterApiKey: "or-key", openRouterBaseUrl: "https://or.example/api/v1" }

		const result = await fetchProviderModelIds("openrouter", config, deps)

		const expected = { provider: "openrouter", apiKey: "or-key", baseUrl: "https://or.example/api/v1" }
		expect(flushModels).toHaveBeenCalledWith(expected, true)
		expect(getModels).toHaveBeenCalledWith(expected)
		expect(result).toMatchObject({ models: ["router/a", "router/b"], source: "remote" })
		expect(result.modelRecord).toBeDefined()
	})

	it("uses the local fetcher path for ollama", async () => {
		const { deps, getModels } = makeDeps()
		await fetchProviderModelIds("ollama", { ollamaBaseUrl: "http://box:11434" }, deps)
		expect(getModels).toHaveBeenCalledWith({ provider: "ollama", apiKey: undefined, baseUrl: "http://box:11434" })
	})

	it("returns the catalog without calling the router when a required key is missing", async () => {
		const { deps, getModels } = makeDeps()
		const result = await fetchProviderModelIds("deepseek", {}, deps)
		expect(getModels).not.toHaveBeenCalled()
		expect(result).toEqual({ models: MODELS_BY_PROVIDER.deepseek.models, source: "catalog" })
	})

	it("uses getOpenAiModels with the configured base URL and headers for openai", async () => {
		const { deps, getOpenAiModels } = makeDeps()
		const result = await fetchProviderModelIds(
			"openai",
			{ openAiBaseUrl: "http://localhost:8080/v1/", openAiApiKey: "k", openAiHeaders: { "X-A": "1" } },
			deps,
		)
		expect(getOpenAiModels).toHaveBeenCalledWith("http://localhost:8080/v1", "k", { "X-A": "1" })
		expect(result).toEqual({ models: ["gpt-x", "gpt-y"], source: "remote" })
	})

	it("defaults openai-native to the official endpoint", async () => {
		const { deps, getOpenAiModels } = makeDeps()
		await fetchProviderModelIds("openai-native", { openAiNativeApiKey: "sk" }, deps)
		expect(getOpenAiModels).toHaveBeenCalledWith("https://api.openai.com/v1", "sk", undefined)
	})

	it("returns catalog for openai-native without a key on the official endpoint", async () => {
		const { deps, getOpenAiModels } = makeDeps()
		const result = await fetchProviderModelIds("openai-native", {}, deps)
		expect(getOpenAiModels).not.toHaveBeenCalled()
		expect(result.source).toBe("catalog")
		expect(result.models).toEqual(MODELS_BY_PROVIDER["openai-native"].models)
	})

	it("reports an error when an OpenAI endpoint returns nothing", async () => {
		const { deps } = makeDeps({ getOpenAiModels: async () => [] })
		const result = await fetchProviderModelIds("openai", { openAiBaseUrl: "http://x/v1" }, deps)
		expect(result).toEqual({ models: [], source: "catalog", error: "No models returned" })
	})

	it("sends Anthropic headers to /v1/models", async () => {
		const { deps, fetchMock } = makeDeps()
		const result = await fetchProviderModelIds("anthropic", { apiKey: "ant-key" }, deps)
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/models?limit=1000")
		expect(headersOf(fetchMock)).toMatchObject({ "x-api-key": "ant-key", "anthropic-version": "2023-06-01" })
		expect(headersOf(fetchMock)).not.toHaveProperty("Authorization")
		expect(result).toEqual({ models: ["remote-1", "remote-2"], source: "remote" })
	})

	it("uses a bearer token for Anthropic-compatible endpoints configured for auth tokens", async () => {
		const { deps, fetchMock } = makeDeps()
		await fetchProviderModelIds(
			"anthropic",
			{ apiKey: "tok", anthropicBaseUrl: "https://proxy.example/", anthropicUseAuthToken: true },
			deps,
		)
		expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/v1/models?limit=1000")
		expect(headersOf(fetchMock)).toMatchObject({ Authorization: "Bearer tok" })
	})

	it("queries OpenAI-compatible clouds with a bearer key and strips Gemini prefixes", async () => {
		const geminiFetch = vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ id: "models/gemini-9" }] }))
		const { deps } = makeDeps({ fetch: geminiFetch })
		const result = await fetchProviderModelIds("gemini", { geminiApiKey: "g" }, deps)
		expect(result.models).toEqual(["gemini-9"])
		expect(geminiFetch.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models")

		const xai = makeDeps()
		await fetchProviderModelIds("xai", { xaiApiKey: "x" }, xai.deps)
		expect(xai.fetchMock.mock.calls[0][0]).toBe("https://api.x.ai/v1/models")
		expect(headersOf(xai.fetchMock)).toMatchObject({ Authorization: "Bearer x" })
	})

	it("falls back to the static catalog for providers without a list endpoint", async () => {
		const { deps, fetchMock, getModels } = makeDeps()
		for (const provider of ["bedrock", "vertex", "openai-codex"] as const) {
			const result = await fetchProviderModelIds(provider, {}, deps)
			expect(result).toEqual({ models: MODELS_BY_PROVIDER[provider].models, source: "catalog" })
		}
		expect(fetchMock).not.toHaveBeenCalled()
		expect(getModels).not.toHaveBeenCalled()
	})

	it("returns catalog plus error on network failure and never throws", async () => {
		const { deps } = makeDeps({ fetch: vi.fn<typeof fetch>(async () => jsonResponse({}, 401)) })
		const result = await fetchProviderModelIds("mistral", { mistralApiKey: "m" }, deps)
		expect(result.source).toBe("catalog")
		expect(result.models).toEqual(MODELS_BY_PROVIDER.mistral.models)
		expect(result.error).toContain("401")

		const failing = makeDeps({
			getModels: async (): Promise<ModelRecord> => {
				throw new Error("boom")
			},
		})
		await expect(fetchProviderModelIds("requesty", {}, failing.deps)).resolves.toEqual({
			models: [],
			source: "catalog",
			error: "boom",
		})
	})

	it("times out slow requests", async () => {
		const { deps } = makeDeps({
			timeoutMs: 10,
			getOpenAiModels: () => new Promise<string[]>(() => {}),
		})
		const result = await fetchProviderModelIds("openai", { openAiBaseUrl: "http://slow/v1" }, deps)
		expect(result.source).toBe("catalog")
		expect(result.error).toMatch(/timed out/)
	})
})

describe("handleRequestProviderModels", () => {
	const anthropicConfig: ProviderSettings = { apiKey: "secret-ant-key" }

	it("fetches on refresh, persists the list without credentials, and replies", async () => {
		const { deps } = makeDeps()
		const { host, store, messages } = makeHost()

		await handleRequestProviderModels(
			host,
			{ provider: "anthropic", apiConfiguration: anthropicConfig, refresh: true },
			deps,
		)

		const key = getProviderModelListKey("anthropic", anthropicConfig)
		expect(key).toBe("anthropic|https://api.anthropic.com")
		const cache = store.get(PROVIDER_MODEL_LIST_CACHE_KEY)
		expect(cache).toEqual({ [key]: { models: ["remote-1", "remote-2"], fetchedAt: expect.any(Number) } })
		expect(JSON.stringify(cache)).not.toContain("secret-ant-key")

		const reply = messages.find((m) => m.type === "providerModels")
		expect(reply?.values).toMatchObject({
			provider: "anthropic",
			key,
			models: ["remote-1", "remote-2"],
			source: "remote",
		})
	})

	it("serves the cache when refresh is not requested", async () => {
		const { deps, fetchMock } = makeDeps()
		const key = getProviderModelListKey("anthropic", anthropicConfig)
		const { host, messages } = makeHost({
			[PROVIDER_MODEL_LIST_CACHE_KEY]: { [key]: { models: ["cached-1"], fetchedAt: 42 } },
		})

		await handleRequestProviderModels(
			host,
			{ provider: "anthropic", apiConfiguration: anthropicConfig, refresh: false },
			deps,
		)

		expect(fetchMock).not.toHaveBeenCalled()
		expect(messages).toEqual([
			{
				type: "providerModels",
				values: { provider: "anthropic", key, models: ["cached-1"], source: "cache", fetchedAt: 42 },
			},
		])
	})

	it("refresh bypasses an existing cache entry", async () => {
		const { deps, fetchMock } = makeDeps()
		const key = getProviderModelListKey("anthropic", anthropicConfig)
		const { host, messages } = makeHost({
			[PROVIDER_MODEL_LIST_CACHE_KEY]: { [key]: { models: ["cached-1"], fetchedAt: 42 } },
		})

		await handleRequestProviderModels(
			host,
			{ provider: "anthropic", apiConfiguration: anthropicConfig, refresh: true },
			deps,
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(messages.at(-1)?.values).toMatchObject({ source: "remote", models: ["remote-1", "remote-2"] })
	})

	it("replies with the catalog, without network, when nothing is cached", async () => {
		const { deps, fetchMock } = makeDeps()
		const { host, messages } = makeHost()
		await handleRequestProviderModels(host, { provider: "anthropic", apiConfiguration: anthropicConfig }, deps)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(messages[0].values).toMatchObject({ source: "catalog", models: MODELS_BY_PROVIDER.anthropic.models })
	})

	it("does not persist failed fetches and includes the error", async () => {
		const { deps } = makeDeps({ fetch: vi.fn<typeof fetch>(async () => jsonResponse({}, 500)) })
		const { host, store, messages } = makeHost()
		await handleRequestProviderModels(
			host,
			{ provider: "anthropic", apiConfiguration: anthropicConfig, refresh: true },
			deps,
		)
		expect(store.has(PROVIDER_MODEL_LIST_CACHE_KEY)).toBe(false)
		expect(messages[0].values).toMatchObject({ source: "catalog", error: expect.stringContaining("500") })
	})

	it("also posts legacy list messages so dedicated pickers refresh", async () => {
		const { deps } = makeDeps()
		const { host, messages } = makeHost()
		await handleRequestProviderModels(
			host,
			{ provider: "ollama", apiConfiguration: { ollamaBaseUrl: "http://o" }, refresh: true },
			deps,
		)
		expect(messages.map((m) => m.type)).toEqual(["ollamaModels", "routerModels", "providerModels"])
		expect(messages[1]).toMatchObject({
			values: { provider: "ollama" },
			routerModels: { ollama: expect.any(Object) },
		})
	})

	it("caps the cache size", async () => {
		const { deps } = makeDeps()
		const seeded = Object.fromEntries(
			Array.from({ length: 60 }, (_, i) => [`openai|http://h${i}`, { models: ["m"], fetchedAt: i + 1 }]),
		)
		const { host, store } = makeHost({ [PROVIDER_MODEL_LIST_CACHE_KEY]: seeded })
		await handleRequestProviderModels(
			host,
			{ provider: "anthropic", apiConfiguration: anthropicConfig, refresh: true },
			deps,
		)
		const cache = store.get(PROVIDER_MODEL_LIST_CACHE_KEY) as Record<string, unknown>
		expect(Object.keys(cache)).toHaveLength(50)
		expect(cache).toHaveProperty("anthropic|https://api.anthropic.com")
		expect(cache).not.toHaveProperty("openai|http://h0")
	})

	it("ignores unknown providers", async () => {
		const { deps } = makeDeps()
		const { host, messages } = makeHost()
		await handleRequestProviderModels(host, { refresh: true }, deps)
		expect(messages).toEqual([])
	})
})
