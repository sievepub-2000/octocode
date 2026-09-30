import { useCallback, useEffect, useRef, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

import { requestRuntime } from "@src/utils/runtimeRequest"
import { pcmChunks } from "../audio/useAudioInput"

const SEGMENT_SECONDS = 30

const AudioWaveform = ({ src }: { src: string }) => {
	const { t } = useTranslation("chat")
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const decoded = useRef<{ samples: Float32Array; sampleRate: number } | undefined>(undefined)
	const [transcript, setTranscript] = useState("")
	const [transcribing, setTranscribing] = useState(false)
	const [error, setError] = useState("")
	const [ready, setReady] = useState(false)
	const active = useRef<{ id?: string } | undefined>(undefined)
	const cancel = useCallback(() => {
		const operation = active.current
		active.current = undefined
		if (operation?.id) void requestRuntime("audio.cancel", { id: operation.id }).catch(() => undefined)
	}, [])

	useEffect(() => {
		const controller = new AbortController()
		decoded.current = undefined
		setReady(false)
		setTranscribing(false)
		setTranscript("")
		setError("")
		void (async () => {
			const context = new AudioContext()
			try {
				const response = await fetch(src, { signal: controller.signal })
				if (!response.ok) throw new Error(`Audio download failed (${response.status})`)
				const buffer = await context.decodeAudioData(await response.arrayBuffer())
				if (controller.signal.aborted) return
				const samples = buffer.getChannelData(0).slice()
				decoded.current = { samples, sampleRate: buffer.sampleRate }
				setReady(true)
				const canvas = canvasRef.current
				const drawing = canvas?.getContext("2d")
				if (!canvas || !drawing) return
				drawing.clearRect(0, 0, canvas.width, canvas.height)
				drawing.strokeStyle =
					getComputedStyle(document.body).getPropertyValue("--vscode-focusBorder") || "#3794ff"
				drawing.beginPath()
				const step = Math.max(1, Math.floor(samples.length / canvas.width))
				for (let x = 0; x < canvas.width; x++) {
					let peak = 0
					for (let index = x * step; index < Math.min(samples.length, (x + 1) * step); index++) {
						peak = Math.max(peak, Math.abs(samples[index]))
					}
					drawing.moveTo(x, canvas.height * (0.5 - peak * 0.45))
					drawing.lineTo(x, canvas.height * (0.5 + peak * 0.45))
				}
				drawing.stroke()
			} finally {
				await context.close()
			}
		})().catch((cause) => {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
		})
		return () => {
			controller.abort()
			cancel()
		}
	}, [src, cancel])

	const transcribe = async () => {
		if (!decoded.current || active.current) return
		const operation: { id?: string } = {}
		active.current = operation
		setTranscribing(true)
		setTranscript("")
		setError("")
		const { samples, sampleRate } = decoded.current
		const segmentSize = sampleRate * SEGMENT_SECONDS
		let complete = ""
		try {
			for (let offset = 0; offset < samples.length; offset += segmentSize) {
				if (active.current !== operation) return
				const id = crypto.randomUUID()
				operation.id = id
				try {
					await requestRuntime("audio.start", { id })
					if (active.current !== operation) {
						void requestRuntime("audio.cancel", { id }).catch(() => undefined)
						return
					}
					for (const chunk of pcmChunks(samples.subarray(offset, offset + segmentSize), sampleRate)) {
						if (active.current !== operation) return
						await requestRuntime("audio.chunk", { id, sample_rate: 16_000, samples: chunk })
					}
					const result = await requestRuntime<{ text: string }>("audio.finish", { id })
					if (active.current !== operation) return
					complete = `${complete} ${result.text}`.trim()
					setTranscript(complete)
				} catch (cause) {
					void requestRuntime("audio.cancel", { id }).catch(() => undefined)
					throw cause
				}
			}
		} catch (cause) {
			if (active.current === operation) setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			if (active.current === operation) {
				active.current = undefined
				setTranscribing(false)
			}
		}
	}

	return (
		<div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)] place-content-center gap-4 p-4">
			<canvas ref={canvasRef} height={180} width={900} />
			<div className="flex items-center gap-2">
				<audio className="min-w-0 flex-1" controls src={src} />
				<button
					className="inline-flex items-center gap-2 rounded bg-vscode-button-background px-3 py-2 text-vscode-button-foreground disabled:opacity-50"
					disabled={!ready || transcribing}
					onClick={() => void transcribe()}>
					{transcribing && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
					{t(transcribing ? "transcribingAudio" : "transcribeAudio")}
				</button>
				{transcribing && (
					<button
						type="button"
						aria-label={t("common:ui.cancelTranscription")}
						onClick={() => {
							cancel()
							setTranscribing(false)
						}}>
						{t("common:ui.cancelTranscribing")}
					</button>
				)}
			</div>
			<div className="min-h-0 overflow-auto whitespace-pre-wrap" aria-live="polite">
				{error || transcript || t("transcript")}
			</div>
		</div>
	)
}

export default AudioWaveform
