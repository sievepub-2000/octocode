import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import { ClineProvider } from "../core/webview/ClineProvider"
import { t } from "../i18n"

type ResourceKind = "mcp" | "skills" | "agentMods"

class ResourceItem implements vscode.TreeItem {
	readonly collapsibleState = vscode.TreeItemCollapsibleState.None
	readonly tooltip: string
	readonly command: vscode.Command
	readonly contextValue: string

	constructor(
		readonly label: string,
		readonly description: string,
		kind: ResourceKind,
	) {
		this.tooltip = description ? `${label} — ${description}` : label
		this.command = { command: "octocode.openResourceManager", title: label, arguments: [kind] }
		this.contextValue = `octocode.${kind}`
	}
}

export class ResourceTreeProvider implements vscode.TreeDataProvider<ResourceItem> {
	private readonly changed = new vscode.EventEmitter<ResourceItem | undefined>()
	private mcpSubscription?: vscode.Disposable
	readonly onDidChangeTreeData = this.changed.event

	constructor(
		private readonly kind: ResourceKind,
		private readonly provider: ClineProvider,
	) {
		if (kind === "mcp") {
			void this.bindMcpChanges()
		}
	}

	private async bindMcpChanges(): Promise<void> {
		try {
			await pWaitFor(() => Boolean(this.provider.getMcpHub()), { timeout: 60_000 })
			this.mcpSubscription = this.provider.getMcpHub()?.onDidChangeServers(() => this.refresh())
			this.refresh()
		} catch {
			// The manager row remains available if MCP initialization fails.
		}
	}

	refresh(): void {
		this.changed.fire(undefined)
	}

	getTreeItem(item: ResourceItem): vscode.TreeItem {
		return item
	}

	async getChildren(): Promise<ResourceItem[]> {
		const manager = new ResourceItem(t(`common:resources.${this.kind}`), "", this.kind)
		if (this.kind === "mcp") {
			return [
				manager,
				...(this.provider.getMcpHub()?.getAllServers() ?? []).map(
					(server) => new ResourceItem(server.name, server.status ?? "", this.kind),
				),
			]
		}
		if (this.kind === "skills") {
			return [
				manager,
				...(this.provider.getSkillsManager()?.getSkillsMetadata() ?? []).map(
					(skill) => new ResourceItem(skill.name, skill.source, this.kind),
				),
			]
		}
		return [
			manager,
			...(await this.provider.customModesManager.getCustomModes()).map(
				(mode) => new ResourceItem(mode.name, mode.slug, this.kind),
			),
		]
	}

	dispose(): void {
		this.mcpSubscription?.dispose()
		this.changed.dispose()
	}
}

export function registerResourceViews(context: vscode.ExtensionContext, provider: ClineProvider): void {
	const views = [
		["octocode.mcpServicesView", new ResourceTreeProvider("mcp", provider)],
		["octocode.skillsView", new ResourceTreeProvider("skills", provider)],
		["octocode.agentModsView", new ResourceTreeProvider("agentMods", provider)],
	] as const
	for (const [id, tree] of views) context.subscriptions.push(tree, vscode.window.registerTreeDataProvider(id, tree))
	context.subscriptions.push(
		vscode.commands.registerCommand("octocode.openResourceManager", async (kind: ResourceKind) => {
			const target = await vscode.commands.executeCommand<ClineProvider>("octocode.openInNewTab")
			await pWaitFor(() => target.isViewLaunched, { timeout: 10_000 })
			await target.postMessageToWebview({
				type: "action",
				action: "settingsButtonClicked",
				values: { section: kind === "agentMods" ? "modes" : kind },
			})
		}),
	)
}
