import { describe, expect, it } from "vitest"

import { detectThinking, resolveThinkingTier, withResolvedThinking } from "../thinking.js"
import type { ModelInfo } from "../model.js"

const info = (extra: Partial<ModelInfo>): ModelInfo => ({ contextWindow: 128_000, supportsPromptCache: false, ...extra })

describe("detectThinking", () => {
	it("reads catalog metadata before the model id", () => {
		expect(detectThinking("anything", info({ supportsReasoningEffort: ["low", "high"] }))).toMatchObject({
			style: "effort",
			tiers: ["low", "high"],
			source: "metadata",
		})
		expect(detectThinking("x", info({ supportsReasoningBudget: true, requiredReasoningBudget: true })).tiers).not.toContain(
			"disable",
		)
	})

	it("recognises template hybrids served locally and leaves pinned variants disabled", () => {
		expect(detectThinking("qwen38-flash-next")).toMatchObject({ style: "template", source: "name" })
		expect(detectThinking("Qwen/Qwen3-32B").style).toBe("template")
		expect(detectThinking("glm-4.6").style).toBe("template")
		// oMLX's `:instruct` profile forces thinking off: known, not unknown.
		expect(detectThinking("qwen38-flash-next:instruct")).toEqual({ tiers: [], source: "name" })
		expect(detectThinking("Qwen3-30B-A3B-Instruct-2507")).toEqual({ tiers: [], source: "name" })
	})

	it("recognises effort families and reports unknown models as unknown", () => {
		expect(detectThinking("gpt-5.1").style).toBe("effort")
		expect(detectThinking("o3-mini").style).toBe("effort")
		expect(detectThinking("llama-3.3-70b")).toEqual({ tiers: [], source: "none" })
	})
})

describe("resolveThinkingTier", () => {
	const capability = detectThinking("qwen38-flash-next")

	it("keeps a supported tier and falls back to no thinking on a mismatch", () => {
		expect(resolveThinkingTier(capability, "high")).toBe("high")
		expect(resolveThinkingTier(capability, "xhigh")).toBe("disable")
		expect(resolveThinkingTier(capability, undefined)).toBe("medium")
		expect(resolveThinkingTier(detectThinking("qwen38-flash-next:instruct"), "high")).toBeUndefined()
	})
})

describe("withResolvedThinking", () => {
	it("adds the detected style, drops thinking for models without it, and trusts chat-bar choices for unknown ids", () => {
		expect(withResolvedThinking({ reasoningEffort: "low" as const }, "qwen38-flash-next")).toEqual({
			reasoningEffort: "low",
			reasoningStyle: "template",
		})
		expect(withResolvedThinking({ reasoningEffort: "high" as const, reasoningStyle: "template" as const }, "q:instruct")).toEqual(
			{},
		)
		expect(withResolvedThinking({ enableReasoningEffort: false }, "qwen38-flash-next")).toEqual({
			enableReasoningEffort: false,
			reasoningEffort: "disable",
			reasoningStyle: "template",
		})
		const chosen = { reasoningEffort: "medium" as const, reasoningStyle: "effort" as const }
		expect(withResolvedThinking(chosen, "vendor-model-without-a-known-family")).toBe(chosen)
	})
})
