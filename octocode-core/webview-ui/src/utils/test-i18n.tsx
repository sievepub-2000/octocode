import type { ReactNode } from "react"

import i18next from "i18next"

import { DEFAULT_LANGUAGE } from "@roo/language"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { loadLocale } from "@src/i18n/setup"

/**
 * Translations for specs, kept in their own module.
 *
 * Importing it pulls in `@src/i18n/setup`, which registers itself with
 * react-i18next — so a spec that replaces that module with a stub must keep the
 * original exports (`importOriginal`) or this will not load. That is why this
 * lives here rather than in `test-utils`, which nearly every spec imports.
 */
export async function loadUiLanguage(language: string = DEFAULT_LANGUAGE) {
	await loadLocale(language)
	await i18next.changeLanguage(language)
}

/**
 * Renders children with a translation context that actually translates.
 *
 * `useAppTranslation` falls back to returning the key when no provider is above
 * it, and the real provider wants extension state and a live message channel —
 * far more than a component test has. This gives the same contract backed by
 * i18next, so assertions can name what a person would read.
 */
export const WithTranslations = ({ children }: { children: ReactNode }) => (
	<TranslationContext.Provider
		value={{
			t: (key: string, options?: Record<string, unknown>) => i18next.t(key, options),
			i18n: i18next,
			languagePacks: [],
		}}>
		{children}
	</TranslationContext.Provider>
)
