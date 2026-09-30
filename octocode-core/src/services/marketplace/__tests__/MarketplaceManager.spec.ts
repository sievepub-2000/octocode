// npx vitest services/marketplace/__tests__/MarketplaceManager.spec.ts

import type { MarketplaceItem } from "@roo-code/types"

import { MarketplaceManager } from "../MarketplaceManager"

// Mock TelemetryService
vi.mock("../../../../packages/telemetry/src/TelemetryService", () => ({
	TelemetryService: {
		instance: {
			captureMarketplaceItemInstalled: vi.fn(),
			captureMarketplaceItemRemoved: vi.fn(),
		},
	},
}))

// Mock vscode first
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [
			{
				uri: { fsPath: "/test/workspace" },
				name: "test",
				index: 0,
			},
		],
		openTextDocument: vi.fn(),
	},
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	Range: vi.fn().mockImplementation(function (startLine, startChar, endLine, endChar) {
		return {
			start: { line: startLine, character: startChar },
			end: { line: endLine, character: endChar },
		}
	}),
}))

const mockContext = {
	subscriptions: [],
	workspaceState: {
		get: vi.fn(),
		update: vi.fn(),
	},
	globalState: {
		get: vi.fn(),
		update: vi.fn(),
	},
	extensionUri: { fsPath: "/test/extension" },
} as any

// Mock fs
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	access: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
}))

// Mock yaml
vi.mock("yaml", () => ({
	parse: vi.fn(),
	stringify: vi.fn(),
}))

