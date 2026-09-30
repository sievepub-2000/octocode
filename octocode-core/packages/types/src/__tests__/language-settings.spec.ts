import { describe, expect, it } from "vitest"

import { globalSettingsSchema } from "../global-settings.js"

describe("external display languages", () => {
	it("accepts an installed locale identifier", () => {
		expect(globalSettingsSchema.pick({ language: true }).parse({ language: "fr-CA" })).toEqual({ language: "fr-CA" })
	})

	it("rejects path-like locale identifiers", () => {
		expect(() => globalSettingsSchema.pick({ language: true }).parse({ language: "../escape" })).toThrow()
	})
})
