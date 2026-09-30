import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import nock from "nock"
import { SpeechProvider, normalizeAudioParams, pcmWave } from "../SpeechProvider"

afterEach(() => vi.restoreAllMocks())
const roots = { environments: "C:/environments", extension: "C:/extension" }

it("uploads bounded PCM as WAV to the selected Provider and reads Unicode text", async () => {
	let body = Buffer.alloc(0)
	nock.enableNetConnect("127.0.0.1")
	const server = createServer(async (req, res) => {
		expect(req.headers.authorization).toBe("Bearer speech-test-key")
		if (req.url === "/v1/models") return void res.end('{"data":[]}')
		expect(req.url).toBe("/v1/audio/transcriptions")
		expect(req.headers["content-type"]).toContain("multipart/form-data")
		for await (const chunk of req) body = Buffer.concat([body, chunk])
		res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: " 中文识别。 " }))
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const speech = new SpeechProvider()
	const settings = { speechProvider: "openai-compatible" as const, speechBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, speechModelId: "sensevoice", speechApiKey: "speech-test-key" }
	const request = (method: string, params: unknown = { id: "recording" }) => speech.request(method, params, settings, roots)
	try {
		await expect(request("provider.speech.check")).resolves.toMatchObject({ ready: true })
		await request("audio.start")
		await expect(request("audio.start", { id: "second" })).rejects.toThrow("已有")
		await expect(request("audio.chunk", { id: "recording", sample_rate: 16000, samples: [0, -32768, 32767] })).resolves.toEqual({ accepted: 3 })
		await expect(request("audio.finish")).resolves.toEqual({ text: "中文识别。", final: true })
		expect(body.includes(pcmWave(Buffer.from([0, 0, 0, 128, 255, 127])))).toBe(true)
		expect(body.toString()).toContain("sensevoice")
		await expect(request("audio.finish")).rejects.toThrow("不存在")
		await request("audio.start"); await expect(request("audio.cancel")).resolves.toEqual({ cancelled: true })
	} finally { speech.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); nock.disableNetConnect() }
})

it("rejects invalid configuration, samples, oversized responses, and HTTP errors without leaking credentials", async () => {
	const speech = new SpeechProvider()
	const settings = { speechProvider: "openai-compatible" as const, speechBaseUrl: "http://localhost/v1", speechModelId: "sensevoice" }
	const request = (method: string) => speech.request(method, { id: "r" }, settings, roots)
	try {
		await expect(speech.request("audio.start", { id: "r" }, { ...settings, speechBaseUrl: "https://user:secret@example.test/v1" }, roots)).rejects.toThrow("凭据")
		expect(() => normalizeAudioParams("audio.chunk", { id: "r", sample_rate: 16000, samples: [NaN] })).toThrow("16-bit")
		const fetch = vi.spyOn(globalThis, "fetch")
		for (const response of [new Response("denied", { status: 401 }), new Response('{"oops":1}'), new Response("x".repeat(1048577))]) {
			fetch.mockResolvedValueOnce(response)
			await request("audio.start")
			await speech.request("audio.chunk", { id: "r", sample_rate: 16000, samples: [1] }, settings, roots)
			await expect(request("audio.finish")).rejects.toThrow()
		}
		await request("audio.start"); await expect(request("audio.finish")).resolves.toEqual({ text: "", final: true })
	} finally { speech.dispose() }
})
