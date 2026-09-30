import { describe, expect, it, vi } from "vitest"

import { withRetries } from "../node-host"

describe("toolchain download retries", () => {
	it("retries a transient network failure and returns the eventual result", async () => {
		const work = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(
				new Error("Client network socket disconnected before secure TLS connection was established"),
			)
			.mockResolvedValueOnce("ok")
		await expect(withRetries("Rust download", work, 3, 1)).resolves.toBe("ok")
		expect(work).toHaveBeenCalledTimes(2)
	})

	it("does not retry a failure that is not transient", async () => {
		const work = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("HTTP 404"))
		await expect(withRetries("Rust download", work, 3, 1)).rejects.toThrow("Rust download failed: HTTP 404")
		expect(work).toHaveBeenCalledTimes(1)
	})

	it("gives up after the last attempt", async () => {
		const work = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("read ECONNRESET"))
		await expect(withRetries("Rust download", work, 3, 1)).rejects.toThrow("ECONNRESET")
		expect(work).toHaveBeenCalledTimes(3)
	})
})
