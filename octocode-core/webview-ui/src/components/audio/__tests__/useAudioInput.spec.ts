import { describe, expect, it } from "vitest"

import { floatToPcm16, isCaptureCurrent, isUtteranceComplete, pcmChunks, resampleMono } from "../useAudioInput"

describe("audio input conversion", () => {
	it("resamples mono PCM to 16 kHz and clamps signed samples", () => {
		expect(resampleMono(new Float32Array([0, 0.5, 1, 0.5]), 32_000)).toHaveLength(2)
		expect(Array.from(floatToPcm16(new Float32Array([-2, 0, 2])))).toEqual([-32_768, 0, 32_767])
	})

	it("splits files into host-sized PCM batches", () => {
		const chunks = pcmChunks(new Float32Array(16_001).fill(0.5), 16_000)
		expect(chunks.map((chunk) => chunk.length)).toEqual([16_000, 1])
	})

	it("ends an utterance only after speech followed by silence", () => {
		expect(isUtteranceComplete(false, 0, 2_000)).toBe(false)
		expect(isUtteranceComplete(true, 1_500, 2_000)).toBe(false)
		expect(isUtteranceComplete(true, 1_000, 2_000)).toBe(true)
	})

	it("rejects capture work after voice mode is disabled or superseded", () => {
		expect(isCaptureCurrent(true, 4, 4)).toBe(true)
		expect(isCaptureCurrent(false, 4, 4)).toBe(false)
		expect(isCaptureCurrent(true, 4, 5)).toBe(false)
	})
})
