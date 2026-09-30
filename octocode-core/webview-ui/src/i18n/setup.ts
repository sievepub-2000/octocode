import i18next from "i18next"
import { initReactI18next } from "react-i18next"
import type { LanguagePackManifest } from "@roo-code/types"
import { DEFAULT_LANGUAGE } from "@roo/language"

// English is the fallback language, so ALL of its namespaces have to be present
// synchronously — not just `common`. Anything missing at first paint renders as
// the raw key ("chat:announcement.title") rather than as text, because i18next
// has no loading state and react-i18next does not re-render when a bundle is
// added later. Shipping one locale eagerly costs 132 KB; the problem this file
// originally fixed was all eighteen locales at 2.7 MB, so this keeps ~95% of
// that win while making a raw key impossible.
import enChat from "./locales/en/chat.json"
import enCommon from "./locales/en/common.json"
import enHistory from "./locales/en/history.json"
import enMarketplace from "./locales/en/marketplace.json"
import enMcp from "./locales/en/mcp.json"
import enPrompts from "./locales/en/prompts.json"
import enSettings from "./locales/en/settings.json"
import enWelcome from "./locales/en/welcome.json"
import enWorktrees from "./locales/en/worktrees.json"

const EN_RESOURCES = {
	chat: enChat,
	common: enCommon,
	history: enHistory,
	marketplace: enMarketplace,
	mcp: enMcp,
	prompts: enPrompts,
	settings: enSettings,
	welcome: enWelcome,
	worktrees: enWorktrees,
}

// Every other locale is fetched on demand.
//
// This glob used to be `eager: true`, which pulled all eighteen locales -- over
// 2 MB of JSON -- into the startup chunk and parsed the lot before the window
// could paint, so opening the UI paid for seventeen languages nobody had asked
// for. Lazy is the same feature at a fraction of the cost: switching language
// fetches one locale, and the fallback below covers the gap while it loads.
const localeLoaders = import.meta.glob("./locales/**/*.json") as Record<
	string,
	() => Promise<{ default: Record<string, unknown> }>
>

const LOCALE_PATH = /\.\/locales\/([^/]+)\/([^/]+)\.json$/

/** Locales this build ships, derived from the files themselves. */
export function availableLocales(): string[] {
	const seen = new Set<string>()
	for (const path of Object.keys(localeLoaders)) {
		const match = path.match(LOCALE_PATH)
		if (match) {
			seen.add(match[1])
		}
	}
	return [...seen].sort()
}

// Keyed by language, holding the in-flight load rather than a done flag, so
// two components asking for the same language both wait for the same fetch
// instead of the second one returning before the strings have arrived.
const inFlight = new Map<string, Promise<void>>()

/**
 * Load one locale's namespaces into i18next.
 *
 * Resolves once the language is usable. Repeat calls for a language already
 * loaded return immediately, so callers can call it freely on every change.
 */
export function loadLocale(language: string): Promise<void> {
	const existing = inFlight.get(language)
	if (existing) {
		return existing
	}

	const pending = loadLocaleNow(language).then((complete) => {
		if (!complete) inFlight.delete(language)
	})
	inFlight.set(language, pending)
	return pending
}

async function loadLocaleNow(language: string): Promise<boolean> {
	const entries = Object.entries(localeLoaders).filter(([path]) => {
		const match = path.match(LOCALE_PATH)
		return match?.[1] === language
	})

	let complete = true
	await Promise.all(
		entries.map(async ([path, load]) => {
			const namespace = path.match(LOCALE_PATH)?.[2]
			if (!namespace) {
				return
			}
			try {
				const module = await load()
				i18next.addResourceBundle(language, namespace, module.default ?? module, true, true)
			} catch (error) {
				complete = false
				// A missing or malformed locale must not take the UI down; the
				// English fallback below still renders every string.
				console.warn(`Could not load ${language}/${namespace} translations:`, error)
			}
		}),
	)
	return complete
}

i18next.use(initReactI18next).init({
	lng: DEFAULT_LANGUAGE,
	fallbackLng: "en",
	debug: false,
	resources: { en: EN_RESOURCES },
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
	react: {
		// react-i18next binds only `languageChanged` by default, so a bundle that
		// arrives from a lazy locale load updates i18next without re-rendering
		// anything — the UI keeps showing whatever it first painted. `added` is
		// what `addResourceBundle` emits, so it has to be bound for lazy loading
		// to be visible at all.
		bindI18n: "languageChanged loaded",
		bindI18nStore: "added removed",
	},
})

/** Load the remaining English namespaces, then the default language. */
export function loadTranslations() {
	void loadLocale("en").then(() => {
		if (DEFAULT_LANGUAGE !== "en") {
			return loadLocale(DEFAULT_LANGUAGE)
		}
	})
}

const originalBundles = new Map<string, { locale: string; namespace: string; resources?: Record<string, unknown> }>()
let packRevision = 0

export async function registerLanguagePacks(packs: LanguagePackManifest[]) {
	const revision = ++packRevision
	await Promise.all([...new Set(packs.map((pack) => pack.locale))].map(loadLocale))
	if (revision !== packRevision) return
	for (const { locale, namespace, resources } of originalBundles.values()) {
		i18next.removeResourceBundle(locale, namespace)
		if (resources) i18next.addResourceBundle(locale, namespace, resources, true, true)
	}
	originalBundles.clear()
	for (const pack of packs) {
		for (const [namespace, resources] of Object.entries(pack.resources)) {
			const key = `${pack.locale}:${namespace}`
			if (!originalBundles.has(key)) {
				const original = i18next.getResourceBundle(pack.locale, namespace)
				originalBundles.set(key, {
					locale: pack.locale,
					namespace,
					resources: original ? structuredClone(original) : undefined,
				})
			}
			i18next.addResourceBundle(pack.locale, namespace, resources, true, true)
		}
	}
}

export default i18next
