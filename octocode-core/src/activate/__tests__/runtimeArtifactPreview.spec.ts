import { describe, expect, it, vi } from "vitest"
import { previewRuntimeArtifact } from "../runtimeArtifactPreview"

describe("automatic runtime artifact preview", () => {
	it("reports a missing log without opening an editor or exposing raw errors", async () => {
		const show = vi.fn()
		const failure = vi.fn()
		await previewRuntimeArtifact("D:/owned/terminal/missing.log", show, failure, async () => {
			throw new Error("secret-bearing backend detail")
		})
		expect(show).not.toHaveBeenCalled()
		expect(failure).toHaveBeenCalledWith("missing.log")
	})
	it("opens exactly the existing path without UUID substitution", async () => {
		const show = vi.fn()
		const failure = vi.fn()
		await previewRuntimeArtifact("D:/owned/terminal/call_owned.log", show, failure, async () => undefined)
		expect(show).toHaveBeenCalledWith("D:/owned/terminal/call_owned.log")
		expect(failure).not.toHaveBeenCalled()
	})
	it("reports an open failure after a successful stat", async () => {
		const failure = vi.fn()
		await previewRuntimeArtifact(
			"D:/owned/call_owned.log",
			async () => {
				throw new Error("removed")
			},
			failure,
			async () => undefined,
		)
		expect(failure).toHaveBeenCalledWith("call_owned.log")
	})
})
