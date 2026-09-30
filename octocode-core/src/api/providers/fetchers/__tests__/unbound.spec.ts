import axios from "axios"
import { describe, expect, it, vi } from "vitest"

import { getUnboundModels } from "../unbound"

vi.mock("axios")

describe("getUnboundModels", () => {
	it("treats a malformed catalog as empty instead of throwing", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { message: "unavailable" } })

		await expect(getUnboundModels()).resolves.toEqual({})
	})
})
