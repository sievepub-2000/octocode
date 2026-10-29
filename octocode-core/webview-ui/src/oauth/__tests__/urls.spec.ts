import { describe, expect, it } from "vitest"
import { getOctoCodeAuthUrl } from "../urls"

describe("OctoCode sign-in address", () => {
	it("opens the project homepage without a path or query, including stale settings", () => {
		expect(getOctoCodeAuthUrl()).toBe("https://octosys.cloud")
		expect(getOctoCodeAuthUrl("octocode", "https://www.octocode.dev", "desktop")).toBe("https://octosys.cloud")
	})
})
