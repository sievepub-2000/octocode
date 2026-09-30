import { describe, expect, it } from "vitest"

import { SECRET_STATE_KEYS, providerSettingsSchema } from "../index.js"

describe("Qwen direct provider settings", () => {
	it("stores an API key and an explicit compatible endpoint without OAuth", () => {
		expect(SECRET_STATE_KEYS).toContain("qwenCodeApiKey")
		expect(
			providerSettingsSchema.parse({
				apiProvider: "qwen-code",
				apiModelId: "qwen3-coder-plus",
				qwenCodeApiKey: "qwen-key",
				qwenCodeBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			}),
		).toMatchObject({ qwenCodeApiKey: "qwen-key" })
	})
})
