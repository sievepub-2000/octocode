import { isOfficialOpenAiBaseUrl, migrateOpenAiNativeCustomEndpoint } from "../openAiNativeEndpointMigration"

describe("isOfficialOpenAiBaseUrl", () => {
	it("treats an unset base URL as the official endpoint", () => {
		expect(isOfficialOpenAiBaseUrl(undefined)).toBe(true)
		expect(isOfficialOpenAiBaseUrl("  ")).toBe(true)
	})

	it("accepts openai.com hosts", () => {
		expect(isOfficialOpenAiBaseUrl("https://api.openai.com/v1")).toBe(true)
		expect(isOfficialOpenAiBaseUrl("https://eu.api.openai.com/v1")).toBe(true)
	})

	it("rejects local, private and look-alike hosts", () => {
		expect(isOfficialOpenAiBaseUrl("http://2.2.2.2:8000/v1")).toBe(false)
		expect(isOfficialOpenAiBaseUrl("http://localhost:1234/v1")).toBe(false)
		expect(isOfficialOpenAiBaseUrl("https://notopenai.com/v1")).toBe(false)
		expect(isOfficialOpenAiBaseUrl("not a url")).toBe(false)
	})
})

describe("migrateOpenAiNativeCustomEndpoint", () => {
	it("moves a local endpoint to the OpenAI Compatible provider", () => {
		const migrated = migrateOpenAiNativeCustomEndpoint({
			id: "default",
			apiProvider: "openai-native",
			apiModelId: "qwen38-flash-next:instruct",
			openAiNativeApiKey: "qwen38",
			openAiNativeBaseUrl: " http://192.168.10.4:8000/v1 ",
			openAiNativeServiceTier: "default",
			toolProtocol: "auto",
		})

		expect(migrated).toEqual({
			id: "default",
			apiProvider: "openai",
			openAiBaseUrl: "http://192.168.10.4:8000/v1",
			openAiApiKey: "qwen38",
			openAiModelId: "qwen38-flash-next:instruct",
			toolProtocol: "auto",
		})
	})

	it("leaves official and non-native profiles untouched", () => {
		expect(
			migrateOpenAiNativeCustomEndpoint({ apiProvider: "openai-native", apiModelId: "gpt-5.4" }),
		).toBeUndefined()
		expect(
			migrateOpenAiNativeCustomEndpoint({
				apiProvider: "openai-native",
				openAiNativeBaseUrl: "https://api.openai.com/v1",
			}),
		).toBeUndefined()
		expect(
			migrateOpenAiNativeCustomEndpoint({ apiProvider: "openai", openAiBaseUrl: "http://2.2.2.2:8000/v1" }),
		).toBeUndefined()
	})

	it("does not invent a key or model the profile never had", () => {
		const migrated = migrateOpenAiNativeCustomEndpoint({
			apiProvider: "openai-native",
			openAiNativeBaseUrl: "http://127.0.0.1:8000/v1",
		})

		expect(migrated).toEqual({ apiProvider: "openai", openAiBaseUrl: "http://127.0.0.1:8000/v1" })
	})
})
