import manifest from "../package.json"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

describe("OctoCode extension manifest", () => {
	it("activates on product startup so the agent workbench is the cold-start surface", () => {
		expect(manifest.activationEvents).toContain("*")
		expect(manifest.scripts.vsix).toContain("--allow-star-activation")
	})

	it("does not contribute application-scoped workspace trust defaults", () => {
		expect(manifest.contributes.configurationDefaults).not.toHaveProperty("security.workspace.trust.enabled")
		expect(manifest.contributes.configurationDefaults).not.toHaveProperty("security.workspace.trust.startupPrompt")
	})

	it("contributes four consecutive activity containers with real views", () => {
		const containerIds = manifest.contributes.viewsContainers.activitybar.map(({ id }) => id)
		expect(containerIds).toEqual([
			"octocode-ActivityBar",
			"octocode-mcp-ActivityBar",
			"octocode-skills-ActivityBar",
			"octocode-agentmods-ActivityBar",
		])

		for (const id of containerIds) {
			expect(manifest.contributes.views[id as keyof typeof manifest.contributes.views]).toHaveLength(1)
		}
		for (const { icon } of manifest.contributes.viewsContainers.activitybar) {
			expect(existsSync(resolve(import.meta.dirname, "..", icon))).toBe(true)
		}
		expect(manifest.contributes.viewsContainers.activitybar.slice(1).map(({ icon }) => icon)).toEqual([
			"assets/icons/activity/mcp-services.svg",
			"assets/icons/activity/skills.svg",
			"assets/icons/activity/agentmods.svg",
		])
		expect(Object.keys(manifest.contributes.viewsContainers)).toEqual(["activitybar"])
	})

	it("leaves application-scoped extension verification to the OctoCode product", () => {
		expect(manifest.contributes.configurationDefaults).not.toHaveProperty("extensions.verifySignature")
	})

	it("keeps recovery commands but only exposes title actions for non-self-restoring slots", () => {
		const commands = manifest.contributes.commands.map(({ command }) => command)
		expect(commands).toEqual(
			expect.arrayContaining([
				"octocode.openChatPanel",
				"octocode.openArtifactPanel",
				"octocode.openBrowserPanel",
				"octocode.openRuntimeTerminal",
				"octocode.restoreWorkbenchLayout",
			]),
		)
		const titleCommands = manifest.contributes.menus["editor/title"].map(({ command }) => command)
		expect(titleCommands).toEqual(["octocode.openBrowserPanel"])
		expect(titleCommands).not.toEqual(
			expect.arrayContaining([
				"octocode.openChatPanel",
				"octocode.openArtifactPanel",
				"octocode.openRuntimeTerminal",
			]),
		)
		expect(JSON.stringify(manifest.contributes.menus)).not.toMatch(/ChatPlaceholder|ArtifactPlaceholder/)
		for (const item of manifest.contributes.menus["editor/title"]) {
			for (const panelId of item.when.matchAll(/activeWebviewPanelId == ([^ )]+)/g)) {
				expect(panelId[1]).toMatch(/^'.+'$/)
			}
		}
	})

	it("binds the Agent hotkey to full cold-start workbench recovery", () => {
		const binding = manifest.contributes.keybindings.find(({ win }) => win === "ctrl+alt+i")
		expect(binding?.command).toBe("octocode.restoreWorkbenchLayout")
	})
})
