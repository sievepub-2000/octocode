import { randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Anthropic } from "@octocode/sdk"
import type OpenAI from "openai"
import {
	getModelId,
	isAzureOpenAiBaseUrl,
	isAzureAiInferenceBaseUrl,
	OPENROUTER_DEFAULT_PROVIDER_NAME,
	type ModelInfo,
	type ProviderSettings,
} from "@roo-code/types"
import { ModelContextDiscovery, type ModelContext } from "./ModelContext"
import { SpeechProvider } from "./SpeechProvider"

import { createModelsApiHandler, type ApiHandler } from "../../api"
import { getModels } from "../../api/providers/fetchers/modelCache"
import { getModelEndpoints } from "../../api/providers/fetchers/modelEndpointCache"

export type ModelProfile = {
	model: string
	base_url: string
	api_key?: string
	api_backend: "chat_completions" | "responses" | "messages"
	context_window: number
	max_completion_tokens: number
	context?: ModelContext
}

type VsCodeLmModelSelector = {
	vendor?: string
	family?: string
	version?: string
	id?: string
}

export type ProviderRoute = {
	model: ModelProfile
	adapter_provider?: string
	vs_code_lm_model_selector?: VsCodeLmModelSelector
}

type Output = Pick<{ appendLine(value: string): void }, "appendLine">
type ToolReasoning = {
	blocks: Anthropic.Messages.ThinkingBlockParam[]
	thoughtSignature?: string
	reasoningDetails?: unknown[]
	encryptedContent?: { encrypted_content: string; id?: string }
}

type ChatRequest = {
	model?: string
	stream?: boolean
	messages?: Array<Record<string, unknown>>
	tools?: OpenAI.Chat.ChatCompletionTool[]
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	parallel_tool_calls?: boolean
}

export class ModelsApiManager {
	readonly speech = new SpeechProvider()
	private readonly bridges = new Map<string, Promise<{ server: Server; model: ModelProfile }>>()
	private readonly contexts = new ModelContextDiscovery()

	constructor(private readonly output: Output) {}

	async materialize(
		route: ProviderRoute,
		settings: ProviderSettings = {},
		taskId: string = randomUUID(),
		sessionId: string = taskId,
	): Promise<ModelProfile> {
		if (
			settings.apiProvider === "openai" &&
			(Object.keys(settings.openAiHeaders ?? {}).length > 0 ||
				isAzureOpenAiBaseUrl(settings.openAiBaseUrl, settings.openAiUseAzure) ||
				isAzureAiInferenceBaseUrl(settings.openAiBaseUrl) ||
				settings.openAiStreamingEnabled === false ||
				settings.openAiR1FormatEnabled ||
				settings.enableReasoningEffort ||
				settings.modelTemperature != null ||
				settings.openAiCustomModelInfo?.supportsPromptCache)
		) {
			if (settings.apiFormat && settings.apiFormat !== "chat_completions")
				throw new Error("OpenAI 高级选项使用 Chat Completions 协议，请调整请求协议。")
			route = { ...route, adapter_provider: "openai" }
		}
		if (!route.adapter_provider && route.model.base_url !== "vscode-lm://provider") {
			const context = await this.contexts.resolve(route.model, settings)
			return {
				...route.model,
				context_window: context.contextWindow,
				max_completion_tokens: context.maxOutputTokens,
				context,
			}
		}
		const existing = this.bridges.get(taskId)
		if (existing) return (await existing).model
		const creation = this.createBridge(route, settings, taskId, sessionId)
		this.bridges.set(taskId, creation)
		try {
			return (await creation).model
		} catch (error) {
			if (this.bridges.get(taskId) === creation) this.bridges.delete(taskId)
			throw error
		}
	}

