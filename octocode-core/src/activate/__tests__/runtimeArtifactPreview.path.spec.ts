import { describe, expect, it, vi } from "vitest"

// Use the real POSIX basename primitive to model native POSIX paths on this test host.
// Windows/UNC primitives remain real. This is string data, not filesystem/platform execution.
vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>()
	return { ...actual, basename: actual.posix.basename }
})

import { previewRuntimeArtifact } from "../runtimeArtifactPreview"

describe("runtime artifact failure basename for native and explicit Windows paths", () => {
	it("retains a POSIX backslash filename and reports no directory or backend error", async () => {
		const failure = vi.fn()
		const check = async () => undefined
		await previewRuntimeArtifact(
			"/owned/private-directory/artifact\\2024.log",
			async () => {
				throw new Error("secret-bearing open error")
			},
			failure,
			check,
		)
		expect(failure).toHaveBeenCalledTimes(1)
		expect(failure).toHaveBeenCalledWith("artifact\\2024.log")
	})
	it("keeps Windows drive and UNC directory information out of failure names", async () => {
		for (const filePath of ["D:\\private-directory\\missing.log", "\\\\private-server\\share\\missing.log"]) {
			const show = vi.fn()
			const failure = vi.fn()
			await previewRuntimeArtifact(filePath, show, failure, async () => {
				throw new Error("secret-bearing stat error")
			})
			expect(show).not.toHaveBeenCalled()
			expect(failure).toHaveBeenCalledTimes(1)
			expect(failure).toHaveBeenCalledWith("missing.log")
		}
	})
})
