import { act } from "react"

import { render } from "@/utils/test-utils"

import TranslationProvider, { useAppTranslation } from "../TranslationContext"

const { postMessage, registerLanguagePacks, listeners, i18nSingleton } = vi.hoisted(() => {
	const listeners = new Map<string, Set<() => void>>()
	const translate = (key: string, options?: Record<string, any>) => {
		if (key === "settings.autoApprove.title") return "Auto-Approve"
		if (key === "notifications.error") {
			return options?.message ? `Operation failed: ${options.message}` : "Operation failed"
		}
		return key
	}
	return {
		postMessage: vi.fn(),
		registerLanguagePacks: vi.fn(),
		listeners,
		/*
		 * One object for the whole suite, as in production.
		 *
		 * i18next is a singleton there, which is the entire reason a `t` memoized on
		 * it alone never changes identity. A mock that returned a fresh object per
		 * render would hand out a new `t` every time and quietly make the identity
		 * test below pass regardless of the provider's behaviour.
		 */
		i18nSingleton: {
			store: {
				on: (event: string, handler: () => void) => {
					const key = `store:${event}`
					if (!listeners.has(key)) listeners.set(key, new Set())
					listeners.get(key)!.add(handler)
				},
				off: (event: string, handler: () => void) => listeners.get(`store:${event}`)?.delete(handler),
			},
			t: translate,
			changeLanguage: vi.fn(),
			on: (event: string, handler: () => void) => {
				if (!listeners.has(event)) listeners.set(event, new Set())
				listeners.get(event)!.add(handler)
			},
			off: (event: string, handler: () => void) => listeners.get(event)?.delete(handler),
		},
	}
})

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		language: "en",
	}),
}))

vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ i18n: i18nSingleton }),
}))

vi.mock("../setup", () => ({
	default: i18nSingleton,
	loadTranslations: vi.fn(),
	// Locales are fetched on demand now, so the provider awaits this before
	// switching language; resolve immediately so the switch still lands within
	// the test's first flush.
	loadLocale: vi.fn(() => Promise.resolve()),
	availableLocales: vi.fn(() => ["en"]),
	registerLanguagePacks,
}))

const TestComponent = () => {
	const { t } = useAppTranslation()
	return (
		<div>
			<h1 data-testid="translation-test">{t("settings.autoApprove.title")}</h1>
			<p data-testid="translation-interpolation">{t("notifications.error", { message: "Test error" })}</p>
		</div>
	)
}

describe("TranslationContext", () => {
	it("loads external language packs from the extension host", () => {
		render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		expect(postMessage).toHaveBeenCalledWith({ type: "requestLanguagePacks" })
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "languagePacks",
					payload: {
						packs: [{ schemaVersion: 1, locale: "fr-CA", name: "Français (Canada)", resources: {} }],
					},
				},
			}),
		)
		expect(registerLanguagePacks).toHaveBeenCalledWith([
			expect.objectContaining({ locale: "fr-CA", name: "Français (Canada)" }),
		])
	})

	it("should provide translations via context", () => {
		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		// Check if translation is provided correctly
		expect(getByTestId("translation-test")).toHaveTextContent("Auto-Approve")
	})

	it.each(["languageChanged", "store:added", "store:removed"])("refreshes translations on %s", (event) => {
		/*
		 * i18n is a singleton, so a t memoized on it alone keeps one identity for
		 * the life of the app — and every useMemo(..., [t]) in the UI then holds the
		 * values it computed on first render. Invisible on a normal start, where the
		 * language is set before anything renders; very visible when a webview is
		 * reopened, which came back with half its labels in English and never
		 * corrected itself.
		 */
		const seen: Array<(key: string) => string> = []
		const Probe = () => {
			const { t } = useAppTranslation()
			seen.push(t)
			return null
		}
		render(
			<TranslationProvider>
				<Probe />
			</TranslationProvider>,
		)

		const before = seen.at(-1)
		act(() => {
			for (const handler of listeners.get(event) ?? []) handler()
		})

		expect(seen.at(-1)).not.toBe(before)
	})

	it("should handle interpolation correctly", () => {
		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		// Check if interpolation works
		expect(getByTestId("translation-interpolation")).toHaveTextContent("Operation failed: Test error")
	})
})
