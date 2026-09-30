// npx vitest run src/shared/__tests__/language.spec.ts

import { DEFAULT_LANGUAGE, formatLanguage, resolveActivationLanguage } from "../language"

describe("formatLanguage", () => {
	it.each([
		["en-US", "en"],
		["fr-ca", "fr"],
		["pt", "pt-BR"],
		["zh-hk", "zh-TW"],
		["zh-hans", "zh-CN"],
		["unsupported", "en"],
	])("maps desktop locale %s to %s", (locale, expected) => {
		expect(formatLanguage(locale)).toBe(expected)
	})
	it("should uppercase region code in locale string", () => {
		expect(formatLanguage("pt-br")).toBe("pt-BR")
		expect(formatLanguage("zh-cn")).toBe("zh-CN")
	})

	it("should return original string if no region code present", () => {
		expect(formatLanguage("en")).toBe("en")
		expect(formatLanguage("fr")).toBe("fr")
	})

	it("should handle empty or undefined input", () => {
		expect(DEFAULT_LANGUAGE).toBe("zh-CN")
		expect(formatLanguage("")).toBe(DEFAULT_LANGUAGE)
		expect(formatLanguage(undefined as unknown as string)).toBe(DEFAULT_LANGUAGE)
	})

	it("uses the native VS Code locale when initializing extension language state", () => {
		expect(resolveActivationLanguage(undefined, "zh-cn")).toEqual({ language: "zh-CN", shouldPersist: true })
		expect(resolveActivationLanguage("en", "zh-cn")).toEqual({ language: "zh-CN", shouldPersist: true })
		expect(resolveActivationLanguage("zh-CN", "zh-cn")).toEqual({ language: "zh-CN", shouldPersist: false })
	})
})
