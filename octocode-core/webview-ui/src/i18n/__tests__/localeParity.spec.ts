import i18next, { availableLocales, loadLocale } from "../setup"

function strings(value: unknown, prefix = ""): Array<[string, string]> {
	if (typeof value === "string") return [[prefix, value]]
	if (!value || typeof value !== "object" || Array.isArray(value)) return []
	return Object.entries(value).flatMap(([key, item]) => strings(item, prefix ? `${prefix}.${key}` : key))
}

const variables = (text: string) => [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]).sort()

describe("bundled locale coverage", () => {
	it.each(availableLocales())("loads %s with every English key and interpolation variable", async (locale) => {
		await loadLocale("en")
		await loadLocale(locale)
		const failures: string[] = []
		for (const namespace of Object.keys(i18next.getDataByLanguage("en") ?? {})) {
			for (const [key, source] of strings(i18next.getResourceBundle("en", namespace))) {
				const target = i18next.getResource(locale, namespace, key)
				if (
					typeof target !== "string" ||
					JSON.stringify(variables(target)) !== JSON.stringify(variables(source))
				) {
					failures.push(`${namespace}:${key}`)
				}
			}
		}
		expect(failures).toEqual([])
	})
})
