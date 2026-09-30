// getOpenAiModels against a real HTTP server, not a mocked axios.
//
// Why: the unit spec mocks axios, so it can only assert which URL was requested -- it
// cannot catch the failure users actually hit. This starts a server that reproduces the
// deployment's oMLX contract (auth required; the list lives at /v1/models only, /models
// answers 404) and runs the unmocked fetcher over real sockets, so a wrong path, a
// dropped Authorization header, or a swallowed error fails here instead of in the UI.
import http from "node:http"
import type { AddressInfo } from "node:net"

import nock from "nock"

import { getOpenAiModelInfo, getOpenAiModels } from "../openai"

const KEY = "stub-key"

const MODELS = [
	{ id: "qwen38-flash-next:instruct", object: "model", owned_by: "omlx", max_model_len: 262144 },
	{ id: "qwen38-flash-next:thinking", object: "model", owned_by: "omlx" },
]

let server: http.Server
let baseUrl = ""
const hits: string[] = []
const authSeen: (string | undefined)[] = []

beforeAll(async () => {
	server = http.createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`)
		authSeen.push(req.headers.authorization)
		if ((req.headers.authorization || "") !== `Bearer ${KEY}`) {
			res.writeHead(401, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: { message: "unauthorized" } }))
			return
		}
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ object: "list", data: MODELS }))
			return
		}
		res.writeHead(404, { "content-type": "application/json" })
		res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }))
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	// vitest.setup.ts calls nock.disableNetConnect(); this spec's whole point is real
	// sockets, so let loopback through to the stub server and nothing else.
	nock.enableNetConnect(/^127\.0\.0\.1:\d+$/)
})

afterAll(async () => {
	// Restore the suite-wide default so this spec cannot leak network access to others.
	nock.disableNetConnect()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
	hits.length = 0
	authSeen.length = 0
})

describe("getOpenAiModels against an oMLX-like server", () => {
	it("uses server context metadata and falls back to 128k only when absent", async () => {
		const models = await getOpenAiModelInfo(`${baseUrl}/v1`, KEY)
		expect(models["qwen38-flash-next:instruct"].contextWindow).toBe(262144)
		expect(models["qwen38-flash-next:thinking"].contextWindow).toBe(128000)
	})
	it("finds the list when the user enters the server root", async () => {
		const models = await getOpenAiModels(baseUrl, KEY)

		expect(models).toEqual(["qwen38-flash-next:instruct", "qwen38-flash-next:thinking"])
		// The first probe 404s at the root; recovery must come from /v1/models.
		expect(hits).toContain("GET /models")
		expect(hits).toContain("GET /v1/models")
	})

	it("finds the list when the user enters the /v1 prefix", async () => {
		const models = await getOpenAiModels(`${baseUrl}/v1`, KEY)

		expect(models).toEqual(["qwen38-flash-next:instruct", "qwen38-flash-next:thinking"])
		expect(hits).toEqual(["GET /v1/models"])
	})

	it("sends the API key as a bearer token on every probe", async () => {
		const models = await getOpenAiModels(baseUrl, KEY)

		expect(models).toHaveLength(2)
		expect(authSeen.length).toBeGreaterThan(0)
		expect(authSeen.every((a) => a === `Bearer ${KEY}`)).toBe(true)

		// A wrong key must not silently look like "no models": every request is rejected.
		const withoutKey = await getOpenAiModels(`${baseUrl}/v1`, "wrong-key")
		expect(withoutKey).toEqual([])
	})

	it("walks a comma-separated preference list to the endpoint that answers", async () => {
		const models = await getOpenAiModels(`${baseUrl}/v1,http://127.0.0.1:1/v1`, KEY)

		expect(models).toEqual(["qwen38-flash-next:instruct", "qwen38-flash-next:thinking"])
		expect(hits[0]).toBe("GET /v1/models")
	})
})
