import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import type { ProviderSettings } from "@roo-code/types"

export const DEFAULT_SPEECH_MODEL = "sensevoice-small-q8.gguf"
const MAX_SAMPLES = 16_000 * 300
type Paths = { environments: string; extension: string }
type Endpoint = { url: string; key: string; model: string; local: boolean }
type Capture = { chunks: Buffer[]; samples: number; controller: AbortController; endpoint: Endpoint; busy: boolean }

export class SpeechProvider {
	private capture?: { id: string; value: Capture }
	private service?: { config: string; child: ChildProcessWithoutNullStreams; ready: Promise<Endpoint> }

	info(settings: ProviderSettings, roots: Paths) {
		return {
			provider: settings.speechProvider ?? "funasr-local",
			model: settings.speechModelId?.trim() || DEFAULT_SPEECH_MODEL,
			modelDirectory: settings.speechModelDirectory?.trim() || path.join(roots.environments, "funasr", "models"),
			protocol: "POST /v1/audio/transcriptions",
		}
	}

	async request(method: string, params: unknown, settings: ProviderSettings, roots: Paths): Promise<unknown> {
		if (method === "provider.speech.info") return this.info(settings, roots)
		if (method === "provider.speech.check") {
			if (this.capture) throw new Error("请先结束语音输入再检查配置。")
			const endpoint = await this.endpoint(settings, roots)
			const response = await fetch(endpoint.local ? new URL("../health", endpoint.url + "/") : endpoint.url + "/models", { headers: endpoint.key ? { Authorization: `Bearer ${endpoint.key}` } : {}, signal: AbortSignal.timeout(10_000), redirect: "error" })
			await response.body?.cancel()
			if (!response.ok) throw new Error(`语音接口连接检查返回 HTTP ${response.status}。`)
			return { ...this.info(settings, roots), ready: true, endpoint: endpoint.url }
		}
		const input = normalizeAudioParams(method, params)
		const id = input.id as string
		if (method === "audio.start") {
			if (this.capture) throw new Error("已有语音录音正在进行，请先停止或取消。")
			// Reserve before asynchronous startup so two requests cannot acquire the microphone session.
			const value: Capture = { chunks: [], samples: 0, controller: new AbortController(), endpoint: { url: "", key: "", model: "", local: false }, busy: false }
			this.capture = { id, value }
			try { value.endpoint = await this.endpoint(settings, roots) } catch (error) { if (this.capture?.value === value) this.capture = undefined; throw error }
			if (value.controller.signal.aborted) throw new Error("语音输入已取消。")
			return { id, state: "recording" }
		}
		const capture = this.capture?.id === id ? this.capture.value : undefined
		if (method === "audio.cancel") {
			if (capture) {
				capture.controller.abort()
				this.capture = undefined
				if (capture.busy && capture.endpoint.local) this.stopService()
			}
			return { cancelled: !!capture }
		}
		if (!capture) throw new Error("语音会话不存在或已经结束。")
		if (capture.busy) throw new Error("语音识别正在进行。")
		if (method === "audio.chunk") {
			const samples = input.samples as number[]
			if (capture.samples + samples.length > MAX_SAMPLES) throw new Error("单次语音输入不能超过五分钟。")
			const pcm = Buffer.allocUnsafe(samples.length * 2)
			samples.forEach((sample, i) => pcm.writeInt16LE(sample, i * 2))
			capture.chunks.push(pcm); capture.samples += samples.length
			return { accepted: samples.length }
		}
		capture.busy = true
		const final = method === "audio.finish"
		try {
			if (!capture.samples) return { text: "", final }
			const form = new FormData()
			form.set("model", capture.endpoint.model)
			form.set("response_format", "json")
			form.set("file", new Blob([Uint8Array.from(pcmWave(Buffer.concat(capture.chunks)))], { type: "audio/wav" }), "speech.wav")
			const response = await fetch(capture.endpoint.url + "/audio/transcriptions", {
				method: "POST", body: form, redirect: "error",
				headers: capture.endpoint.key ? { Authorization: `Bearer ${capture.endpoint.key}` } : {},
				signal: AbortSignal.any([capture.controller.signal, AbortSignal.timeout(300_000)]),
			})
			if (!response.ok) { await response.body?.cancel(); throw new Error(`语音识别接口返回 HTTP ${response.status}。`) }
			const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0
			if (!reader) throw new Error("语音识别接口返回空响应。")
			for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 1024 * 1024) { await reader.cancel(); throw new Error("语音识别响应超过大小限制。") }; chunks.push(part.value) }
			const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
			if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") throw new Error("语音接口应返回包含 text 字符串的 JSON。")
			return { text: result.text.trim(), final }
		} finally { capture.busy = false; if (final && this.capture?.value === capture) this.capture = undefined }
	}

	private async endpoint(settings: ProviderSettings, roots: Paths): Promise<Endpoint> {
		if (settings.speechProvider === "openai-compatible") {
			const url = new URL(settings.speechBaseUrl?.trim() || "http://127.0.0.1:8178/v1")
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("语音接口地址必须是无内嵌凭据、查询参数或片段的 HTTP(S) 地址。")
			const model = settings.speechModelId?.trim()
			if (!model) throw new Error("请配置语音识别模型名称。")
			if (/vibevoice-realtime/i.test(model)) throw new Error("VibeVoice-Realtime 是语音合成模型，不能用于语音识别。")
			return { url: url.toString().replace(/\/+$/, ""), key: settings.speechApiKey ?? "", model, local: false }
		}
		const info = this.info(settings, roots)
		if (path.basename(info.model) !== info.model || !info.model.endsWith(".gguf")) throw new Error("本地 FunASR 模型名称必须为目录内的 .gguf 文件名。")
		const model = path.join(info.modelDirectory, info.model)
		const binary = path.join(roots.environments, "funasr", "llama-funasr-sensevoice.exe")
		const python = path.join(roots.environments, "python", "python.exe")
		const script = path.join(roots.extension, "resources", "funasr", "funasr_gguf_server.py")
		for (const file of [model, binary, python, script]) if (!(await fs.stat(file).catch(() => undefined))?.isFile()) throw new Error(`语音组件或模型不存在：${file}。请修复安装或在 Provider 中选择有效目录。`)
		const config = JSON.stringify([model, binary, python, script])
		const vad = path.join(roots.environments, "funasr", "models", "fsmn-vad.gguf")
		const hasVad = (await fs.stat(vad).catch(() => undefined))?.isFile()
		if (this.service?.config === config) return this.service.ready
		this.stopService()
		const key = randomBytes(32).toString("hex")
		const args = ["-u", script, "--host", "127.0.0.1", "--port", "0", "--binary", binary, "--model", model, "--timeout", "290"]
		if (hasVad) args.push("--vad", vad)
		const child = spawn(python, args, {
			windowsHide: true, stdio: "pipe", env: { ...process.env, PYTHONUTF8: "1", OCTOCODE_SPEECH_TOKEN: key },
		})
		const ready = new Promise<Endpoint>((resolve, reject) => {
			const lines = createInterface({ input: child.stdout })
			const timer = setTimeout(() => { this.stopService(); reject(new Error("本地语音接口启动超时。")) }, 15_000)
			lines.on("line", line => {
				if (!line.startsWith("OCTOCODE_SPEECH_READY=")) return
				const port = Number(line.slice("OCTOCODE_SPEECH_READY=".length))
				if (!Number.isInteger(port) || port < 1 || port > 65535) return
				clearTimeout(timer); resolve({ url: `http://127.0.0.1:${port}/v1`, key, model: info.model, local: true })
			})
			child.stderr.resume()
			child.once("error", error => { clearTimeout(timer); reject(new Error(`本地语音接口启动失败：${error.message}`)) })
			child.once("exit", code => { clearTimeout(timer); lines.close(); if (this.service?.child === child) this.service = undefined; reject(new Error(`本地语音接口已退出（${code}）。`)) })
		})
		this.service = { config, child, ready }
		return ready
	}

	private stopService() { const service = this.service; this.service = undefined; service?.child.stdin.end() }
	dispose() { this.capture?.value.controller.abort(); this.capture = undefined; this.stopService() }
}

export function normalizeAudioParams(method: string, params: unknown): Record<string, unknown> {
	if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Audio parameters must be an object")
	const input = params as Record<string, unknown>
	if (typeof input.id !== "string" || input.id.length < 1 || input.id.length > 128 || /[\r\n]/.test(input.id)) throw new Error("Audio session id is invalid")
	if (method === "audio.chunk") {
		if (input.sample_rate !== 16_000) throw new Error("Audio input must use 16 kHz PCM")
		if (!Array.isArray(input.samples) || input.samples.length < 1 || input.samples.length > 16_000) throw new Error("Audio chunks must contain 1 to 16000 samples")
		if (!input.samples.every(sample => Number.isInteger(sample) && sample >= -32768 && sample <= 32767)) throw new Error("Audio samples must be signed 16-bit integers")
		return { id: input.id, sample_rate: 16_000, samples: input.samples }
	}
	if (["audio.start", "audio.cancel", "audio.preview", "audio.finish"].includes(method)) return { id: input.id }
	throw new Error("Unsupported audio request")
}

export function pcmWave(pcm: Buffer): Buffer {
	const header = Buffer.alloc(44)
	header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8)
	header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
	header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
	header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
	return Buffer.concat([header, pcm])
}