	private async createBridge(route: ProviderRoute, settings: ProviderSettings, taskId: string, sessionId: string) {
		const selector = route.vs_code_lm_model_selector
		if (!route.adapter_provider && (!selector || !Object.values(selector).some(Boolean)))
			throw new Error("VS Code LM model selector is required")
		const token = randomBytes(32).toString("hex")
		const configuration: ProviderSettings = route.adapter_provider
			? settings
			: { ...settings, apiProvider: "vscode-lm", vsCodeLmModelSelector: selector }
		if (route.adapter_provider && configuration.apiProvider !== route.adapter_provider)
			throw new Error("Adapter provider does not match the task configuration")
		const metadata = createModelsApiHandler(configuration)
		let selected: ReturnType<ApiHandler["getModel"]>
		let context: ModelContext
		try {
			await metadata.ensureModelFetched?.()
			selected = metadata.getModel()
			const requestedModel = getModelId(configuration)
			if (
				requestedModel &&
				configuration.apiProvider !== "bedrock" &&
				requestedModel.replace(/:thinking$/, "") !== selected.id
			)
				throw new Error("Selected model is not supported by this provider adapter")
			const metadataModel = {
				...route.model,
				model: selected.id,
				...(configuration.apiProvider === "openrouter"
					? {
							base_url: configuration.openRouterBaseUrl || "https://openrouter.ai/api/v1",
							api_key: configuration.openRouterApiKey,
						}
					: {}),
				...(configuration.apiProvider === "ollama"
					? {
							base_url: configuration.ollamaBaseUrl || "http://localhost:11434",
							api_key: configuration.ollamaApiKey,
						}
					: {}),
			}
			const staticCatalog = [
				"bedrock",
				"vertex",
				"openai-codex",
				"vscode-lm",
				"sambanova",
				"fireworks",
				"friendli",
				"baseten",
				"mimo",
			].includes(configuration.apiProvider ?? "")
			let openRouterInfo: ModelInfo | undefined
			const endpoint = configuration.openRouterSpecificProvider
			const specificEndpoint =
				configuration.apiProvider === "openrouter" && endpoint && endpoint !== OPENROUTER_DEFAULT_PROVIDER_NAME
			if (configuration.apiProvider === "openrouter") {
				try {
					openRouterInfo = specificEndpoint
						? (
								await getModelEndpoints({
									router: "openrouter",
									modelId: selected.id,
									endpoint,
									baseUrl: configuration.openRouterBaseUrl,
									apiKey: configuration.openRouterApiKey,
								})
							)[endpoint]
						: (
								await getModels({
									provider: "openrouter",
									baseUrl: configuration.openRouterBaseUrl,
									apiKey: configuration.openRouterApiKey,
								})
							)[selected.id]
				} catch {
					openRouterInfo = undefined
				}
			}
			context = await this.contexts.resolve(
				// A parent /models response cannot describe a pinned endpoint's limits.
				specificEndpoint ? { ...metadataModel, base_url: "models-api://endpoint" } : metadataModel,
				configuration,
				openRouterInfo?.contextWindow ??
					(staticCatalog
						? (metadata.getCondenseContextWindow?.() ?? selected.info.contextWindow)
						: undefined),
			)
			const outputLimit = openRouterInfo?.maxTokens ?? (staticCatalog ? selected.info.maxTokens : undefined)
			if (outputLimit && outputLimit > 0)
				context = { ...context, maxOutputTokens: Math.min(context.maxOutputTokens, outputLimit) }
		} finally {
			disposeHandler(metadata)
		}
		const createHandler = () =>
			createModelsApiHandler({
				...configuration,
				modelMaxTokens: context.maxOutputTokens,
				...(configuration.apiProvider === "ollama" ? { ollamaNumCtx: context.contextWindow } : {}),
				...(configuration.apiProvider === "openai" ? { includeMaxTokens: true } : {}),
			})
		const thinking = new Map<string, ToolReasoning>()
		const cacheExcluded =
			configuration.apiProvider === "bedrock" ||
			(configuration.apiProvider === "vertex" && selected.id.includes("claude"))
		const server = createServer(
			(request, response) =>
				void this.handle(request, response, token, createHandler, taskId, thinking, cacheExcluded, sessionId),
		)
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject)
				resolve()
			})
		})

		const port = (server.address() as AddressInfo).port
		const model: ModelProfile = {
			...route.model,
			model: selected.id,
			context_window: context.contextWindow,
			max_completion_tokens: context.maxOutputTokens,
			context,
			base_url: `http://127.0.0.1:${port}/v1`,
			api_key: token,
			api_backend: "chat_completions",
		}
		this.output.appendLine(`[Models API] ${configuration.apiProvider} adapter ready for task ${taskId}`)
		return { server, model }
	}

	dispose(): void {
		this.speech.dispose()
		for (const taskId of this.bridges.keys()) this.release(taskId)
	}

	release(taskId: string): void {
		for (const key of [...this.bridges.keys()]) if (key.startsWith(`${taskId}:`)) this.release(key)
		const bridge = this.bridges.get(taskId)
		this.bridges.delete(taskId)
		void bridge
			?.then(({ server }) => {
				server.closeAllConnections()
				server.close()
			})
			.catch(() => undefined)
	}

	private async handle(
		request: IncomingMessage,
		response: ServerResponse,
		token: string,
		createHandler: () => ApiHandler,
		taskId: string,
		thinking: Map<string, ToolReasoning>,
		cacheExcluded: boolean,
		sessionId: string,
	): Promise<void> {
		let handler: ApiHandler | undefined
		const abort = new AbortController()
		const closed = () => {
			if (!response.writableEnded) abort.abort()
		}
		response.once("close", closed)
		try {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				return json(response, 404, { error: { message: "Models API route not found" } })
			}
			if (request.headers.authorization !== `Bearer ${token}`) {
				return json(response, 401, { error: { message: "Invalid Models API token" } })
			}

			const body = await readJson(request)
			const { systemPrompt, messages } = toAnthropicMessages(body.messages)
			for (const message of messages) {
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue
				const call = message.content.find((block) => block.type === "tool_use")
				if (call?.type === "tool_use" && thinking.has(call.id))
					message.content.unshift(...thinking.get(call.id)!.blocks)
			}
			handler = createHandler()
			if (body.stream)
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive",
				})

			const calls = new Map<number, { id: string; name: string; arguments: string }>()
			let text = ""
			let thought = ""
			const signedThoughts: Anthropic.Messages.ThinkingBlockParam[] = []
			let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
			const emit = (value: unknown) => {
				if (body.stream && !abort.signal.aborted) sse(response, value)
			}
			for await (const chunk of handler.createMessage(systemPrompt, messages, {
				taskId: sessionId,
				toolThoughtSignatures: Object.fromEntries(
					[...thinking].flatMap(([id, state]) =>
						state.thoughtSignature ? [[id, state.thoughtSignature]] : [],
					),
				),
				toolReasoningDetails: Object.fromEntries(
					[...thinking].flatMap(([id, state]) =>
						state.reasoningDetails ? [[id, state.reasoningDetails]] : [],
					),
				),
				toolEncryptedContent: Object.fromEntries(
					[...thinking].flatMap(([id, state]) =>
						state.encryptedContent ? [[id, state.encryptedContent]] : [],
					),
				),
				abortSignal: abort.signal,
				suppressPreviousResponseId: true,
				tools: body.tools,
				tool_choice: body.tool_choice,
				parallelToolCalls: body.parallel_tool_calls,
			})) {
				if (abort.signal.aborted) break
				if (chunk.type === "text") {
					text += chunk.text
					emit(completionChunk(body.model, { content: chunk.text }))
				} else if (chunk.type === "error") {
					throw new Error(chunk.message)
				} else if (chunk.type === "reasoning") {
					thought += chunk.text
					if (chunk.signature) {
						signedThoughts.push({ type: "thinking", thinking: thought, signature: chunk.signature })
						thought = ""
					}
					emit(completionChunk(body.model, { reasoning_content: chunk.text }))
				} else if (chunk.type === "thinking_complete") {
					signedThoughts.push({ type: "thinking", thinking: thought, signature: chunk.signature })
					thought = ""
				} else if (chunk.type === "tool_call_partial") {
					const previous = calls.get(chunk.index) ?? { id: "", name: "", arguments: "" }
					calls.set(chunk.index, {
						id: chunk.id ?? previous.id,
						name: chunk.name ?? previous.name,
						arguments: previous.arguments + (chunk.arguments ?? ""),
					})
				} else if (chunk.type === "tool_call_start") {
					calls.set(calls.size, { id: chunk.id, name: chunk.name, arguments: "" })
				} else if (chunk.type === "tool_call_delta") {
					const call = [...calls.values()].find((call) => call.id === chunk.id)
					if (!call) throw new Error("Tool argument delta has no matching tool call")
					call.arguments += chunk.delta
				} else if (chunk.type === "tool_call") {
					const index = [...calls].find(([, call]) => call.id === chunk.id)?.[0] ?? calls.size
					calls.set(index, { id: chunk.id, name: chunk.name, arguments: chunk.arguments })
				} else if (chunk.type === "usage") {
					usage = {
						prompt_tokens:
							chunk.inputTokens +
							(cacheExcluded ? (chunk.cacheReadTokens ?? 0) + (chunk.cacheWriteTokens ?? 0) : 0),
						completion_tokens: chunk.outputTokens,
						total_tokens: 0,
					}
					usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
					emit({
						...completionChunk(body.model, {}, null),
						usage,
					})
				}
			}
			if (abort.signal.aborted) return
			const tools = [...calls.values()].map((call, index) => {
				if (!call.id || !call.name) throw new Error("Provider returned an incomplete tool call")
				parseArguments(call.arguments)
				return {
					index,
					id: call.id,
					type: "function",
					function: { name: call.name, arguments: call.arguments || "{}" },
				}
			})
			const finish = tools.length ? "tool_calls" : "stop"
			if (tools.length) {
				const retained = new Set(
					messages.flatMap((message) =>
						Array.isArray(message.content)
							? message.content.filter((block) => block.type === "tool_use").map((block) => block.id)
							: [],
					),
				)
				for (const tool of tools) {
					retained.add(tool.id)
					thinking.set(tool.id, {
						blocks: signedThoughts,
						thoughtSignature: handler.getThoughtSignature?.(),
						reasoningDetails: handler.getReasoningDetails?.(),
						encryptedContent: handler.getEncryptedContent?.(),
					})
				}
				for (const id of thinking.keys()) if (!retained.has(id)) thinking.delete(id)
			}
			if (!body.stream)
				return json(response, 200, {
					id: randomUUID(),
					object: "chat.completion",
					model: body.model,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: text,
								...(tools.length ? { tool_calls: tools } : {}),
							},
							finish_reason: finish,
						},
					],
					usage,
				})
			if (tools.length) emit(completionChunk(body.model, { tool_calls: tools }))
			emit(completionChunk(body.model, {}, finish))
			response.end("data: [DONE]\n\n")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (abort.signal.aborted) return
			this.output.appendLine(`[Models API] Provider request failed for task ${taskId}`)
			if (!response.headersSent) return json(response, 400, { error: { message } })
			sse(response, { error: { message } })
			response.end("data: [DONE]\n\n")
		} finally {
			response.off("close", closed)
			if (handler) disposeHandler(handler)
		}
	}
}

