import { describe, expect, it, vi } from "vitest"
import { hasRuntimeEvent } from "../runtimeEventExists"

describe("handoff cleanup event existence", () => {
	it("finds a start after 2000 events without requesting raw history", async () => {
		const first = Array.from({ length: 2000 }, (_, i) => [i + 1, "text", { data: "fixture" }])
		const call = vi
			.fn()
			.mockResolvedValueOnce({ rows: first, next: 2000, has_more: true })
			.mockResolvedValueOnce({
				rows: [
					[2001, "text", null],
					[2002, "agent.started", null],
				],
				next: 2002,
				has_more: false,
			})
		await expect(hasRuntimeEvent({ call }, "session", "agent.started")).resolves.toBe(true)
		expect(call.mock.calls).toEqual([
			["event.page", { session_id: "session", after: 0, limit: 2000, presentation: false }],
			["event.page", { session_id: "session", after: 2000, limit: 2000, presentation: false }],
		])
	})
	it("stops after a valid page containing the event", async () => {
		const call = vi.fn().mockResolvedValue({ rows: [[1, "agent.started", null]], next: 1, has_more: true })
		await expect(hasRuntimeEvent({ call }, "session", "agent.started")).resolves.toBe(true)
		expect(call).toHaveBeenCalledTimes(1)
	})
	it("returns false only after the final valid page", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce({ rows: [[7, "text", null]], next: 7, has_more: true })
			.mockResolvedValueOnce({ rows: [], next: 7, has_more: false })
		await expect(hasRuntimeEvent({ call }, "session", "agent.started")).resolves.toBe(false)
		expect(call).toHaveBeenCalledTimes(2)
	})
	it.each([
		null,
		{ rows: [], next: 0, has_more: "false" },
		{ rows: [], next: 0, has_more: true },
		{ rows: [], next: 1, has_more: false },
		{ rows: [[1, "text"]], next: 1, has_more: false },
		{ rows: [[1, 42, null]], next: 1, has_more: false },
		{ rows: [[0, "text", null]], next: 0, has_more: false },
		{
			rows: [
				[2, "text", null],
				[1, "text", null],
			],
			next: 2,
			has_more: false,
		},
		{
			rows: [
				[1, "text", null],
				[1, "text", null],
			],
			next: 1,
			has_more: false,
		},
		{ rows: [[2, "text", null]], next: 1, has_more: false },
		{ rows: [[1, "text", null]], next: 2, has_more: false },
		{ rows: [[Number.MAX_SAFE_INTEGER + 1, "text", null]], next: Number.MAX_SAFE_INTEGER + 1, has_more: false },
		{ rows: Array.from({ length: 2001 }, (_, i) => [i + 1, "text", null]), next: 2001, has_more: false },
	])("rejects malformed pages so cleanup keeps the session", async (page) => {
		await expect(
			hasRuntimeEvent({ call: vi.fn().mockResolvedValue(page) }, "session", "agent.started"),
		).rejects.toThrow("Invalid event existence page")
	})
	it("rejects a backwards cursor on a later page", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce({ rows: [[3, "text", null]], next: 3, has_more: true })
			.mockResolvedValueOnce({ rows: [], next: 2, has_more: false })
		await expect(hasRuntimeEvent({ call }, "session", "agent.started")).rejects.toThrow(
			"Invalid event existence page",
		)
	})
	it("propagates RPC timeout/error without reporting absence", async () => {
		const error = new Error("fixture RPC timeout")
		await expect(
			hasRuntimeEvent({ call: vi.fn().mockRejectedValue(error) }, "session", "agent.started"),
		).rejects.toBe(error)
	})
	it("throws when the page budget is exhausted", async () => {
		const call = vi.fn().mockResolvedValue({ rows: [[1, "text", null]], next: 1, has_more: true })
		await expect(hasRuntimeEvent({ call }, "session", "agent.started", 1)).rejects.toThrow(
			"Event existence page budget exhausted",
		)
		expect(call).toHaveBeenCalledTimes(1)
	})
})
