import { afterEach, describe, expect, it, vi } from "vitest"

import { McpHub, shouldWrapStdioCommand } from "../McpHub"

type RetryableHub = {
	isDisposed: boolean
	connectionAttempts: Map<string, Promise<void>>
	connectToServer: (
		name: string,
		config: { type: "streamable-http"; url: string } | { type: "stdio"; command: string },
		source: "global",
	) => Promise<void>
	connectToServerOnce: ReturnType<typeof vi.fn>
}

describe("streamable HTTP startup", () => {
	afterEach(() => vi.useRealTimers())

	it("only wraps Windows commands that need shell resolution", () => {
		expect(shouldWrapStdioCommand("npx", "win32")).toBe(true)
		expect(shouldWrapStdioCommand("D:/OctoCode/environments/python/python.exe", "win32")).toBe(false)
		expect(shouldWrapStdioCommand("native.com", "win32")).toBe(false)
		expect(shouldWrapStdioCommand("npx", "darwin")).toBe(false)
	})
	it("retries transient startup failures four times", async () => {
		vi.useFakeTimers()
		const hub = Object.create(McpHub.prototype) as RetryableHub
		hub.isDisposed = false
		hub.connectionAttempts = new Map()
		hub.connectToServerOnce = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValue(undefined)

		const connecting = hub.connectToServer(
			"exa",
			{ type: "streamable-http", url: "https://mcp.exa.ai/mcp" },
			"global",
		)
		await vi.advanceTimersByTimeAsync(2500)
		await connecting

		expect(hub.connectToServerOnce).toHaveBeenCalledTimes(5)
	})

	it("retries the transient stdio Not connected race without surfacing a startup error", async () => {
		vi.useFakeTimers()
		const hub = Object.create(McpHub.prototype) as RetryableHub
		hub.isDisposed = false
		hub.connectionAttempts = new Map()
		hub.connectToServerOnce = vi.fn().mockRejectedValueOnce(new Error("Not connected")).mockResolvedValue(undefined)

		const connecting = hub.connectToServer("code-review-graph", { type: "stdio", command: "python" }, "global")
		await vi.advanceTimersByTimeAsync(250)
		await connecting

		expect(hub.connectToServerOnce).toHaveBeenCalledTimes(2)
	})

	it("retries the transient stdio Connection closed race without surfacing a startup error", async () => {
		vi.useFakeTimers()
		const hub = Object.create(McpHub.prototype) as RetryableHub
		hub.isDisposed = false
		hub.connectionAttempts = new Map()
		hub.connectToServerOnce = vi.fn().mockRejectedValueOnce(new Error("MCP error -32000: Connection closed")).mockResolvedValue(undefined)

		const connecting = hub.connectToServer("code-review-graph", { type: "stdio", command: "python" }, "global")
		await vi.advanceTimersByTimeAsync(250)
		await connecting

		expect(hub.connectToServerOnce).toHaveBeenCalledTimes(2)
	})

	it("coalesces concurrent startup requests for the same server", async () => {
		const hub = Object.create(McpHub.prototype) as RetryableHub
		hub.isDisposed = false
		hub.connectionAttempts = new Map()
		hub.connectToServerOnce = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10)))

		await Promise.all([
			hub.connectToServer("code-review-graph", { type: "stdio", command: "python.exe" }, "global"),
			hub.connectToServer("code-review-graph", { type: "stdio", command: "python.exe" }, "global"),
		])

		expect(hub.connectToServerOnce).toHaveBeenCalledTimes(1)
	})
})