function disposeHandler(handler: ApiHandler): void {
	if ("dispose" in handler && typeof handler.dispose === "function") handler.dispose()
}

function completionChunk(model = "vscode-lm", delta: Record<string, unknown>, finish_reason: string | null = null) {
	return {
		id: "chatcmpl-octocode",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason }],
	}
}

function sse(response: ServerResponse, value: unknown): void {
	response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
	response.end(JSON.stringify(value))
}

async function readJson(request: IncomingMessage): Promise<ChatRequest> {
	let size = 0
	const chunks: Buffer[] = []
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += buffer.length
		if (size > 16 * 1024 * 1024) throw new Error("Models API request exceeds 16 MiB")
		chunks.push(buffer)
	}
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Models API body must be an object")
	return value as ChatRequest
}

export function toAnthropicMessages(messages: ChatRequest["messages"]): {
	systemPrompt: string
	messages: Anthropic.Messages.MessageParam[]
} {
	const system: string[] = []
	const converted: Anthropic.Messages.MessageParam[] = []
	for (const message of messages ?? []) {
		const role = message.role
		if (role === "system" || role === "developer") {
			system.push(textContent(message.content))
		} else if (role === "user") {
			converted.push({ role: "user", content: userContent(message.content) })
		} else if (role === "assistant") {
			const content: Anthropic.Messages.ContentBlockParam[] = []
			const text = textContent(message.content)
			if (text) content.push({ type: "text", text })
			for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
				if (!call || typeof call !== "object") continue
				const item = call as Record<string, unknown>
				const fn = item.function as Record<string, unknown> | undefined
				if (typeof item.id !== "string" || typeof fn?.name !== "string") continue
				content.push({
					type: "tool_use",
					id: item.id,
					name: fn.name,
					input: parseArguments(fn.arguments),
				})
			}
			if (content.length) converted.push({ role: "assistant", content })
		} else if (role === "tool" && typeof message.tool_call_id === "string") {
			converted.push({
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: message.tool_call_id, content: textContent(message.content) },
				],
			})
		}
	}
	return {
		systemPrompt: system.filter(Boolean).join("\n\n") || "Follow the conversation and tool instructions.",
		messages: converted,
	}
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return ""
			const item = part as Record<string, unknown>
			return item.type === "text" && typeof item.text === "string"
				? item.text
				: item.type === "image_url"
					? "[Image input is not supported by the selected VS Code LM provider]"
					: ""
		})
		.filter(Boolean)
		.join("\n")
}

function userContent(content: unknown): Anthropic.Messages.ContentBlockParam[] {
	if (!Array.isArray(content)) return [{ type: "text", text: textContent(content) }]
	return content.map((part): Anthropic.Messages.ContentBlockParam => {
		if (!part || typeof part !== "object") throw new Error("Invalid user content block")
		const item = part as Record<string, unknown>
		if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text }
		const source = item.image_url
		const url = source && typeof source === "object" ? (source as Record<string, unknown>).url : undefined
		if (item.type !== "image_url" || typeof url !== "string") throw new Error("Unsupported user content block")
		const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url)
		if (match)
			return {
				type: "image",
				source: {
					type: "base64",
					media_type: match[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
					data: match[2],
				},
			}
		if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } }
		throw new Error("Unsupported image format or URL")
	})
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
	if (value === "" || value === undefined) return {}
	if (typeof value !== "string") throw new Error("Tool arguments must be a JSON object")
	const parsed: unknown = JSON.parse(value)
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Tool arguments must be a JSON object")
	return parsed as Record<string, unknown>
}
