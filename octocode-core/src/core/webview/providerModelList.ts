import {
	type ExtensionMessage,
	type ModelRecord,
	type ProviderModelListSource,
	type ProviderModelsRequestValues,
	type ProviderModelsResponseValues,
	type ProviderName,
	type ProviderSettings,
	type RouterModels,
	MODELS_BY_PROVIDER,
	isProviderName,
	providerIdentifiers,
	zaiApiLineConfigs,
} from "@roo-code/types"

import { type GetModelsOptions, type RouterName, isRouterName } from "../../shared/api"
import { DEFAULT_HEADERS } from "../../api/providers/constants"

/** globalState key holding the last successful remote model list per provider endpoint. */
export const PROVIDER_MODEL_LIST_CACHE_KEY = "providerModelListCache"
export const PROVIDER_MODEL_LIST_CACHE_LIMIT = 50
export const PROVIDER_MODEL_LIST_TIMEOUT_MS = 10_000

const OPENAI_NATIVE_DEFAULT_BASE_URL = "https://api.openai.com/v1"
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
const GEMINI_OPENAI_PATH = "/v1beta/openai"

/**
 * Cloud providers whose handlers talk to an OpenAI-compatible endpoint that is
 * known to expose `GET /models`. Base URLs and key fields mirror the handlers in
 * `src/api/providers/`. Providers whose `/models` endpoint could not be
 * confirmed (friendli, mimo, minimax, zai, qwen-code) intentionally fall back
 * to the static catalog.
 */
const OPENAI_COMPATIBLE_CLOUDS: Partial<
	Record<
		ProviderName,
		{ baseUrl: (config: ProviderSettings) => string; apiKey: (config: ProviderSettings) => string | undefined }
	>
> = {
	[providerIdentifiers.mistral]: { baseUrl: () => "https://api.mistral.ai/v1", apiKey: (c) => c.mistralApiKey },
	[providerIdentifiers.xai]: { baseUrl: () => "https://api.x.ai/v1", apiKey: (c) => c.xaiApiKey },
	[providerIdentifiers.sambanova]: { baseUrl: () => "https://api.sambanova.ai/v1", apiKey: (c) => c.sambaNovaApiKey },
	[providerIdentifiers.fireworks]: {
		baseUrl: () => "https://api.fireworks.ai/inference/v1",
		apiKey: (c) => c.fireworksApiKey,
	},
	[providerIdentifiers.baseten]: { baseUrl: () => "https://inference.baseten.co/v1", apiKey: (c) => c.basetenApiKey },
	[providerIdentifiers.gemini]: {
		baseUrl: (c) => `${trimSlash(c.googleGeminiBaseUrl || GEMINI_DEFAULT_BASE_URL)}${GEMINI_OPENAI_PATH}`,
		apiKey: (c) => c.geminiApiKey,
	},
}

/** Router providers whose fetchers are meaningless without an API key. */
const ROUTER_PROVIDERS_REQUIRING_KEY: ReadonlySet<RouterName> = new Set<RouterName>([
	providerIdentifiers.poe,
	providerIdentifiers.deepseek,
	providerIdentifiers.moonshot,
	providerIdentifiers.kimiCode,
	providerIdentifiers.litellm,
])

type VsCodeLmModel = { vendor?: string; family?: string; version?: string; id?: string }

export interface ProviderModelListDeps {
	getModels: (options: GetModelsOptions) => Promise<ModelRecord>
	flushModels: (options: GetModelsOptions, refresh?: boolean) => Promise<void>
	getOpenAiModels: (baseUrl?: string, apiKey?: string, headers?: Record<string, string>) => Promise<string[]>
	getVsCodeLmModels: () => Promise<VsCodeLmModel[]>
	getKimiCodeAccessToken?: () => Promise<string | null | undefined>
	fetch?: typeof fetch
	timeoutMs?: number
}

export interface ProviderModelListResult {
	models: string[]
	source: Exclude<ProviderModelListSource, "cache">
	error?: string
	/** Full records for router/local providers, so their dedicated pickers can refresh too. */
	modelRecord?: ModelRecord
	vsCodeLmModels?: VsCodeLmModel[]
}

