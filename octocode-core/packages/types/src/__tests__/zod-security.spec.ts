import { describe, expect, it } from "vitest"
import { z } from "zod/v4"

import { toolUsageSchema } from "../tool.js"

describe("Zod collection resource limits", () => {
	it("rejects oversized attacker-controlled collections before parsing elements", async () => {
		let parsed = 0
		const element = z.preprocess((value) => {
			parsed++
			return value
		}, z.string())
		const values = Array.from({ length: 100_000 }, (_, index) => index)
		for (const [schema, input] of [
			[z.array(element).max(2), values],
			[z.array(element).length(2), values],
			[z.set(element).max(2), new Set(values)],
			[z.map(element, element).max(2), new Map(values.map((value) => [value, value]))],
		] as const) {
			for (const result of [schema.safeParse(input), await schema.safeParseAsync(input)]) {
				expect(result.success).toBe(false)
				if (!result.success) expect(result.error.issues).toMatchObject([{ code: "too_big" }])
				if (!result.success) expect(result.error.issues).toHaveLength(1)
			}
		}
		expect(parsed).toBe(0)
	})

	it("keeps sparse tool-usage records compatible and rejects unknown tools", () => {
		expect(toolUsageSchema.parse({})).toEqual({})
		expect(toolUsageSchema.parse({ read_file: { attempts: 1, failures: 0 } })).toEqual({
			read_file: { attempts: 1, failures: 0 },
		})
		expect(toolUsageSchema.safeParse({ unknown_tool: { attempts: 1, failures: 0 } }).success).toBe(false)
	})
})
