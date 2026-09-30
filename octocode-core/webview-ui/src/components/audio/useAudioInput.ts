import { useCallback, useEffect, useRef, useState } from "react"

import { requestRuntime } from "@src/utils/runtimeRequest"

const TARGET_RATE = 16_000
const CHUNK_SAMPLES = 16_000
const SPEECH_PEAK = 0.02
const ENDPOINT_SILENCE_MS = 900
const PRE_ROLL_SAMPLES = 4_000

export type AudioInputState = "idle" | "requesting" | "recording" | "transcribing" | "error"

export function resampleMono(input: Float32Array, sourceRate: number): Float32Array {
	if (sourceRate === TARGET_RATE) return input.slice()
	const output = new Float32Array(Math.max(1, Math.floor((input.length * TARGET_RATE) / sourceRate)))
	const ratio = sourceRate / TARGET_RATE
	for (let index = 0; index < output.length; index++) {
		const position = index * ratio
		const left = Math.floor(position)
		const mix = position - left
		output[index] = input[left] * (1 - mix) + (input[Math.min(left + 1, input.length - 1)] ?? input[left]) * mix
	}
	return output
}

export function floatToPcm16(input: Float32Array): Int16Array {
	return Int16Array.from(input, (sample) => {
		const clamped = Math.max(-1, Math.min(1, sample))
		return clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767)
	})
}

export function pcmChunks(input: Float32Array, sourceRate: number): number[][] {
	const pcm = floatToPcm16(resampleMono(input, sourceRate))
	const chunks: number[][] = []
	for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
		chunks.push(Array.from(pcm.subarray(offset, offset + CHUNK_SAMPLES)))
	}
	return chunks
}

export function isUtteranceComplete(speechStarted: boolean, lastSpeechAt: number, now: number): boolean {
	return speechStarted && now - lastSpeechAt >= ENDPOINT_SILENCE_MS
}

export function isCaptureCurrent(enabled: boolean, operation: number, currentOperation: number): boolean {
	return enabled && operation === currentOperation
}

