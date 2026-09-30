import nock from "nock"
import { vi } from "vitest"
import { OpenAiCodexHandler } from "../openai-codex"
import { collectStream } from "../../../test-utils/stream"

vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn().mockResolvedValue("fixture-oauth-token"),
		getAccountId: vi.fn().mockResolvedValue("fixture-account"),
		forceRefreshAccessToken: vi.fn(),
	},
}))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureException: vi.fn() } } }))

it("preserves Codex OAuth headers, stable session identity and encrypted reasoning across the HTTP tool loop", async () => {
	const encrypted = { id: "reasoning-1", encrypted_content: "fixture-ciphertext" }
	const tool = { type: "function_call", id: "fc-1", call_id: "call-1", name: "read_file", arguments: "{}" }
	const wire = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
	const bodies: Record<string, unknown>[] = []
	const scope = nock("https://chatgpt.com")
		.matchHeader("authorization", "Bearer fixture-oauth-token")
		.matchHeader("session_id", "conversation-1")
		.matchHeader("chatgpt-account-id", "fixture-account")
		.post("/backend-api/codex/responses", (body) => {
			bodies.push(body)
			return true
		})
		.reply(
			200,
			wire([
				{ type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
				{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc-1", delta: "{}" },
				{
					type: "response.completed",
					response: {
						id: "response-1",
						status: "completed",
						output: [{ type: "reasoning", summary: [], ...encrypted }, tool],
						usage: { input_tokens: 20, output_tokens: 4 },
					},
				},
			]),
			{ "content-type": "text/event-stream" },
		)
		.post("/backend-api/codex/responses", (body) => {
			bodies.push(body)
			return true
		})
		.reply(
			200,
			wire([
				{ type: "response.output_text.delta", delta: "complete" },
				{
					type: "response.completed",
					response: {
						id: "response-2",
						status: "completed",
						output: [],
						usage: { input_tokens: 25, output_tokens: 2 },
					},
				},
			]),
			{ "content-type": "text/event-stream" },
		)
	try {
		const first = new OpenAiCodexHandler({ apiModelId: "gpt-5.2-2025-12-11" })
		const chunks = await collectStream(
			first.createMessage("Read a file", [{ role: "user", content: "read" }], { taskId: "conversation-1" }),
		)
		expect(chunks.some((chunk) => chunk.type === "tool_call_partial" && chunk.name === "read_file")).toBe(true)
		expect(first.getEncryptedContent()).toEqual(encrypted)
		const second = new OpenAiCodexHandler({ apiModelId: "gpt-5.2-2025-12-11" })
		const final = await collectStream(
			second.createMessage(
				"Read a file",
				[
					{ role: "user", content: "read" },
					{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "call-1", content: "file-content" }],
					},
				],
				{ taskId: "conversation-1", toolEncryptedContent: { "call-1": encrypted } },
			),
		)
		expect(final).toContainEqual({ type: "text", text: "complete" })
		const input = bodies[1].input as { type?: string; encrypted_content?: string }[]
		const reasoningIndex = input.findIndex((item) => item.type === "reasoning")
		expect(reasoningIndex).toBeGreaterThanOrEqual(0)
		expect(reasoningIndex).toBeLessThan(input.findIndex((item) => item.type === "function_call"))
		expect(input[reasoningIndex].encrypted_content).toBe("fixture-ciphertext")
		expect(scope.isDone()).toBe(true)
	} finally {
		nock.cleanAll()
	}
})
