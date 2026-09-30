import { classifyMcpStderr } from "../McpHub"

describe("classifyMcpStderr", () => {
	it("keeps ordinary server startup output informational", () => {
		expect(classifyMcpStderr("MCP Server is running. Waiting for requests...")).toBe("info")
	})

	it("keeps actionable failures as errors", () => {
		expect(classifyMcpStderr("Error: EACCES opening database")).toBe("error")
	})
})
