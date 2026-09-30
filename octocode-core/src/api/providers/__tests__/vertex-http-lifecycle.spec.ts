import nock from "nock"
import { GoogleAuth, OAuth2Client } from "google-auth-library"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { collectStream } from "../../../test-utils/stream"

it("does not start Google authentication while reading model metadata", () => {
	const client = vi.spyOn(GoogleAuth.prototype, "getClient")
	try {
		const handler = new AnthropicVertexHandler({ apiModelId: "claude-3-5-sonnet-v2@20241022" })
		expect(handler.getModel().info.contextWindow).toBeGreaterThan(0)
		expect(client).not.toHaveBeenCalled()
	} finally { client.mockRestore() }
})

it("runs the real Vertex SDK tool loop with Google OAuth headers and project routing", async () => {
	const auth = new OAuth2Client()
	auth.setCredentials({ access_token: "fixture-google-token", expiry_date: Date.now() + 3_600_000 })
	const client = vi.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue(auth)
	const bodies: Record<string, unknown>[] = []
	const wire = (first: boolean) => [
		{ type: "message_start", message: { id: "fixture", role: "assistant", content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: first ? { type: "tool_use", id: "call-1", name: "read_file", input: {} } : { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: first ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: "complete" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
	const scope = nock("https://us-east5-aiplatform.googleapis.com")
		.matchHeader("authorization", "Bearer fixture-google-token")
		.post(/\/projects\/fixture-project\/locations\/us-east5\/publishers\/anthropic\/models\/claude-3-5-sonnet-v2@20241022:streamRawPredict/, body => { bodies.push(body); return true })
		.reply(200, wire(true), { "content-type": "text/event-stream" })
		.post(/:streamRawPredict/, body => { bodies.push(body); return true })
		.reply(200, wire(false), { "content-type": "text/event-stream" })
	try {
		const handler = new AnthropicVertexHandler({ vertexProjectId: "fixture-project", vertexRegion: "us-east5", apiModelId: "claude-3-5-sonnet-v2@20241022" })
		const first = await collectStream(handler.createMessage("Read", [{ role: "user", content: "read a file" }]))
		expect(first.some(chunk => chunk.type === "tool_call_partial" && chunk.name === "read_file")).toBe(true)
		const final = await collectStream(handler.createMessage("Read", [
			{ role: "user", content: "read a file" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "fixture-file-content" }] },
		]))
		expect(final).toContainEqual({ type: "text", text: "complete" })
		expect(JSON.stringify(bodies[1])).toContain("fixture-file-content")
		expect(bodies[0].anthropic_version).toBe("vertex-2023-10-16")
		expect(scope.isDone()).toBe(true)
	} finally { client.mockRestore(); nock.cleanAll() }
})
