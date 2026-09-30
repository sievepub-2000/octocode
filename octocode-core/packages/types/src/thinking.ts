import type { ModelInfo, ReasoningEffortSetting } from "./model.js"

/**
 * How a model is told to think:
 * - `effort`: a `reasoning_effort` request field (OpenAI o-series/GPT-5, gpt-oss, Grok,
 *   Anthropic and Gemini thinking through the harness).
 * - `template`: a chat-template switch (`chat_template_kwargs.enable_thinking`,
 *   plus `thinking_budget`) used by Qwen3/GLM/DeepSeek hybrids served from vLLM,
 *   SGLang, oMLX or LM Studio.
 */
export type ThinkingStyle = "effort" | "template"

export type ThinkingSource = "metadata" | "name" | "probe" | "none"

export interface ThinkingCapability {
	/** `undefined` when the model has no thinking mode the UI can control. */
	style?: ThinkingStyle
	/** Selectable tiers, "disable" (no thinking) first when it is allowed. */
	tiers: ReasoningEffortSetting[]
	/** Tier to show when the profile has none saved. */
	defaultTier?: ReasoningEffortSetting
	source: ThinkingSource
}

export const DEFAULT_THINKING_TIERS: ReasoningEffortSetting[] = ["disable", "low", "medium", "high"]

const NONE: ThinkingCapability = { tiers: [], source: "none" }

/** Served variants that pin thinking off (e.g. oMLX `:instruct`, Qwen `-Instruct-2507`). */
const NON_THINKING = /(?:[:\-_/]instruct\b|non-?think|no-?think|[:\-_]chat$)/i

const EFFORT_FAMILIES =
	/(?:^|\/)(?:o[134](?:-|$)|gpt-5|gpt-oss|grok-(?:3-mini|4)|deepseek-reasoner|claude-(?:opus|sonnet|haiku)-4|claude-\d+(?:\.\d+)?-(?:opus|sonnet)|magistral|gemini-(?:2\.5|3))/i

const TEMPLATE_HYBRIDS =
	/(?:qwen-?3|qwen3\d|qwen\d{2}-|qwq|glm-?4\.[5-9]|glm-?[5-9]|deepseek-(?:v3\.[1-9]|r1)|hunyuan-a13b|kimi-k2.*think|seed-oss|minimax-m[12])/i

/**
 * Thinking capability for a model, from its catalog metadata when it has any, else
 * from its id. Pure and synchronous: the chat bar and the runtime share it, so what
 * the picker offers is exactly what the runtime accepts.
 */
export function detectThinking(modelId: string | undefined, info?: ModelInfo): ThinkingCapability {
	const id = (modelId ?? "").trim()
	const efforts = info?.supportsReasoningEffort
	if (Array.isArray(efforts) && efforts.length) {
		const tiers = efforts.filter((tier) => tier !== "none" || !efforts.includes("disable"))
		return {
			style: "effort",
			tiers: info?.requiredReasoningEffort ? tiers.filter((tier) => tier !== "disable") : tiers,
			defaultTier: info?.reasoningEffort,
			source: "metadata",
		}
	}
	if (efforts === true || info?.supportsReasoningBudget || info?.supportsReasoningBinary) {
		const tiers = info?.requiredReasoningEffort || info?.requiredReasoningBudget
			? DEFAULT_THINKING_TIERS.filter((tier) => tier !== "disable")
			: DEFAULT_THINKING_TIERS
		return { style: "effort", tiers, defaultTier: info?.reasoningEffort, source: "metadata" }
	}
	if (!id) return NONE
	// Known to have thinking pinned off: a decision, not an unknown.
	if (NON_THINKING.test(id)) return { tiers: [], source: "name" }
	if (EFFORT_FAMILIES.test(id)) return { style: "effort", tiers: DEFAULT_THINKING_TIERS, source: "name" }
	if (TEMPLATE_HYBRIDS.test(id)) {
		return { style: "template", tiers: DEFAULT_THINKING_TIERS, defaultTier: "medium", source: "name" }
	}
	return NONE
}

/**
 * The tier to actually send. A tier the model cannot use falls back to no thinking
 * rather than an error; a model without controllable thinking sends nothing.
 */
export function resolveThinkingTier(
	capability: ThinkingCapability,
	saved: ReasoningEffortSetting | undefined,
): ReasoningEffortSetting | undefined {
	if (!capability.style || !capability.tiers.length) return undefined
	const tier = saved ?? capability.defaultTier
	if (tier && capability.tiers.includes(tier)) return tier
	return capability.tiers.includes("disable") ? "disable" : capability.tiers[0]
}

/**
 * Provider settings as the runtime should send them: the saved tier checked against
 * what the selected model supports. A mismatch (model changed, tier left over from
 * another model) falls back to no thinking; a model without controllable thinking
 * gets no thinking fields at all.
 */
export function withResolvedThinking<
	T extends {
		reasoningEffort?: ReasoningEffortSetting
		enableReasoningEffort?: boolean
		reasoningStyle?: ThinkingStyle
	},
>(settings: T, modelId: string | undefined, info?: ModelInfo): T {
	const capability = detectThinking(modelId, info)
	// Unknown here (no catalog metadata at run time) but chosen in the chat bar, where
	// the full metadata was available: trust that choice.
	if (capability.source === "none" && settings.reasoningStyle) return settings
	const saved = settings.enableReasoningEffort === false ? "disable" : settings.reasoningEffort
	const tier = resolveThinkingTier(capability, saved)
	const { reasoningEffort: _tier, reasoningStyle: _style, ...rest } = settings
	if (!tier || !capability.style) return rest as T
	return { ...rest, reasoningEffort: tier, reasoningStyle: capability.style } as T
}
