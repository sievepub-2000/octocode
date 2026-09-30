import { createServer, type IncomingMessage } from "node:http"
import { createServer as createHttp2Server, type Http2ServerRequest, type ServerHttp2Session } from "node:http2"
import type { AddressInfo } from "node:net"
import { crc32 } from "node:zlib"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import nock from "nock"
import { vi } from "vitest"
import { AwsBedrockHandler } from "../bedrock"
import { OpenRouterHandler } from "../openrouter"
import { collectStream } from "../../../test-utils/stream"

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({
		"fixture/model": {
			contextWindow: 131072,
			maxTokens: 8192,
			supportsImages: true,
			supportsPromptCache: false,
		},
	}),
}))
vi.mock("../fetchers/modelEndpointCache", () => ({ getModelEndpoints: vi.fn().mockResolvedValue({}) }))
vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureException: vi.fn() } } }))

// AWS event-stream wire frames: exercise the installed SDK decoder and SigV4 signer.
function eventFrame(type: string, payload: unknown) {
	const headers = Buffer.concat(
		Object.entries({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }).map(
			([key, value]) => {
				const name = Buffer.from(key),
					text = Buffer.from(value),
					header = Buffer.alloc(1 + name.length + 3 + text.length)
				header[0] = name.length
				name.copy(header, 1)
				header[1 + name.length] = 7
				header.writeUInt16BE(text.length, 2 + name.length)
				text.copy(header, 4 + name.length)
				return header
			},
		),
	)
	const body = Buffer.from(JSON.stringify(payload)),
		prefix = Buffer.alloc(12)
	prefix.writeUInt32BE(16 + headers.length + body.length, 0)
	prefix.writeUInt32BE(headers.length, 4)
	prefix.writeUInt32BE(crc32(prefix.subarray(0, 8)), 8)
	const message = Buffer.concat([prefix, headers, body]),
		checksum = Buffer.alloc(4)
	checksum.writeUInt32BE(crc32(message))
	return Buffer.concat([message, checksum])
}

describe("provider SDK HTTP lifecycle", () => {
	beforeAll(() => nock.enableNetConnect("127.0.0.1"))
	afterAll(() => nock.disableNetConnect())
	it.each(["bedrock", "openrouter"] as const)(
		"runs %s request, tool result and final response through its real SDK",
		async (provider) => {
			const root = await mkdtemp(join(tmpdir(), "octocode-provider-http-"))
			const requests: { path?: string; authorization?: string; body: Record<string, unknown> }[] = []
			const sessions = new Set<ServerHttp2Session>()
			const respond = async (
				request: IncomingMessage | Http2ServerRequest,
				response: {
					writeHead(status: number, headers: Record<string, string>): unknown
					write(data: Buffer | string): unknown
					end(data: Buffer | string): unknown
				},
			) => {
				const chunks: Buffer[] = []
				for await (const chunk of request) chunks.push(Buffer.from(chunk))
				requests.push({
					path: request.url,
					authorization: request.headers.authorization,
					body: JSON.parse(Buffer.concat(chunks).toString()),
				})
				const first = requests.length === 1
				if (provider === "bedrock") {
					response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" })
					response.write(eventFrame("messageStart", { role: "assistant" }))
					if (first) {
						response.write(
							eventFrame("contentBlockStart", {
								contentBlockIndex: 0,
								start: { toolUse: { toolUseId: "read-1", name: "read_file" } },
							}),
						)
						response.write(
							eventFrame("contentBlockDelta", {
								contentBlockIndex: 0,
								delta: { toolUse: { input: '{"path":"marker.txt"}' } },
							}),
						)
					} else
						response.write(
							eventFrame("contentBlockDelta", {
								contentBlockIndex: 0,
								delta: { text: "fixture-complete" },
							}),
						)
					response.write(eventFrame("contentBlockStop", { contentBlockIndex: 0 }))
					response.write(eventFrame("messageStop", { stopReason: first ? "tool_use" : "end_turn" }))
					response.end(
						eventFrame("metadata", {
							usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
							metrics: { latencyMs: 1 },
						}),
					)
				} else {
					response.writeHead(200, { "content-type": "text/event-stream" })
					const delta = first
						? {
								tool_calls: [
									{
										index: 0,
										id: "read-1",
										type: "function",
										function: { name: "read_file", arguments: '{"path":"marker.txt"}' },
									},
								],
							}
						: { content: "fixture-complete" }
					response.write(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
					)
					response.write(
						`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
					)
					response.end("data: [DONE]\n\n")
				}
			}
			const server = provider === "bedrock" ? createHttp2Server(respond) : createServer(respond)
			server.on("session", (session: ServerHttp2Session) => sessions.add(session))
			try {
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
				const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
				const handler =
					provider === "bedrock"
						? new AwsBedrockHandler({
								apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
								awsRegion: "us-east-1",
								awsAccessKey: "fixture-access-key",
								awsSecretKey: "fixture-secret-key",
								awsBedrockEndpointEnabled: true,
								awsBedrockEndpoint: baseUrl,
							})
						: new OpenRouterHandler({
								openRouterModelId: "fixture/model",
								openRouterBaseUrl: `${baseUrl}/v1`,
								openRouterApiKey: "fixture-api-key",
							})
				const tools = [
					{
						type: "function" as const,
						function: {
							name: "read_file",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
								required: ["path"],
							},
						},
					},
				]
				const first = await collectStream(
					handler.createMessage("Read the marker", [{ role: "user", content: "Read marker.txt" }], {
						tools,
						taskId: "stable-session",
					}),
				)
				expect(first.some((chunk) => chunk.type === "tool_call_partial" && chunk.name === "read_file")).toBe(
					true,
				)
				await writeFile(join(root, "marker.txt"), "fixture-value")
				const result = await readFile(join(root, "marker.txt"), "utf8")
				const final = await collectStream(
					handler.createMessage(
						"Read the marker",
						[
							{ role: "user", content: "Read marker.txt" },
							{
								role: "assistant",
								content: [
									{
										type: "tool_use",
										id: "read-1",
										name: "read_file",
										input: { path: "marker.txt" },
									},
								],
							},
							{
								role: "user",
								content: [{ type: "tool_result", tool_use_id: "read-1", content: result }],
							},
						],
						{ tools, taskId: "stable-session" },
					),
				)
				expect(final).toContainEqual({ type: "text", text: "fixture-complete" })
				expect(requests).toHaveLength(2)
				expect(JSON.stringify(requests[1].body)).toContain("fixture-value")
				expect(requests[0].authorization).toMatch(
					provider === "bedrock" ? /^AWS4-HMAC-SHA256 / : /^Bearer fixture-api-key$/,
				)
				expect(requests[0].path).toContain(provider === "bedrock" ? "/converse-stream" : "/chat/completions")
			} finally {
				if ("closeAllConnections" in server) server.closeAllConnections()
				for (const session of sessions) session.destroy()
				await new Promise<void>((resolve) => server.close(() => resolve()))
				await rm(root, { recursive: true, force: true })
			}
		},
	)
})
