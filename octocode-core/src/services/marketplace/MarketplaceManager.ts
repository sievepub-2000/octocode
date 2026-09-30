import * as fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"
import * as yaml from "yaml"

import type { MarketplaceItem, MarketplaceItemType } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { ensureSettingsDirectoryExists } from "../../utils/globalContext"
import { t } from "../../i18n"
import type { CustomModesManager } from "../../core/config/CustomModesManager"

import { ConfigLoader } from "./ConfigLoader"
import { SimpleInstaller } from "./SimpleInstaller"
import { getSystemToolDirectory } from "../environments/tools"

export interface MarketplaceItemsResponse {
	organizationMcps: MarketplaceItem[]
	marketplaceItems: MarketplaceItem[]
	errors?: string[]
}

export class MarketplaceManager {
	/** Pre-2026-09-18 marker: set once the six defaults in `legacyV2Defaults` were offered. */
	private static readonly defaultItemsInstalledKey = "octocode.defaultMarketplaceItems.v2"
	/** Ids of every default ever offered, so a default the user removed is never restored. */
	private static readonly defaultItemsOfferedKey = "octocode.defaultMarketplaceItems.offered"
	private static readonly legacyV2Defaults = [
		"code-review-graph",
		"llm-wiki",
		"open-pencil",
		"obscura",
		"context-mode",
		"auto-research",
	]
	static readonly defaultItems = [
		["code-review-graph", "mcp"],
		["llm-wiki", "mcp"],
		["auto-research", "mode"],
		["scrapling", "mcp"],
	] as const
	/**
	 * Bundled servers dropped on 2026-09-19 (their payloads left the installer):
	 * Obscura duplicated Scrapling's rendering, Context Mode a second memory and
	 * compaction layer, OpenPencil was outside the coding scope. Their entries would
	 * point at deleted files, so they are removed from the global MCP settings once.
	 */
	static readonly retiredDefaultMcps = ["open-pencil", "obscura", "context-mode"] as const
	private static readonly retiredKey = "octocode.retiredMarketplaceItems"
	private configLoader: ConfigLoader
	private installer: SimpleInstaller

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly customModesManager?: CustomModesManager,
	) {
		this.configLoader = new ConfigLoader(context.extensionUri.fsPath)
		this.installer = new SimpleInstaller(context, customModesManager)
	}

	async getMarketplaceItems(): Promise<MarketplaceItemsResponse> {
		try {
			const marketplaceItems = await this.configLoader.loadAllItems()

			return {
				organizationMcps: [],
				marketplaceItems,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error("Failed to load marketplace items:", error)

			return {
				organizationMcps: [],
				marketplaceItems: [],
				errors: [errorMessage],
			}
		}
	}

	async getCurrentItems(): Promise<MarketplaceItem[]> {
		const result = await this.getMarketplaceItems()
		return [...result.organizationMcps, ...result.marketplaceItems]
	}

	async installDefaultItemsOnce(): Promise<boolean> {
		const state = this.context.globalState
		await this.removeRetiredDefaultsOnce()
		const offered = new Set(
			state.get<string[]>(MarketplaceManager.defaultItemsOfferedKey) ??
				(state.get<boolean>(MarketplaceManager.defaultItemsInstalledKey)
					? MarketplaceManager.legacyV2Defaults
					: []),
		)
		const pending = MarketplaceManager.defaultItems.filter(([id]) => !offered.has(id))
		if (!pending.length) return false

		const unavailable: string[] = []
		for (const [id, type] of pending) {
			const item = await this.configLoader.getItem(id, type)
			if (!item) {
				throw new Error(`Bundled default marketplace item not found: ${id}`)
			}
			const installed = await this.installer.installItem(item, { target: "global", seedMcpDefaults: true })
			if (installed.missingDependencies?.length) unavailable.push(item.name)
			offered.add(id)
		}
		if (unavailable.length) {
			void vscode.window.showInformationMessage(
				`未安装的可选 MCP 已设为禁用：${unavailable.join("、")}。请按发行包 MINIMAL-RELEASE-NOTES.md 安装所需组件，再在 MCP 设置中启用。`,
			)
		}

		await state.update(MarketplaceManager.defaultItemsOfferedKey, [...offered])
		await state.update(MarketplaceManager.defaultItemsInstalledKey, true)
		return true
	}

	private async removeRetiredDefaultsOnce(): Promise<void> {
		const state = this.context.globalState
		const done = new Set(state.get<string[]>(MarketplaceManager.retiredKey) ?? [])
		const pending = MarketplaceManager.retiredDefaultMcps.filter((id) => !done.has(id))
		if (!pending.length) return
		for (const id of pending) {
			await this.installer.removeItem(
				{ id, name: id, description: "", url: "", type: "mcp", content: "{}" },
				{ target: "global" },
			)
			done.add(id)
		}
		await state.update(MarketplaceManager.retiredKey, [...done])
	}

	filterItems(
		items: MarketplaceItem[],
		filters: { type?: MarketplaceItemType; search?: string; tags?: string[] },
	): MarketplaceItem[] {
		return items.filter((item) => {
			// Type filter
			if (filters.type && item.type !== filters.type) {
				return false
			}

			// Search filter
			if (filters.search) {
				const searchTerm = filters.search.toLowerCase()
				const searchableText = `${item.name} ${item.description}`.toLowerCase()
				if (!searchableText.includes(searchTerm)) {
					return false
				}
			}

			// Tags filter
			if (filters.tags?.length) {
				if (!item.tags?.some((tag) => filters.tags!.includes(tag))) {
					return false
				}
			}

			return true
		})
	}

	async updateWithFilteredItems(filters: {
		type?: MarketplaceItemType
		search?: string
		tags?: string[]
	}): Promise<MarketplaceItem[]> {
		const allItems = await this.getCurrentItems()

		if (!filters.type && !filters.search && (!filters.tags || filters.tags.length === 0)) {
			return allItems
		}

		return this.filterItems(allItems, filters)
	}

	async installMarketplaceItem(
		item: MarketplaceItem,
		options?: { target?: "global" | "project"; parameters?: Record<string, any> },
	): Promise<string> {
		const { target: requestedTarget = "project", parameters } = options || {}
		const target = item.type === "mcp" ? "global" : requestedTarget

		vscode.window.showInformationMessage(t("marketplace:installation.installing", { itemName: item.name }))

		try {
			const result = await this.installer.installItem(item, { target, parameters })
			vscode.window.showInformationMessage(t("marketplace:installation.installSuccess", { itemName: item.name }))

			// Capture telemetry for successful installation
			const telemetryProperties: Record<string, any> = {}
			if (parameters && Object.keys(parameters).length > 0) {
				telemetryProperties.hasParameters = true
				// For MCP items with multiple installation methods, track which one was used
				if (item.type === "mcp" && parameters._selectedIndex !== undefined && Array.isArray(item.content)) {
					const selectedMethod = item.content[parameters._selectedIndex]
					if (selectedMethod && selectedMethod.name) {
						telemetryProperties.installationMethodName = selectedMethod.name
					}
				}
			}

			TelemetryService.instance.captureMarketplaceItemInstalled(
				item.id,
				item.type,
				item.name,
				target,
				telemetryProperties,
			)

			return result.filePath
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(
				t("marketplace:installation.installError", { itemName: item.name, errorMessage }),
			)
			throw error
		}
	}

	async removeInstalledMarketplaceItem(
		item: MarketplaceItem,
		options?: { target?: "global" | "project" },
	): Promise<void> {
		const { target: requestedTarget = "project" } = options || {}
		const target = item.type === "mcp" ? "global" : requestedTarget

		vscode.window.showInformationMessage(t("marketplace:installation.removing", { itemName: item.name }))

		try {
			await this.installer.removeItem(item, { target })
			vscode.window.showInformationMessage(t("marketplace:installation.removeSuccess", { itemName: item.name }))

			// Capture telemetry for successful removal
			TelemetryService.instance.captureMarketplaceItemRemoved(item.id, item.type, item.name, target)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(
				t("marketplace:installation.removeError", { itemName: item.name, errorMessage }),
			)
			throw error
		}
	}

	async cleanup(): Promise<void> {
		// Bundled marketplace config has no runtime resources to release.
	}

	/**
	 * Get installation metadata by checking config files for installed items
	 */
	async getInstallationMetadata(): Promise<{
		project: Record<string, { type: string }>
		global: Record<string, { type: string }>
	}> {
		const metadata = {
			project: {} as Record<string, { type: string }>,
			global: {} as Record<string, { type: string }>,
		}

		// Check project-level installations
		await this.checkProjectInstallations(metadata.project)

		// Check global-level installations
		await this.checkGlobalInstallations(metadata.global)

		return metadata
	}

	/**
	 * Check for project-level installed items
	 */
	private async checkProjectInstallations(metadata: Record<string, { type: string }>): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
			if (!workspaceFolder) {
				return // No workspace, no project installations
			}

			// Check modes in .roomodes
			const projectModesPath = path.join(workspaceFolder.uri.fsPath, ".roomodes")
			try {
				const content = await fs.readFile(projectModesPath, "utf-8")
				const data = yaml.parse(content)
				if (data?.customModes && Array.isArray(data.customModes)) {
					for (const mode of data.customModes) {
						if (mode.slug) {
							metadata[mode.slug] = {
								type: "mode",
							}
						}
					}
				}
			} catch (error) {
				// File doesn't exist or can't be read, skip
			}

			// Check MCPs in .roo/mcp.json
			if (getSystemToolDirectory("mcp")) return
			const projectMcpPath = path.join(workspaceFolder.uri.fsPath, ".roo", "mcp.json")
			try {
				const content = await fs.readFile(projectMcpPath, "utf-8")
				const data = JSON.parse(content)
				if (data?.mcpServers && typeof data.mcpServers === "object") {
					for (const serverName of Object.keys(data.mcpServers)) {
						metadata[serverName] = {
							type: "mcp",
						}
					}
				}
			} catch (error) {
				// File doesn't exist or can't be read, skip
			}
		} catch (error) {
			console.error("Error checking project installations:", error)
		}
	}

	/**
	 * Check for global-level installed items
	 */
	private async checkGlobalInstallations(metadata: Record<string, { type: string }>): Promise<void> {
		try {
			const globalSettingsPath = await ensureSettingsDirectoryExists(this.context)

			// Check global modes
			const globalModesPath = path.join(globalSettingsPath, GlobalFileNames.customModes)
			try {
				const content = await fs.readFile(globalModesPath, "utf-8")
				const data = yaml.parse(content)
				if (data?.customModes && Array.isArray(data.customModes)) {
					for (const mode of data.customModes) {
						if (mode.slug) {
							metadata[mode.slug] = {
								type: "mode",
							}
						}
					}
				}
			} catch (error) {
				// File doesn't exist or can't be read, skip
			}

			// Check global MCPs
			const globalMcpPath = path.join(
				getSystemToolDirectory("mcp") ?? globalSettingsPath,
				GlobalFileNames.mcpSettings,
			)
			try {
				const content = await fs.readFile(globalMcpPath, "utf-8")
				const data = JSON.parse(content)
				if (data?.mcpServers && typeof data.mcpServers === "object") {
					for (const serverName of Object.keys(data.mcpServers)) {
						metadata[serverName] = {
							type: "mcp",
						}
					}
				}
			} catch (error) {
				// File doesn't exist or can't be read, skip
			}
		} catch (error) {
			console.error("Error checking global installations:", error)
		}
	}
}
