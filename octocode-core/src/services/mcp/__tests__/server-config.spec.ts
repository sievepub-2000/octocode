import { ServerConfigSchema } from "../server-config"
import { z } from "zod/v4"

describe("MCP server configuration records", () => {
	it.each(["stdio", "sse", "streamable-http"])(
		"preserves string maps and rejects non-string values for %s",
		(type) => {
			const config =
				type === "stdio"
					? { type, command: "node", env: { TEST_VALUE: "configured" } }
					: { type, url: "https://example.com/mcp", headers: { "X-Test": "configured" } }
			const parsed = ServerConfigSchema.parse(config)
			expect(ServerConfigSchema).toBeInstanceOf(z.ZodType)
			expect(parsed).toMatchObject({ ...config, timeout: 60, alwaysAllow: [], disabledTools: [] })
			const invalid =
				type === "stdio" ? { ...config, env: { TEST_VALUE: 123 } } : { ...config, headers: { "X-Test": 123 } }
			expect(ServerConfigSchema.safeParse(invalid).success).toBe(false)
		},
	)
})
