import { describe, expect, it } from "vitest"

const locales = import.meta.glob("../locales/*/chat.json", { eager: true, import: "default" }) as Record<
	string,
	Record<string, unknown>
>

describe("audio translations", () => {
	it("provides every audio label in every bundled locale", () => {
		const keys = [
			"startVoiceInput",
			"stopVoiceInput",
			"cancelVoiceInput",
			"listening",
			"transcribeAudio",
			"transcribingAudio",
			"transcript",
		]
		expect(Object.keys(locales)).toHaveLength(18)
		for (const [locale, messages] of Object.entries(locales)) {
			for (const key of keys) expect(messages[key], `${locale}:${key}`).toBeTypeOf("string")
		}
	})
})