describe("MarketplaceManager", () => {
	let manager: MarketplaceManager

	beforeEach(() => {
		manager = new MarketplaceManager(mockContext)
		vi.clearAllMocks()
	})

	describe("filterItems", () => {
		it("should filter items by search term", () => {
			const items: MarketplaceItem[] = [
				{
					id: "test-mode",
					name: "Test Mode",
					description: "A test mode for testing",
					type: "mode",
					content: "# Test Mode\nThis is a test mode.",
				},
				{
					id: "other-mode",
					name: "Other Mode",
					description: "Another mode",
					type: "mode",
					content: "# Other Mode\nThis is another mode.",
				},
			]

			const filtered = manager.filterItems(items, { search: "test" })

			expect(filtered).toHaveLength(1)
			expect(filtered[0].name).toBe("Test Mode")
		})

		it("should filter items by type", () => {
			const items: MarketplaceItem[] = [
				{
					id: "test-mode",
					name: "Test Mode",
					description: "A test mode",
					type: "mode",
					content: "# Test Mode",
				},
				{
					id: "test-mcp",
					name: "Test MCP",
					description: "A test MCP",
					type: "mcp",
					url: "https://example.com/test-mcp",
					content: '{"command": "node", "args": ["server.js"]}',
				},
			]

			const filtered = manager.filterItems(items, { type: "mode" })

			expect(filtered).toHaveLength(1)
			expect(filtered[0].type).toBe("mode")
		})

		it("should return empty array when no items match", () => {
			const items: MarketplaceItem[] = [
				{
					id: "test-mode",
					name: "Test Mode",
					description: "A test mode",
					type: "mode",
					content: "# Test Mode",
				},
			]

			const filtered = manager.filterItems(items, { search: "nonexistent" })

			expect(filtered).toHaveLength(0)
		})
	})

	describe("getMarketplaceItems", () => {
		it("should return items from bundled marketplace assets", async () => {
			// Mock the config loader to return test data
			const mockItems: MarketplaceItem[] = [
				{
					id: "test-mode",
					name: "Test Mode",
					description: "A test mode",
					type: "mode",
					content: "# Test Mode",
				},
			]

			// Mock the loadAllItems method
			vi.spyOn(manager["configLoader"], "loadAllItems").mockResolvedValue(mockItems)

			const result = await manager.getMarketplaceItems()

			expect(result.marketplaceItems).toHaveLength(1)
			expect(result.marketplaceItems[0].name).toBe("Test Mode")
			expect(result.organizationMcps).toHaveLength(0)
		})

		it("should handle bundled marketplace loading errors gracefully", async () => {
			// Mock the config loader to throw an error
			vi.spyOn(manager["configLoader"], "loadAllItems").mockRejectedValue(
				new Error("Marketplace asset load failed"),
			)

			const result = await manager.getMarketplaceItems()

			expect(result.marketplaceItems).toHaveLength(0)
			expect(result.organizationMcps).toHaveLength(0)
			expect(result.errors).toEqual(["Marketplace asset load failed"])
		})

		it("should preserve the response shape while returning only bundled marketplace items", async () => {
			const mockItems: MarketplaceItem[] = [
				{
					id: "test-mcp",
					name: "Test MCP",
					description: "A test MCP",
					type: "mcp",
					url: "https://example.com/test-mcp",
					content: '{"command": "node", "args": ["server.js"]}',
				},
			]

			vi.spyOn(manager["configLoader"], "loadAllItems").mockResolvedValue(mockItems)

			const result = await manager.getMarketplaceItems()

			expect(result.organizationMcps).toEqual([])
			expect(result.marketplaceItems).toHaveLength(1)
			expect(result.marketplaceItems[0].name).toBe("Test MCP")
		})

		it("should not filter bundled MCP items through organization settings", async () => {
			const mockItems: MarketplaceItem[] = [
				{
					id: "visible-mcp",
					name: "Visible MCP",
					description: "A visible MCP",
					type: "mcp",
					url: "https://example.com/visible-mcp",
					content: '{"command": "node", "args": ["visible.js"]}',
				},
				{
					id: "second-mcp",
					name: "Second MCP",
					description: "Another bundled MCP",
					type: "mcp",
					url: "https://example.com/second-mcp",
					content: '{"command": "node", "args": ["second.js"]}',
				},
			]

			vi.spyOn(manager["configLoader"], "loadAllItems").mockResolvedValue(mockItems)

			const result = await manager.getMarketplaceItems()

			expect(result.marketplaceItems).toHaveLength(2)
			expect(result.marketplaceItems.map((item) => item.name)).toEqual(["Visible MCP", "Second MCP"])
			expect(result.organizationMcps).toHaveLength(0)
		})
	})

	describe("installMarketplaceItem", () => {
		it("should install a mode item", async () => {
			const item: MarketplaceItem = {
				id: "test-mode",
				name: "Test Mode",
				description: "A test mode",
				type: "mode",
				content: "# Test Mode\nThis is a test mode.",
			}

			// Mock the installer
			vi.spyOn(manager["installer"], "installItem").mockResolvedValue({
				filePath: "/test/path/.roomodes",
				line: 5,
			})

			const result = await manager.installMarketplaceItem(item)

			expect(manager["installer"].installItem).toHaveBeenCalledWith(item, { target: "project" })
			expect(result).toBe("/test/path/.roomodes")
		})

		it("should install an MCP item", async () => {
			const item: MarketplaceItem = {
				id: "test-mcp",
				name: "Test MCP",
				description: "A test MCP",
				type: "mcp",
				url: "https://example.com/test-mcp",
				content: '{"command": "node", "args": ["server.js"]}',
			}

			// Mock the installer
			vi.spyOn(manager["installer"], "installItem").mockResolvedValue({
				filePath: "/test/path/.roo/mcp.json",
				line: 3,
			})

			const result = await manager.installMarketplaceItem(item, { target: "project" })

			expect(manager["installer"].installItem).toHaveBeenCalledWith(
				item,
				expect.objectContaining({ target: "global" }),
			)
			expect(result).toBe("/test/path/.roo/mcp.json")
		})
	})

	describe("installDefaultItemsOnce", () => {
		it("installs the bundled defaults globally and records completion", async () => {
			const items = [
				{
					id: "code-review-graph",
					name: "Code Review Graph",
					description: "Code review graph",
					type: "mcp",
					content: "{}",
				},
				{ id: "llm-wiki", name: "LLM Wiki", description: "Wiki", type: "mcp", content: "{}" },
				{ id: "auto-research", name: "Auto Research", description: "Research", type: "mode", content: "{}" },
				{ id: "scrapling", name: "Scrapling", description: "Scraping", type: "mcp", content: "{}" },
			] as MarketplaceItem[]
			vi.spyOn(manager["configLoader"], "getItem").mockImplementation(
				async (id) => items.find((item) => item.id === id)!,
			)
			const install = vi
				.spyOn(manager["installer"], "installItem")
				.mockResolvedValue({ filePath: "/test/settings" })
			const remove = vi.spyOn(manager["installer"], "removeItem").mockResolvedValue()

			const installed = await manager.installDefaultItemsOnce()

			expect(installed).toBe(true)
			expect(install).toHaveBeenCalledTimes(4)
			expect(remove.mock.calls.map(([item, options]) => [item.id, options.target])).toEqual([
				["open-pencil", "global"],
				["obscura", "global"],
				["context-mode", "global"],
			])
			expect(mockContext.globalState.update).toHaveBeenCalledWith("octocode.retiredMarketplaceItems", [
				"open-pencil",
				"obscura",
				"context-mode",
			])
			expect(install.mock.calls.every(([, options]) => options.target === "global")).toBe(true)
			expect(mockContext.globalState.update).toHaveBeenCalledWith(
				"octocode.defaultMarketplaceItems.offered",
				MarketplaceManager.defaultItems.map(([id]) => id),
			)
		})

		it("offers only defaults added since an older first run, never re-adding removed ones", async () => {
			mockContext.globalState.get.mockImplementation((key: string) =>
				key === "octocode.defaultMarketplaceItems.v2" ? true : undefined,
			)
			const scrapling = {
				id: "scrapling",
				name: "Scrapling",
				description: "Scraping",
				type: "mcp",
				content: "{}",
			}
			const load = vi.spyOn(manager["configLoader"], "getItem").mockResolvedValue(scrapling as MarketplaceItem)
			const install = vi
				.spyOn(manager["installer"], "installItem")
				.mockResolvedValue({ filePath: "/test/settings" })
			vi.spyOn(manager["installer"], "removeItem").mockResolvedValue()

			expect(await manager.installDefaultItemsOnce()).toBe(true)
			expect(load).toHaveBeenCalledExactlyOnceWith("scrapling", "mcp")
			expect(install).toHaveBeenCalledOnce()
		})

		it("does nothing once every default has been offered", async () => {
			mockContext.globalState.get.mockImplementation((key: string) =>
				key === "octocode.defaultMarketplaceItems.offered"
					? MarketplaceManager.defaultItems.map(([id]) => id)
					: key === "octocode.retiredMarketplaceItems"
						? [...MarketplaceManager.retiredDefaultMcps]
						: undefined,
			)
			const load = vi.spyOn(manager["configLoader"], "getItem")

			expect(await manager.installDefaultItemsOnce()).toBe(false)
			expect(load).not.toHaveBeenCalled()
		})
	})

	describe("removeInstalledMarketplaceItem", () => {
		it("should remove a mode item", async () => {
			const item: MarketplaceItem = {
				id: "test-mode",
				name: "Test Mode",
				description: "A test mode",
				type: "mode",
				content: "# Test Mode",
			}

			// Mock the installer
			vi.spyOn(manager["installer"], "removeItem").mockResolvedValue()

			await manager.removeInstalledMarketplaceItem(item)

			expect(manager["installer"].removeItem).toHaveBeenCalledWith(item, { target: "project" })
		})

		it("should remove an MCP item", async () => {
			const item: MarketplaceItem = {
				id: "test-mcp",
				name: "Test MCP",
				description: "A test MCP",
				type: "mcp",
				url: "https://example.com/test-mcp",
				content: '{"command": "node", "args": ["server.js"]}',
			}

			// Mock the installer
			vi.spyOn(manager["installer"], "removeItem").mockResolvedValue()

			await manager.removeInstalledMarketplaceItem(item)

			expect(manager["installer"].removeItem).toHaveBeenCalledWith(item, { target: "global" })
		})
	})

	describe("cleanup", () => {
		it("should complete without runtime cleanup for bundled config", async () => {
			await expect(manager.cleanup()).resolves.toBeUndefined()
		})
	})
})