export function useAudioInput(onCommit: (text: string) => void) {
	const [state, setState] = useState<AudioInputState>("idle")
	const [peaks, setPeaks] = useState<number[]>([])
	const [error, setError] = useState("")
	const session = useRef("")
	const context = useRef<AudioContext | undefined>(undefined)
	const stream = useRef<MediaStream | undefined>(undefined)
	const node = useRef<AudioWorkletNode | undefined>(undefined)
	const pendingPcm = useRef<number[]>([])
	const upload = useRef<Promise<void>>(Promise.resolve())
	const lastPeakUpdate = useRef(0)
	const enabled = useRef(false)
	const finishing = useRef(false)
	const stopAfterUtterance = useRef(false)
	const speechStarted = useRef(false)
	const lastSpeechAt = useRef(0)
	const captureGeneration = useRef(0)
	const onCommitRef = useRef(onCommit)
	onCommitRef.current = onCommit

	const cleanup = useCallback(async () => {
		node.current?.disconnect()
		node.current = undefined
		stream.current?.getTracks().forEach((track) => track.stop())
		stream.current = undefined
		const activeContext = context.current
		context.current = undefined
		if (activeContext && activeContext.state !== "closed") await activeContext.close()
	}, [])

	const queueChunk = useCallback((samples: number[]) => {
		const id = session.current
		upload.current = upload.current.then(async () => {
			await requestRuntime("audio.chunk", { id, sample_rate: TARGET_RATE, samples })
		}).catch(async cause => {
			if (session.current !== id || !enabled.current) return
			enabled.current = false
			await cleanup()
			void requestRuntime("audio.cancel", { id }).catch(() => undefined)
			setError(cause instanceof Error ? cause.message : String(cause))
			setState("error")
		})
	}, [cleanup])

	const beginSession = useCallback(async () => {
		session.current = crypto.randomUUID()
		pendingPcm.current = []
		upload.current = Promise.resolve()
		speechStarted.current = false
		lastSpeechAt.current = 0
		await requestRuntime("audio.start", { id: session.current })
	}, [])

	const finishUtterance = useCallback(async () => {
		if (finishing.current || !enabled.current || !speechStarted.current) return
		finishing.current = true
		const operation = captureGeneration.current
		setState("transcribing")
		if (pendingPcm.current.length) queueChunk(pendingPcm.current.splice(0))
		try {
			await upload.current
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) return
			const result = await requestRuntime<{ text: string }>("audio.finish", { id: session.current })
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) return
			if (result.text.trim()) onCommitRef.current(result.text.trim())
			setPeaks([])
			if (stopAfterUtterance.current) {
				enabled.current = false
				await cleanup()
				setState("idle")
				return
			}
			if (enabled.current) {
				await beginSession()
				setState("recording")
			}
		} catch (cause) {
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) return
			enabled.current = false
			await cleanup()
			void requestRuntime("audio.cancel", { id: session.current }).catch(() => undefined)
			setError(cause instanceof Error ? cause.message : String(cause))
			setState("error")
		} finally {
			if (captureGeneration.current === operation) finishing.current = false
		}
	}, [beginSession, cleanup, queueChunk])

	const start = useCallback(async () => {
		if (state !== "idle" && state !== "error") return
		setState("requesting")
		setError("")
		setPeaks([])
		enabled.current = true
		finishing.current = false
		stopAfterUtterance.current = false
		const operation = ++captureGeneration.current
		try {
			await beginSession()
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) return
			const media = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			})
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) {
				media.getTracks().forEach((track) => track.stop())
				return
			}
			stream.current = media
			context.current = new AudioContext({ sampleRate: TARGET_RATE })
			await context.current.audioWorklet.addModule(new URL("./audio-input.worklet.js", import.meta.url))
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) {
				await cleanup()
				return
			}
			const source = context.current.createMediaStreamSource(stream.current)
			node.current = new AudioWorkletNode(context.current, "octocode-audio-input")
			const mute = context.current.createGain()
			mute.gain.value = 0
			source.connect(node.current).connect(mute).connect(context.current.destination)
			node.current.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
				if (finishing.current || !enabled.current) return
				const resampled = resampleMono(new Float32Array(event.data), context.current?.sampleRate ?? TARGET_RATE)
				const peak = resampled.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0)
				const now = performance.now()
				if (now - lastPeakUpdate.current >= 50) {
					lastPeakUpdate.current = now
					setPeaks((current) => [...current.slice(-95), peak])
				}
				pendingPcm.current.push(...floatToPcm16(resampled))
				if (peak >= SPEECH_PEAK) {
					speechStarted.current = true
					lastSpeechAt.current = now
				}
				if (!speechStarted.current) {
					pendingPcm.current = pendingPcm.current.slice(-PRE_ROLL_SAMPLES)
					return
				}
				while (pendingPcm.current.length >= CHUNK_SAMPLES) {
					queueChunk(pendingPcm.current.splice(0, CHUNK_SAMPLES))
				}
				if (isUtteranceComplete(true, lastSpeechAt.current, now)) void finishUtterance()
			}
			setState("recording")
		} catch (cause) {
			if (!isCaptureCurrent(enabled.current, operation, captureGeneration.current)) return
			enabled.current = false
			await cleanup()
			void requestRuntime("audio.cancel", { id: session.current }).catch(() => undefined)
			setError(cause instanceof Error ? cause.message : String(cause))
			setState("error")
		}
	}, [beginSession, cleanup, finishUtterance, queueChunk, state])

	const cancel = useCallback(async () => {
		enabled.current = false
		captureGeneration.current++
		await cleanup()
		void upload.current.catch(() => undefined)
		void requestRuntime("audio.cancel", { id: session.current }).catch(() => undefined)
		pendingPcm.current = []
		setPeaks([])
		setState("idle")
	}, [cleanup])

	const stop = useCallback(async () => {
		if (!speechStarted.current && !finishing.current) return cancel()
		stopAfterUtterance.current = true
		await cleanup()
		await finishUtterance()
	}, [cancel, cleanup, finishUtterance])

	useEffect(() => {
		const generation = captureGeneration
		return () => {
			enabled.current = false
			generation.current++
			void cleanup()
			void upload.current.catch(() => undefined)
			void requestRuntime("audio.cancel", { id: session.current }).catch(() => undefined)
		}
	}, [cleanup])

	return { state, partial: "", peaks, error, start, stop, cancel }
}
