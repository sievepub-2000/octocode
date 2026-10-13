import nock from "nock"
import { performance } from "node:perf_hooks"

import { resolvers } from "../resolvers"

const index = [
	{
		version: "go1.26.0",
		files: [{ filename: "go1.26.0.windows-amd64.zip" }, { filename: "go1.26.0.windows-arm64.zip" }],
	},
]

describe("toolchain index redirects", () => {
	afterEach(() => {
		nock.cleanAll()
		vi.restoreAllMocks()
	})

	it("accepts an index on a trusted host", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(200, index)
		await expect(resolvers.golang()).resolves.toMatchObject({ version: "go1.26.0", archive: "zip" })
	})

	it("follows a relative redirect on a trusted host", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(302, undefined, { Location: "/index.json" })
		nock("https://go.dev").get("/index.json").reply(200, index)
		await expect(resolvers.golang()).resolves.toMatchObject({ version: "go1.26.0" })
	})

	it("rejects an untrusted redirect before sending the next request", async () => {
		nock("https://go.dev")
			.get("/dl/?mode=json")
			.reply(302, undefined, { Location: "https://untrusted.example/index.json" })
		const forbidden = nock("https://untrusted.example").get("/index.json").reply(200, index)
		await expect(resolvers.golang()).rejects.toThrow("untrusted")
		expect(forbidden.isDone()).toBe(false)
	})

	it("rejects a redirect past the hostname boundary", async () => {
		nock("https://go.dev")
			.get("/dl/?mode=json")
			.reply(302, undefined, { Location: "https://evilgo.dev/index.json" })
		const forbidden = nock("https://evilgo.dev").get("/index.json").reply(200, index)
		await expect(resolvers.golang()).rejects.toThrow("untrusted")
		expect(forbidden.isDone()).toBe(false)
	})

	it("rejects a downgrade to HTTP", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(302, undefined, { Location: "http://go.dev/index.json" })
		await expect(resolvers.golang()).rejects.toThrow("untrusted")
	})

	it("bounds redirect chains", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(302, undefined, { Location: "/loop" })
		nock("https://go.dev").get("/loop").times(5).reply(302, undefined, { Location: "/loop" })
		const seventh = nock("https://go.dev").get("/loop").reply(200, index)
		await expect(resolvers.golang()).rejects.toThrow("Too many")
		expect(seventh.isDone()).toBe(false)
	})

	it("rejects a redirect with no Location", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(302)
		await expect(resolvers.golang()).rejects.toThrow("Location")
	})

	it("rejects a malformed redirect without an uncaught response callback error", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(302, undefined, { Location: "https://[" })
		await expect(resolvers.golang()).rejects.toThrow("Invalid URL")
	})

	it("keeps the original time budget across redirects", async () => {
		let elapsed = 0
		vi.spyOn(performance, "now").mockImplementation(() => elapsed)
		nock("https://go.dev")
			.get("/dl/?mode=json")
			.reply(() => {
				elapsed = 15_001
				return [302, undefined, { Location: "/index.json" }]
			})
		const second = nock("https://go.dev").get("/index.json").reply(200, index)
		await expect(resolvers.golang()).rejects.toThrow("timed out")
		expect(second.isDone()).toBe(false)
	})

	it("bounds streamed index bytes even without a Content-Length", async () => {
		nock("https://go.dev")
			.get("/dl/?mode=json")
			.reply(200, " ".repeat(8 * 1024 * 1024 + 1))
		await expect(resolvers.golang()).rejects.toThrow("response size limit")
	})

	it("expires the total timer while waiting for an index body", async () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(14_999)
		nock("https://go.dev").get("/dl/?mode=json").delayBody(50).reply(200, index)
		await expect(resolvers.golang()).rejects.toThrow("timed out")
	})

	it("rejects invalid index JSON", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(200, "{")
		await expect(resolvers.golang()).rejects.toThrow("invalid JSON")
	})

	it("rejects an unsuccessful index response", async () => {
		nock("https://go.dev").get("/dl/?mode=json").reply(503)
		await expect(resolvers.golang()).rejects.toThrow("HTTP 503")
	})
})
