/**
 * Base-URL presets for the "OpenAI Compatible" provider.
 *
 * Nearly every mainstream vendor now exposes an OpenAI-shaped `/chat/completions`
 * plus `/models` endpoint, so one provider implementation reaches all of them.
 * The only thing a user cannot reasonably be expected to know is the base URL —
 * that is what this table supplies. Model lists are NOT hardcoded here: they are
 * discovered live from `GET {baseUrl}/models` (see `getOpenAiModels`), so this
 * table never goes stale as vendors add or retire models.
 *
 * Adding a vendor is one row. Keep `baseUrl` exactly as the vendor documents it,
 * including any non-obvious suffix (`/openai/v1`, `/compatible-mode/v1`, `/api/v3`).
 */

export type OpenAiCompatiblePreset = {
	/** Stable id; persisted only as a UI convenience, never as the provider id. */
	id: string
	/** Display name shown in the picker. */
	label: string
	/** Base URL to write into `openAiBaseUrl`. */
	baseUrl: string
	/** Where the user obtains an API key. */
	docsUrl?: string
	/** Grouping for the picker. */
	group: "local" | "international" | "china" | "aggregator"
	/** Shown under the picker when selected — only for genuinely non-obvious setup. */
	note?: string
}

export const openAiCompatiblePresets: readonly OpenAiCompatiblePreset[] = [
	// ---------------------------------------------------------------- local
	{
		id: "vllm",
		label: "vLLM (self-hosted)",
		baseUrl: "http://localhost:8000/v1",
		group: "local",
		note: "Point at your vLLM host. Reasoning arrives in the `reasoning` field when the server runs with a reasoning parser.",
	},
	{ id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", group: "local" },
	{ id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", group: "local" },
	{ id: "llamacpp", label: "llama.cpp server (local)", baseUrl: "http://localhost:8080/v1", group: "local" },
	{ id: "sglang", label: "SGLang (self-hosted)", baseUrl: "http://localhost:30000/v1", group: "local" },
	{ id: "text-generation-webui", label: "Text Generation WebUI", baseUrl: "http://localhost:5000/v1", group: "local" },

	// -------------------------------------------------------- international
	{
		id: "groq",
		label: "Groq",
		baseUrl: "https://api.groq.com/openai/v1",
		docsUrl: "https://console.groq.com/keys",
		group: "international",
	},
	{
		id: "cerebras",
		label: "Cerebras",
		baseUrl: "https://api.cerebras.ai/v1",
		docsUrl: "https://cloud.cerebras.ai",
		group: "international",
	},
	{
		id: "together",
		label: "Together AI",
		baseUrl: "https://api.together.xyz/v1",
		docsUrl: "https://api.together.ai/settings/api-keys",
		group: "international",
	},
	{
		id: "perplexity",
		label: "Perplexity",
		baseUrl: "https://api.perplexity.ai",
		docsUrl: "https://www.perplexity.ai/settings/api",
		group: "international",
		note: "Perplexity's base URL has no /v1 suffix.",
	},
	{
		id: "deepinfra",
		label: "DeepInfra",
		baseUrl: "https://api.deepinfra.com/v1/openai",
		docsUrl: "https://deepinfra.com/dash/api_keys",
		group: "international",
	},
	{
		id: "huggingface",
		label: "Hugging Face Inference",
		baseUrl: "https://router.huggingface.co/v1",
		docsUrl: "https://huggingface.co/settings/tokens",
		group: "international",
	},
	{
		id: "nvidia-nim",
		label: "NVIDIA NIM",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		docsUrl: "https://build.nvidia.com",
		group: "international",
	},
	{
		id: "cohere",
		label: "Cohere (compatibility)",
		baseUrl: "https://api.cohere.ai/compatibility/v1",
		docsUrl: "https://dashboard.cohere.com/api-keys",
		group: "international",
	},
	{
		id: "mistral",
		label: "Mistral AI",
		baseUrl: "https://api.mistral.ai/v1",
		docsUrl: "https://console.mistral.ai/api-keys",
		group: "international",
	},
	{
		id: "xai",
		label: "xAI (Grok)",
		baseUrl: "https://api.x.ai/v1",
		docsUrl: "https://console.x.ai",
		group: "international",
	},
	{
		id: "openai",
		label: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		docsUrl: "https://platform.openai.com/api-keys",
		group: "international",
	},
	{
		id: "chutes",
		label: "Chutes AI",
		baseUrl: "https://llm.chutes.ai/v1",
		docsUrl: "https://chutes.ai",
		group: "international",
	},
	{
		id: "featherless",
		label: "Featherless AI",
		baseUrl: "https://api.featherless.ai/v1",
		docsUrl: "https://featherless.ai/account/api-keys",
		group: "international",
	},
	{
		id: "io-intelligence",
		label: "IO Intelligence",
		baseUrl: "https://api.intelligence.io.solutions/api/v1",
		docsUrl: "https://ai.io.net",
		group: "international",
	},

	// --------------------------------------------------------------- china
	{
		id: "siliconflow",
		label: "硅基流动 SiliconFlow",
		baseUrl: "https://api.siliconflow.cn/v1",
		docsUrl: "https://cloud.siliconflow.cn/account/ak",
		group: "china",
	},
	{
		id: "dashscope",
		label: "阿里云百炼 DashScope",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		docsUrl: "https://bailian.console.aliyun.com",
		group: "china",
	},
	{
		id: "volcengine",
		label: "火山方舟（豆包）Volcengine Ark",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		docsUrl: "https://console.volcengine.com/ark",
		group: "china",
		note: "模型名使用接入点 ID（ep-...），而非模型原名。",
	},
	{
		id: "deepseek",
		label: "DeepSeek 深度求索",
		baseUrl: "https://api.deepseek.com/v1",
		docsUrl: "https://platform.deepseek.com/api_keys",
		group: "china",
	},
	{
		id: "moonshot",
		label: "月之暗面 Moonshot (Kimi)",
		baseUrl: "https://api.moonshot.cn/v1",
		docsUrl: "https://platform.moonshot.cn/console/api-keys",
		group: "china",
	},
	{
		id: "zhipu",
		label: "智谱 GLM (BigModel)",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
		group: "china",
	},
	{
		id: "qianfan",
		label: "百度千帆（文心）Qianfan",
		baseUrl: "https://qianfan.baidubce.com/v2",
		docsUrl: "https://console.bce.baidu.com/qianfan",
		group: "china",
	},
	{
		id: "hunyuan",
		label: "腾讯混元 Hunyuan",
		baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
		docsUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
		group: "china",
	},
	{
		id: "minimax",
		label: "MiniMax 稀宇",
		baseUrl: "https://api.minimax.chat/v1",
		docsUrl: "https://platform.minimaxi.com",
		group: "china",
	},
	{
		id: "stepfun",
		label: "阶跃星辰 StepFun",
		baseUrl: "https://api.stepfun.com/v1",
		docsUrl: "https://platform.stepfun.com",
		group: "china",
	},
	{
		id: "lingyiwanwu",
		label: "零一万物 Yi",
		baseUrl: "https://api.lingyiwanwu.com/v1",
		docsUrl: "https://platform.lingyiwanwu.com",
		group: "china",
	},
	{
		id: "spark",
		label: "讯飞星火 Spark",
		baseUrl: "https://spark-api-open.xf-yun.com/v1",
		docsUrl: "https://console.xfyun.cn",
		group: "china",
	},
	{
		id: "infinigence",
		label: "无问芯穹 Infinigence",
		baseUrl: "https://cloud.infini-ai.com/maas/v1",
		docsUrl: "https://cloud.infini-ai.com",
		group: "china",
	},

	// ----------------------------------------------------------- aggregator
	{
		id: "openrouter",
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		docsUrl: "https://openrouter.ai/keys",
		group: "aggregator",
	},
	{
		id: "vercel-ai-gateway",
		label: "Vercel AI Gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		docsUrl: "https://vercel.com/docs/ai-gateway",
		group: "aggregator",
	},
	{
		id: "litellm",
		label: "LiteLLM proxy",
		baseUrl: "http://localhost:4000/v1",
		docsUrl: "https://docs.litellm.ai",
		group: "aggregator",
	},
	{
		id: "one-api",
		label: "One API / New API",
		baseUrl: "http://localhost:3000/v1",
		docsUrl: "https://github.com/songquanpeng/one-api",
		group: "aggregator",
	},
]

/** Look up a preset by the base URL currently configured, if any matches exactly. */
export function findOpenAiCompatiblePresetByBaseUrl(baseUrl?: string): OpenAiCompatiblePreset | undefined {
	if (!baseUrl) return undefined
	const normalized = baseUrl.trim().replace(/\/+$/, "")
	return openAiCompatiblePresets.find((p) => p.baseUrl.replace(/\/+$/, "") === normalized)
}

/**
 * Retired first-class providers mapped to the preset that now replaces them.
 *
 * These vendors are all OpenAI-compatible, so rather than telling a user their
 * configuration is simply gone, we can name the exact preset that restores it.
 */
export const retiredProviderPresetIds: Record<string, string> = {
	groq: "groq",
	cerebras: "cerebras",
	deepinfra: "deepinfra",
	doubao: "volcengine",
	huggingface: "huggingface",
	chutes: "chutes",
	featherless: "featherless",
	"io-intelligence": "io-intelligence",
}

/** Human-readable replacement hint for a retired provider id, if one exists. */
export function getRetiredProviderReplacement(
	providerId: string,
): { presetId: string; label: string; baseUrl: string } | undefined {
	const presetId = retiredProviderPresetIds[providerId]
	if (!presetId) return undefined
	const preset = openAiCompatiblePresets.find((p) => p.id === presetId)
	return preset ? { presetId, label: preset.label, baseUrl: preset.baseUrl } : undefined
}
