import nock from "nock"
import { OpenAiHandler } from "../openai"
import { collectStream } from "../../../test-utils/stream"

it("sends Azure deployment, version, headers and output budget through the real SDK", async () => {
	const scope = nock("https://fixture.openai.azure.com", { reqheaders: { "api-key": "fixture-only", "x-octo-test": "configured" } })
		.post("/openai/deployments/deployment/chat/completions", body => body.max_completion_tokens === 2048 && body.temperature === 0.4)
		.query({ "api-version": "2024-10-21" })
		.reply(200, { id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })
	const handler = new OpenAiHandler({ openAiBaseUrl: "https://fixture.openai.azure.com", openAiModelId: "deployment", openAiApiKey: "fixture-only", openAiUseAzure: true, azureApiVersion: "2024-10-21", openAiHeaders: { "x-octo-test": "configured" }, openAiStreamingEnabled: false, modelTemperature: 0.4, includeMaxTokens: true, modelMaxTokens: 2048 })
	const result = await collectStream(handler.createMessage("system", [{ role: "user", content: "test" }], { taskId: "fixture", abortSignal: new AbortController().signal }))
	expect(result).toContainEqual({ type: "text", text: "done" })
	expect(scope.isDone()).toBe(true)
})
