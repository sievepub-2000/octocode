import { type Language, isLanguage } from "@roo-code/types"

export const DEFAULT_LANGUAGE: Language = "zh-CN"

/**
 * Language name mapping from ISO codes to full language names.
 */

export const LANGUAGES: Record<Language, string> = {
	ca: "Català",
	de: "Deutsch",
	en: "English",
	es: "Español",
	fr: "Français",
	hi: "हिन्दी",
	id: "Bahasa Indonesia",
	it: "Italiano",
	ja: "日本語",
	ko: "한국어",
	nl: "Nederlands",
	pl: "Polski",
	"pt-BR": "Português",
	ru: "Русский",
	tr: "Türkçe",
	vi: "Tiếng Việt",
	"zh-CN": "简体中文",
	"zh-TW": "繁體中文",
}

/**
 * Formats a VSCode locale string to ensure the region code is uppercase.
 * For example, transforms "en-us" to "en-US" or "fr-ca" to "fr-CA".
 *
 * @param vscodeLocale - The VSCode locale string to format (e.g., "en-us", "fr-ca")
 * @returns The formatted locale string with uppercase region code
 */

export function formatLanguage(vscodeLocale: string): Language {
	if (!vscodeLocale) {
		return DEFAULT_LANGUAGE
	}

	const formattedLocale = vscodeLocale.toLowerCase().replace(/-(\w+)$/, (_, region) => `-${region.toUpperCase()}`)
	if (isLanguage(formattedLocale)) return formattedLocale
	const base = formattedLocale.split("-")[0]
	if (isLanguage(base)) return base
	if (base === "pt") return "pt-BR"
	if (base === "zh") return /-(TW|HK|HANT)$/.test(formattedLocale) ? "zh-TW" : "zh-CN"
	return "en"
}

export function resolveActivationLanguage(
	storedLanguage: string | undefined,
	nativeLocale: string,
): { language: string; shouldPersist: boolean } {
	const nativeLanguage = formatLanguage(nativeLocale)
	return {
		language: nativeLanguage,
		shouldPersist: storedLanguage !== nativeLanguage,
	}
}
