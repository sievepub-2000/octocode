import React, { createContext, useContext, ReactNode, useEffect, useCallback, useState, useMemo } from "react"
import { I18nContext } from "react-i18next"
import type { LanguagePackManifest } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import i18next, { loadLocale, loadTranslations, registerLanguagePacks } from "./setup"
import { useExtensionState } from "@/context/ExtensionStateContext"

// Create context for translations
export const TranslationContext = createContext<{
	t: (key: string, options?: Record<string, any>) => string
	i18n: typeof i18next
	languagePacks: LanguagePackManifest[]
}>({
	t: (key: string) => key,
	i18n: i18next,
	languagePacks: [],
})

// Translation provider component
export const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Own the real instance: react-i18next hooks may return a language snapshot wrapper.
	const i18n = i18next
	// Get the extension state directly - it already contains all state properties
	const extensionState = useExtensionState()
	const [languagePacks, setLanguagePacks] = useState<LanguagePackManifest[]>([])

	// Load translations once when the component mounts
	useEffect(() => {
		try {
			loadTranslations()
		} catch (error) {
			console.error("Failed to load translations:", error)
		}
	}, [])

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "languagePacks") return
			const packs = event.data.payload?.packs ?? []
			void registerLanguagePacks(packs)
			setLanguagePacks(packs)
		}
		window.addEventListener("message", receive)
		vscode.postMessage({ type: "requestLanguagePacks" })
		return () => window.removeEventListener("message", receive)
	}, [])

	useEffect(() => {
		const language = extensionState.language
		if (!language) {
			return
		}
		// Locales are fetched on demand now, so the strings have to be in place
		// before the switch -- otherwise the UI flashes English first.
		let cancelled = false
		void loadLocale(language).then(() => {
			if (!cancelled) {
				i18n.changeLanguage(language)
			}
		})
		return () => {
			cancelled = true
		}
	}, [i18n, extensionState.language])

	/*
	 * Re-identify `t` whenever the strings behind it change.
	 *
	 * `i18n` is a stable singleton, so a callback memoized on it alone keeps the
	 * same identity for the life of the app, and every `useMemo(..., [t])` in the
	 * UI then holds the values it computed on first render. That is invisible on a
	 * normal start, where the language is set before anything renders, and very
	 * visible when a webview is reopened: the panel comes back with half its
	 * labels in English and never corrects itself.
	 */
	const [languageEpoch, setLanguageEpoch] = useState(0)
	useEffect(() => {
		const bump = () => setLanguageEpoch((epoch) => epoch + 1)
		i18n.on("languageChanged", bump)
		i18n.on("loaded", bump)
		i18n.store.on("added", bump)
		i18n.store.on("removed", bump)
		return () => {
			i18n.off("languageChanged", bump)
			i18n.off("loaded", bump)
			i18n.store.off("added", bump)
			i18n.store.off("removed", bump)
		}
	}, [i18n])

	const translate = useCallback(
		(key: string, options?: Record<string, any>) => {
			return i18n.t(key, options)
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the epoch is the point: it re-identifies `t` when the strings change.
		[i18n, languageEpoch],
	)

	// Include the epoch so compiler memoization cannot freeze the context value.
	const richTextContext = useMemo(() => ({ i18n, languageEpoch }), [i18n, languageEpoch])
	return (
		// Trans reads this context without subscribing to language/store events.
		// Refresh it with the app context so memoized rich text also updates.
		<I18nContext.Provider value={richTextContext}>
			<TranslationContext.Provider
				value={{
					t: translate,
					i18n,
					languagePacks,
				}}>
				{children}
			</TranslationContext.Provider>
		</I18nContext.Provider>
	)
}

// Custom hook for easy translations
export const useAppTranslation = () => useContext(TranslationContext)

export default TranslationProvider
