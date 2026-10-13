vi.mock("vscode", () => ({
	TreeItem: class {
		description?: string
		tooltip?: string
		command?: unknown
		contextValue?: string
		constructor(
			public label: string,
			public collapsibleState: number,
		) {}
	},
	TreeItemCollapsibleState: { None: 0 },
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
	window: { registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })) },
	commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
}))

vi.mock("../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: { getVisibleInstance: vi.fn() },
}))

import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { registerResourceViews, ResourceTreeProvider } from "../resourceViews"

describe("ResourceTreeProvider", () => {
	it.each(["mcp", "skills", "agentMods"] as const)("keeps the empty %s view actionable", async (kind) => {
		const provider = {
			getMcpHub: () => ({ getAllServers: () => [] }),
			getSkillsManager: () => ({ getSkillsMetadata: () => [] }),
			customModesManager: { getCustomModes: async () => [] },
		} as unknown as ClineProvider
		const tree = new ResourceTreeProvider(kind, provider)

		const [manager] = await tree.getChildren()

		expect(manager.label).toBe(`common:resources.${kind}`)
		expect(manager.command).toMatchObject({ command: "octocode.openResourceManager", arguments: [kind] })
	})

	it("routes management actions to the editor provider after openInNewTab", async () => {
		const editor = { isViewLaunched: true, postMessageToWebview: vi.fn() }
		const sidebar = { postMessageToWebview: vi.fn() }
		const fallback = {
			getMcpHub: () => ({ getAllServers: () => [] }),
			getSkillsManager: () => ({ getSkillsMetadata: () => [] }),
			customModesManager: { getCustomModes: async () => [] },
		} as unknown as ClineProvider
		vi.mocked(vscode.commands.executeCommand).mockResolvedValue(editor)
		vi.mocked(ClineProvider.getVisibleInstance).mockReturnValue(sidebar as unknown as ClineProvider)
		const subscriptions: { dispose(): unknown }[] = []

		registerResourceViews({ subscriptions } as unknown as vscode.ExtensionContext, fallback)
		const registration = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([id]) => id === "octocode.openResourceManager")
		await registration?.[1]("mcp")

		expect(editor.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "settingsButtonClicked",
			values: { section: "mcp" },
		})
		expect(sidebar.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("refreshes the MCP tree when the live hub becomes ready and later changes", async () => {
		const dispose = vi.fn()
		const onDidChangeServers = vi.fn((_listener: () => void) => ({ dispose }))
		const provider = {
			getMcpHub: () => ({ getAllServers: () => [], onDidChangeServers }),
			getSkillsManager: () => undefined,
			customModesManager: { getCustomModes: async () => [] },
		} as unknown as ClineProvider
		const tree = new ResourceTreeProvider("mcp", provider)
		const refresh = vi.spyOn(tree, "refresh")

		await vi.waitFor(() => expect(onDidChangeServers).toHaveBeenCalledOnce())
		const listener = onDidChangeServers.mock.calls[0]?.[0] as (() => void) | undefined
		listener?.()
		expect(refresh).toHaveBeenCalled()

		tree.dispose()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("does not subscribe or refresh after its window closes during MCP startup", async () => {
		const onDidChangeServers = vi.fn(() => ({ dispose: vi.fn() }))
		const provider = { getMcpHub: () => ({ onDidChangeServers }) } as unknown as ClineProvider
		const tree = new ResourceTreeProvider("mcp", provider)
		tree.dispose()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(onDidChangeServers).not.toHaveBeenCalled()
	})
})
