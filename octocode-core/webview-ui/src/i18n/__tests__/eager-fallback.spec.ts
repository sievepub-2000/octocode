import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import i18next, { registerLanguagePacks } from "../setup"

/**
 * Every English namespace must resolve the instant the module is imported.
 *
 * When locale loading became lazy, only `common` stayed synchronous. i18next has
 * no loading state and react-i18next does not re-render on `addResourceBundle`,
 * so every string from any other namespace painted as its own key — the release
 * dialog literally read "announcement.title", and the composer placeholder read
 * "typeTask". No unit test caught it because nothing asserted on resolved text.
 *
 * These tests deliberately do NOT await anything: awaiting would let the lazy
 * load finish and hide exactly the failure being guarded against.
 */

const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "locales", "en")

function englishNamespaces(): string[] {
	return fs
		.readdirSync(localesDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.basename(f, ".json"))
		.sort()
}

/** Every leaf key path in an object, as "a.b.c". */
function leafKeys(value: unknown, prefix = ""): string[] {
	if (value === null || typeof value !== "object") return [prefix]
	return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
		leafKeys(v, prefix ? `${prefix}.${k}` : k),
	)
}

describe("English translations are available without awaiting a load", () => {
	it("registers every namespace that ships in locales/en", () => {
		const missing = englishNamespaces().filter((ns) => !i18next.hasResourceBundle("en", ns))
		expect(missing).toEqual([])
	})

	it("resolves the strings that previously rendered as raw keys", () => {
		// The exact keys observed rendering as keys in the running product.
		const regressions = [
			"chat:announcement.title",
			"chat:announcement.release.heading",
			"chat:announcement.release.highlight1",
			"chat:announcement.release.highlight2",
			"chat:announcement.release.highlight3",
			"chat:announcement.support",
		]

		const unresolved = regressions.filter((key) => {
			const text = i18next.t(key, { version: "1.2.3" })
			// i18next returns the key itself (minus namespace) when it cannot resolve.
			return text === key || text === key.split(":")[1]
		})
		expect(unresolved).toEqual([])
	})

	it("resolves at least one real string from every namespace", () => {
		const failures: string[] = []
		for (const ns of englishNamespaces()) {
			const bundle = i18next.getResourceBundle("en", ns)
			const firstKey = leafKeys(bundle)[0]
			if (!firstKey) {
				failures.push(`${ns}: empty bundle`)
				continue
			}
			const text = i18next.t(`${ns}:${firstKey}`)
			if (text === firstKey || text === `${ns}:${firstKey}`) {
				failures.push(`${ns}:${firstKey} did not resolve`)
			}
		}
		expect(failures).toEqual([])
	})

	it("re-renders when a lazily loaded bundle arrives", () => {
		// addResourceBundle emits `added`; if react-i18next is not bound to it the
		// UI silently keeps the strings it first painted.
		const bound = String(i18next.options.react?.bindI18nStore ?? "")
		expect(bound).toContain("added")
	})

	it("restores builtin translations and removes custom keys when a pack is removed", async () => {
		const original = i18next.t("common:ui.openFolder", { lng: "en" })
		try {
			await registerLanguagePacks([
				{
					schemaVersion: 1,
					locale: "en",
					name: "Test",
					resources: { common: { ui: { openFolder: "Override", testOnly: "Temporary" } } },
				},
			])
			expect(i18next.t("common:ui.openFolder", { lng: "en" })).toBe("Override")
			await registerLanguagePacks([])
			expect(i18next.t("common:ui.openFolder", { lng: "en" })).toBe(original)
			expect(i18next.exists("common:ui.testOnly", { lng: "en" })).toBe(false)
		} finally {
			await registerLanguagePacks([])
		}
	})
})