interface CacheEntry {
	models: string[]
	fetchedAt: number
}

type ProviderModelListCache = Record<string, CacheEntry>

interface GlobalStateLike {
	get<T>(key: string): T | undefined
	update(key: string, value: unknown): Thenable<void>
}

export interface ProviderModelListHost {
	context: { globalState: GlobalStateLike }
	postMessageToWebview(message: ExtensionMessage): Promise<void>
}

const trimSlash = (value: string) => value.trim().replace(/\/+$/, "")

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const uniqueSorted = (ids: Iterable<string>) => [...new Set(ids)].filter(Boolean).sort((a, b) => a.localeCompare(b))

export function getCatalogModelIds(provider: ProviderName): string[] {
	const catalog: Partial<Record<ProviderName, { models: string[] }>> = MODELS_BY_PROVIDER
	return [...(catalog[provider]?.models ?? [])]
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function getRouterOptions(provider: RouterName, config: ProviderSettings): GetModelsOptions | undefined {
	switch (provider) {
		case providerIdentifiers.openrouter:
			return { provider, apiKey: config.openRouterApiKey, baseUrl: config.openRouterBaseUrl }
		case providerIdentifiers.vercelAiGateway:
			return { provider }
		case providerIdentifiers.octoCodeGateway:
			return { provider, apiKey: config.octoCodeSessionToken, baseUrl: config.octoCodeGatewayBaseUrl }
		case providerIdentifiers.litellm:
			return config.litellmBaseUrl
				? { provider, apiKey: config.litellmApiKey, baseUrl: config.litellmBaseUrl }
				: undefined
		case providerIdentifiers.requesty:
			return { provider, apiKey: config.requestyApiKey, baseUrl: config.requestyBaseUrl }
		case providerIdentifiers.unbound:
			return { provider, apiKey: config.unboundApiKey }
		case providerIdentifiers.poe:
			return { provider, apiKey: config.poeApiKey, baseUrl: config.poeBaseUrl }
		case providerIdentifiers.deepseek:
			return { provider, apiKey: config.deepSeekApiKey, baseUrl: config.deepSeekBaseUrl }
		case providerIdentifiers.moonshot:
			return { provider, apiKey: config.moonshotApiKey, baseUrl: config.moonshotBaseUrl }
		case providerIdentifiers.opencodeGo:
			return { provider, apiKey: config.opencodeGoApiKey }
		case providerIdentifiers.kenari:
			return { provider, apiKey: config.kenariApiKey }
		case providerIdentifiers.nanogpt:
			return { provider, apiKey: config.nanoGptApiKey }
		case providerIdentifiers.kimiCode:
			return { provider, apiKey: config.kimiCodeApiKey }
		case providerIdentifiers.ollama:
			return { provider, apiKey: config.ollamaApiKey, baseUrl: config.ollamaBaseUrl }
		case providerIdentifiers.lmstudio:
			return { provider, baseUrl: config.lmStudioBaseUrl }
		default:
			return undefined
	}
}

/** Effective endpoint used to scope the persisted list. Never contains credentials. */
export function getProviderModelListBaseUrl(provider: ProviderName, config: ProviderSettings): string {
	switch (provider) {
		case providerIdentifiers.openai:
			return trimSlash(config.openAiBaseUrl ?? "")
		case providerIdentifiers.openaiNative:
			return trimSlash(config.openAiNativeBaseUrl || OPENAI_NATIVE_DEFAULT_BASE_URL)
		case providerIdentifiers.anthropic:
			return trimSlash(config.anthropicBaseUrl || ANTHROPIC_DEFAULT_BASE_URL)
		case providerIdentifiers.zai:
			return zaiApiLineConfigs[config.zaiApiLine ?? "international_coding"].baseUrl
		default: {
			const cloud = OPENAI_COMPATIBLE_CLOUDS[provider]
			if (cloud) {
				return trimSlash(cloud.baseUrl(config))
			}
			if (isRouterName(provider)) {
				return trimSlash(getRouterOptions(provider, config)?.baseUrl ?? "")
			}
			return ""
		}
	}
}

export function getProviderModelListKey(provider: ProviderName, config: ProviderSettings): string {
	return `${provider}|${getProviderModelListBaseUrl(provider, config)}`
}

async function fetchJsonModelIds(
	url: string,
	headers: Record<string, string>,
	deps: ProviderModelListDeps,
): Promise<string[]> {
	const fetchImpl = deps.fetch ?? fetch
	const controller = new AbortController()
	const timeoutMs = deps.timeoutMs ?? PROVIDER_MODEL_LIST_TIMEOUT_MS
	const timer = setTimeout(() => controller.abort(), timeoutMs)

	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { ...DEFAULT_HEADERS, ...headers },
			signal: controller.signal,
		})

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`)
		}

		const body: unknown = await response.json()
		const data =
			body && typeof body === "object" && "data" in body && Array.isArray(body.data) ? body.data : undefined

		if (!data) {
			throw new Error("Unexpected /models response")
		}

		return data
			.map((item: unknown) =>
				item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : "",
			)
			.filter((id: string) => id.length > 0)
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`Request timed out after ${timeoutMs}ms`)
		}
		throw error
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Resolve the model ids a provider currently offers. Never throws: failures
 * yield the static catalog plus an `error` string.
 */
export async function fetchProviderModelIds(
	provider: ProviderName,
	config: ProviderSettings,
	deps: ProviderModelListDeps,
): Promise<ProviderModelListResult> {
	const catalog = (error?: string): ProviderModelListResult => ({
		models: getCatalogModelIds(provider),
		source: "catalog",
		...(error ? { error } : {}),
	})
	const remote = (ids: Iterable<string>, extra: Partial<ProviderModelListResult> = {}): ProviderModelListResult => {
		const models = uniqueSorted(ids)
		return models.length > 0 ? { models, source: "remote", ...extra } : catalog("No models returned")
	}
	const timeoutMs = deps.timeoutMs ?? PROVIDER_MODEL_LIST_TIMEOUT_MS

	try {
		if (isRouterName(provider)) {
			const options = getRouterOptions(provider, config)
			if (!options) {
				return catalog()
			}

			if (provider === providerIdentifiers.kimiCode && config.kimiCodeAuthMethod !== "api-key") {
				options.apiKey = (await deps.getKimiCodeAccessToken?.()) ?? undefined
			}

			if (ROUTER_PROVIDERS_REQUIRING_KEY.has(provider) && !options.apiKey) {
				return catalog()
			}

			await deps.flushModels(options, true)
			const modelRecord = await withTimeout(deps.getModels(options), timeoutMs, `${provider} model list`)
			return remote(Object.keys(modelRecord), { modelRecord })
		}

		switch (provider) {
			case providerIdentifiers.vscodeLm: {
				const vsCodeLmModels = await withTimeout(deps.getVsCodeLmModels(), timeoutMs, "VS Code LM model list")
				return remote(
					vsCodeLmModels
						.filter((model) => model.vendor && model.family)
						.map((model) => `${model.vendor}/${model.family}`),
					{ vsCodeLmModels },
				)
			}
			case providerIdentifiers.openai:
			case providerIdentifiers.openaiNative: {
				const isNative = provider === providerIdentifiers.openaiNative
				const baseUrl = getProviderModelListBaseUrl(provider, config)
				const apiKey = isNative ? config.openAiNativeApiKey : config.openAiApiKey
				if (!baseUrl || (isNative && !apiKey && baseUrl === OPENAI_NATIVE_DEFAULT_BASE_URL)) {
					return catalog()
				}
				const ids = await withTimeout(
					deps.getOpenAiModels(baseUrl, apiKey, isNative ? undefined : config.openAiHeaders),
					timeoutMs,
					`${provider} model list`,
				)
				return remote(ids)
			}
			case providerIdentifiers.anthropic: {
				if (!config.apiKey) {
					return catalog()
				}
				const baseUrl = getProviderModelListBaseUrl(provider, config)
				const useAuthToken = Boolean(config.anthropicBaseUrl && config.anthropicUseAuthToken)
				const headers: Record<string, string> = useAuthToken
					? { Authorization: `Bearer ${config.apiKey}` }
					: { "x-api-key": config.apiKey }
				headers["anthropic-version"] = "2023-06-01"
				return remote(await fetchJsonModelIds(`${baseUrl}/v1/models?limit=1000`, headers, deps))
			}
			default: {
				const cloud = OPENAI_COMPATIBLE_CLOUDS[provider]
				const apiKey = cloud?.apiKey(config)
				if (!cloud || !apiKey) {
					return catalog()
				}
				const ids = await fetchJsonModelIds(
					`${trimSlash(cloud.baseUrl(config))}/models`,
					{ Authorization: `Bearer ${apiKey}` },
					deps,
				)
				return remote(
					provider === providerIdentifiers.gemini ? ids.map((id) => id.replace(/^models\//, "")) : ids,
				)
			}
		}
	} catch (error) {
		return catalog(errorText(error) || "Failed to fetch models")
	}
}

function readCache(host: ProviderModelListHost): ProviderModelListCache {
	const value = host.context.globalState.get<ProviderModelListCache>(PROVIDER_MODEL_LIST_CACHE_KEY)
	return value && typeof value === "object" ? value : {}
}

async function writeCache(host: ProviderModelListHost, key: string, entry: CacheEntry): Promise<void> {
	const next: ProviderModelListCache = { ...readCache(host), [key]: entry }
	const keys = Object.keys(next).sort((a, b) => next[b].fetchedAt - next[a].fetchedAt)
	for (const stale of keys.slice(PROVIDER_MODEL_LIST_CACHE_LIMIT)) {
		delete next[stale]
	}
	await host.context.globalState.update(PROVIDER_MODEL_LIST_CACHE_KEY, next)
}

/**
 * Handle `requestProviderModels`. `refresh: true` queries the provider; otherwise
 * the persisted list (or the static catalog) is returned without network access.
 */
export async function handleRequestProviderModels(
	host: ProviderModelListHost,
	values: Partial<ProviderModelsRequestValues> | undefined,
	deps: ProviderModelListDeps,
): Promise<void> {
	const provider = values?.provider
	if (!provider || !isProviderName(provider)) {
		return
	}

	const config: ProviderSettings = { ...(values?.apiConfiguration ?? {}), apiProvider: provider }
	const key = getProviderModelListKey(provider, config)
	const reply = (response: Omit<ProviderModelsResponseValues, "provider" | "key">) =>
		host.postMessageToWebview({ type: "providerModels", values: { provider, key, ...response } })

	if (values?.refresh !== true) {
		const cached = readCache(host)[key]
		if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
			await reply({ models: cached.models, source: "cache", fetchedAt: cached.fetchedAt })
		} else {
			await reply({ models: getCatalogModelIds(provider), source: "catalog", fetchedAt: 0 })
		}
		return
	}

	const result = await fetchProviderModelIds(provider, config, deps)
	const fetchedAt = Date.now()

	if (result.source === "remote") {
		try {
			await writeCache(host, key, { models: result.models, fetchedAt })
		} catch (error) {
			console.error(`[requestProviderModels] Failed to persist model list for ${key}:`, error)
		}
	}

	// Keep provider-specific pickers (which listen to their legacy messages) in sync.
	if (result.modelRecord && isRouterName(provider)) {
		if (provider === providerIdentifiers.ollama) {
			await host.postMessageToWebview({ type: "ollamaModels", ollamaModels: result.modelRecord })
		} else if (provider === providerIdentifiers.lmstudio) {
			await host.postMessageToWebview({ type: "lmStudioModels", lmStudioModels: result.modelRecord })
		}
		// A single-provider update; consumers merge it (see ExtensionStateContext / useRouterModels).
		const partial: Partial<RouterModels> = { [provider]: result.modelRecord }
		await host.postMessageToWebview({
			type: "routerModels",
			routerModels: partial as RouterModels,
			values: { provider },
		})
	}
	if (result.vsCodeLmModels) {
		await host.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels: result.vsCodeLmModels })
	}

	await reply({
		models: result.models,
		source: result.source,
		fetchedAt,
		...(result.error ? { error: result.error } : {}),
	})
}
