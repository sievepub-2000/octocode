import { describe, expect, it } from "vitest"

const localeFiles = import.meta.glob("./*/common.json", { eager: true }) as Record<string, { default: unknown }>
const MANAGEMENT_MENU_KEYS = [
	"tasks",
	"newTask",
	"research",
	"moreActions",
	"settings",
	"configureDisplayLanguage",
	"selectColorTheme",
] as const

describe("management menu translations", () => {
	it("defines every TaskNavigationView label for every shipped locale", () => {
		for (const [path, module] of Object.entries(localeFiles)) {
			const octocode = (module.default as { octocode?: Record<string, unknown> }).octocode
			for (const key of MANAGEMENT_MENU_KEYS) {
				const label = octocode?.[key]
				expect(label, `${path}: octocode.${key}`).toEqual(expect.any(String))
				expect(String(label).trim(), `${path}: octocode.${key}`).not.toBe("")
			}
		}
	})
})
