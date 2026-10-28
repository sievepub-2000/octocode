import { describe, expect, it, vi } from "vitest"
import { readEventPages } from "../runtimeHistory"

describe("bounded event reads", () => {
	it("follows the raw cursor even when presentation compacts a full page", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce({ rows: [[2000, "text", { data: "first" }]], next: 2000, has_more: true })
			.mockResolvedValueOnce({ rows: [[2001, "text", { data: "last" }]], next: 2001, has_more: false })
		const rows = []
		for await (const page of readEventPages({ call }, "session", 0, true)) rows.push(...page)
		expect(rows.map((row) => row[0])).toEqual([2000, 2001])
		expect(call).toHaveBeenLastCalledWith("event.page", {
			session_id: "session",
			after: 2000,
			limit: 2000,
			presentation: true,
			include_timestamps: true,
		})
	})
	it("rejects a stuck cursor instead of looping indefinitely", async () => {
		const call = vi.fn().mockResolvedValue({ rows: [], next: 0, has_more: true })
		await expect(readEventPages({ call }, "session").next()).rejects.toThrow("Invalid history cursor")
	})
})
