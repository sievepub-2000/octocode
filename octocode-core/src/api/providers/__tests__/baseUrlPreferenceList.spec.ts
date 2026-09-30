import axios from "axios"

import { parseBaseUrlPreferenceList, primaryBaseUrl } from "../baseUrlPreferenceList"
import { getOpenAiModels, OpenAiHandler } from "../openai"

vi.mock("axios")

describe("parseBaseUrlPreferenceList", () => {
	it("returns a single URL unchanged", () => {
		expect(parseBaseUrlPreferenceList("http://127.0.0.1:8000/v1")).toEqual(["http://127.0.0.1:8000/v1"])
	})

	it("splits a preference list and trims spaces and trailing slashes", () => {
		expect(parseBaseUrlPreferenceList(" http://2.2.2.2:8000/v1/ , http://192.168.10.4:8000/v1 ")).toEqual([
			"http://2.2.2.2:8000/v1",
			"http://192.168.10.4:8000/v1",
		])
	})

	it("treats empty input as no endpoint", () => {
		expect(parseBaseUrlPreferenceList(undefined)).toEqual([])
		expect(primaryBaseUrl("")).toBeUndefined()
	})

	it("prefers the first entry", () => {
		expect(primaryBaseUrl("http://2.2.2.2:8000/v1,http://192.168.10.4:8000/v1")).toBe("http://2.2.2.2:8000/v1")
	})
})

describe("OpenAiHandler with a preference list", () => {
	it("talks to the first endpoint rather than the raw string", () => {
		const handler = new OpenAiHandler({
			openAiBaseUrl: "http://2.2.2.2:8000/v1,http://192.168.10.4:8000/v1",
			openAiApiKey: "qwen38",
			openAiModelId: "qwen38-flash-next:instruct",
		})

		expect(handler["client"].baseURL).toBe("http://2.2.2.2:8000/v1")
	})
})

describe("getOpenAiModels with a preference list", () => {
	beforeEach(() => vi.clearAllMocks())

	it("falls back to the next endpoint when the first is unreachable", async () => {
		const get = vi.mocked(axios.get)
		get.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
		get.mockResolvedValueOnce({ data: { data: [{ id: "qwen38-flash-next:instruct" }] } } as never)

		const models = await getOpenAiModels("http://2.2.2.2:8000/v1,http://192.168.10.4:8000/v1", "qwen38")

		expect(models).toEqual(["qwen38-flash-next:instruct"])
		expect(get).toHaveBeenNthCalledWith(
			1,
			"http://2.2.2.2:8000/v1/models",
			expect.objectContaining({ timeout: 3000 }),
		)
		expect(get).toHaveBeenNthCalledWith(2, "http://192.168.10.4:8000/v1/models", expect.anything())
	})

	it("stops at the first endpoint that answers", async () => {
		const get = vi.mocked(axios.get)
		get.mockResolvedValueOnce({ data: { data: [{ id: "a" }, { id: "b" }] } } as never)

		expect(await getOpenAiModels("http://2.2.2.2:8000/v1,http://192.168.10.4:8000/v1")).toEqual(["a", "b"])
		expect(get).toHaveBeenCalledTimes(1)
	})

	it("returns nothing when no entry is a URL", async () => {
		expect(await getOpenAiModels("not a url")).toEqual([])
		expect(vi.mocked(axios.get)).not.toHaveBeenCalled()
	})

	// Regression: the server root is a common thing to paste, and oMLX serves the list
	// only at /v1/models (it answers 404 at /models). Before the fix this returned an
	// empty list with no error surfaced, so the picker looked like the server had none.
	it("falls back to /v1/models when the base URL is a server root", async () => {
		const get = vi.mocked(axios.get)
		get.mockRejectedValueOnce(
			Object.assign(new Error("Request failed with status code 404"), { response: { status: 404 } }),
		)
		get.mockResolvedValueOnce({ data: { data: [{ id: "qwen38-flash-next:instruct" }] } } as never)

		const models = await getOpenAiModels("http://2.2.2.2:8000", "qwen38")

		expect(models).toEqual(["qwen38-flash-next:instruct"])
		expect(get).toHaveBeenNthCalledWith(1, "http://2.2.2.2:8000/models", expect.anything())
		expect(get).toHaveBeenNthCalledWith(2, "http://2.2.2.2:8000/v1/models", expect.anything())
	})

	it("does not request a doubled /v1/v1/models for a versioned base URL", async () => {
		const get = vi.mocked(axios.get)
		get.mockResolvedValueOnce({ data: { data: [{ id: "a" }] } } as never)

		await getOpenAiModels("http://2.2.2.2:8000/v1", "qwen38")

		expect(get).toHaveBeenCalledTimes(1)
		expect(get).toHaveBeenCalledWith("http://2.2.2.2:8000/v1/models", expect.anything())
		expect(get.mock.calls.map((c) => c[0])).not.toContain("http://2.2.2.2:8000/v1/v1/models")
	})

	it("keeps the first endpoint preferred and only then tries the next", async () => {
		const get = vi.mocked(axios.get)
		get.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
		get.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
		get.mockResolvedValueOnce({ data: { data: [{ id: "c" }] } } as never)

		const models = await getOpenAiModels("http://2.2.2.2:8000,http://192.168.10.4:8000", "k")

		expect(models).toEqual(["c"])
		expect(get.mock.calls.map((c) => c[0])).toEqual([
			"http://2.2.2.2:8000/models",
			"http://2.2.2.2:8000/v1/models",
			"http://192.168.10.4:8000/models",
		])
	})

	it("returns nothing when every candidate path fails", async () => {
		const get = vi.mocked(axios.get)
		get.mockRejectedValue(new Error("connect ECONNREFUSED"))

		expect(await getOpenAiModels("http://2.2.2.2:8000", "k")).toEqual([])
		expect(get).toHaveBeenCalledTimes(2)
	})
})
