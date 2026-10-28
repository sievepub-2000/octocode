import { expect, it, vi } from "vitest"

const { birth } = vi.hoisted(() => ({ birth: vi.fn() }))
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFileSync: birth,
}))

import { processBirth, processOwnerAlive } from "../RuntimeBrokerClient"

it.skipIf(process.platform !== "win32")("rechecks birth identity when a live PID is reused", () => {
	const alive = vi.spyOn(process, "kill").mockReturnValue(true)
	try {
		birth.mockReturnValueOnce("first-birth").mockReturnValueOnce("second-birth")
		expect(processBirth(12345)).toBe("first-birth")
		expect(processOwnerAlive(12345, "first-birth")).toBe(false)
	} finally {
		alive.mockRestore()
	}
})
