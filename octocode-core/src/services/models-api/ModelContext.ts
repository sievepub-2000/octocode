import { createHash } from "node:crypto"
import type { ProviderSettings } from "@roo-code/types"
import type { ModelProfile } from "./ModelsApiManager"

export const DEFAULT_CONTEXT_WINDOW = 131_072
export type ModelContext = {
	contextWindow: number
	source: "server" | "configuration" | "catalog" | "fallback"
	maxOutputTokens: number
	warning?: string
}

const valid = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 4_096 && value <= 100_000_000
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export function contextFromModel(value: unknown): number | undefined {
	const model = record(value)
	for (const key of ["max_model_len", "context_length", "contextWindow", "max_context_length", "inputTokenLimit"]) {
		if (valid(model[key])) return model[key]
	}
	const info = record(model.model_info)
	return Object.entries(info).find(([key, value]) => key.endsWith(".context_length") && valid(value))?.[1] as
		| number
		| undefined
}

export function compressionBudget(context: ModelContext, requestedPercent: number) {
	const reserve = Math.max(1_024, Math.ceil(context.contextWindow * 0.05))
	const available = Math.max(1, context.contextWindow - context.maxOutputTokens - reserve)
	const percent =
		requestedPercent === 0
			? 0
			: Math.max(1, Math.min(requestedPercent, Math.floor((100 * available) / context.contextWindow)))
	return { percent, triggerTokens: Math.floor((context.contextWindow * percent) / 100), reserveTokens: reserve }
}

export class ModelContextDiscovery {
	private readonly cache = new Map<string, { expires: number; value: Promise<ModelContext> }>()

	resolve(model: ModelProfile, settings: ProviderSettings = {}, catalogContext?: number): Promise<ModelContext> {
		const key = createHash("sha256")
			.update(JSON.stringify([model.base_url, model.model, model.api_key, settings, catalogContext]))
			.digest("hex")
		const cached = this.cache.get(key)
		if (cached && cached.expires > Date.now()) return cached.value
		// ponytail: 128 recent profile identities; no disk cache or second settings store.
		if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!)
		const value = this.discover(model, settings, catalogContext)
		this.cache.set(key, { expires: Date.now() + 60_000, value })
		return value
	}

	private async discover(
		model: ModelProfile,
		settings: ProviderSettings,
		catalogContext?: number,
	): Promise<ModelContext> {
		let contextWindow = DEFAULT_CONTEXT_WINDOW
		let source: ModelContext["source"] = "fallback"
		let warning: string | undefined
		let outputLimit: number | undefined
		const configured =
			settings.autoContextWindow === false
				? (settings.modelContextWindow ??
					(settings.apiProvider === "openai"
						? settings.openAiCustomModelInfo?.contextWindow
						: settings.apiProvider === "ollama"
							? settings.ollamaNumCtx
							: undefined))
				: undefined
		if (valid(configured)) {
			contextWindow = configured
			source = "configuration"
		} else if (/^https?:\/\//.test(model.base_url)) {
			const candidates = model.base_url
				.split(",")
				.map((url) => url.trim())
				.filter(Boolean)
				.slice(0, 8)
			for (const baseUrl of candidates) {
				try {
					const base = new URL(baseUrl)
					if (base.username || base.password) throw new Error("Credentials in model URL are not supported")
					const ollama = settings.apiProvider === "ollama"
					const endpoint = new URL(base)
					endpoint.pathname = ollama
						? base.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/api/show"
						: base.pathname.replace(/\/$/, "") + "/models"
					const response = await fetch(endpoint, {
						method: ollama ? "POST" : "GET",
						headers: {
							...settings.openAiHeaders,
							...(model.api_key ? { authorization: `Bearer ${model.api_key}` } : {}),
							...(ollama ? { "content-type": "application/json" } : {}),
						},
						...(ollama ? { body: JSON.stringify({ model: model.model }) } : {}),
						signal: AbortSignal.timeout(Math.floor(5_000 / candidates.length)),
						redirect: "error",
					})
					if (!response.ok) {
						await response.body?.cancel()
						throw new Error(`Metadata HTTP ${response.status}`)
					}
					const reader = response.body?.getReader()
					if (!reader) throw new Error("Metadata response has no body")
					const chunks: Uint8Array[] = []
					let size = 0
					try {
						for (;;) {
							const chunk = await reader.read()
							if (chunk.done) break
							size += chunk.value.length
							if (size > 4 * 1024 * 1024) throw new Error("Metadata exceeds 4 MiB")
							chunks.push(chunk.value)
						}
					} finally {
						await reader.cancel()
					}
					const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
					const data = record(body).data
					const selected = ollama
						? body
						: Array.isArray(data)
							? data.find((item) => record(item).id === model.model)
							: undefined
					const detected = contextFromModel(selected)
					if (!detected) throw new Error("Selected model did not report a valid context window")
					const item = record(selected)
					const limit =
						item.max_completion_tokens ??
						item.outputTokenLimit ??
						record(item.top_provider).max_completion_tokens
					if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) outputLimit = limit
					contextWindow = detected
					source = "server"
					warning = undefined
					break
				} catch {
					warning = "无法获取服务端上下文，使用 131072 tokens。"
				}
			}
		}
		if (source === "fallback" && valid(catalogContext)) {
			contextWindow = catalogContext
			source = "catalog"
			warning = undefined
		}
		const requestedOutput =
			settings.modelMaxTokens ??
			(settings.apiProvider === "openai" ? settings.openAiCustomModelInfo?.maxTokens : undefined) ??
			model.max_completion_tokens
		if (source === "fallback" && !warning) warning = "提供商未报告有效上下文，使用 131072 tokens。"
		const maxOutputTokens = Math.min(
			Number.isSafeInteger(requestedOutput) && requestedOutput > 0 ? requestedOutput : 32_768,
			outputLimit ?? Infinity,
			Math.max(1_024, Math.floor(contextWindow / 4)),
		)
		return { contextWindow, source, maxOutputTokens, ...(warning ? { warning } : {}) }
	}
}
