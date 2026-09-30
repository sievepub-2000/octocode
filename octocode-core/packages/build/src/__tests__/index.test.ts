// npx vitest run src/__tests__/index.test.ts

import { generatePackageJson } from "../index.js"
import { copyPaths } from "../esbuild.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

describe("copyPaths", () => {
	it("creates parent directories for individual files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-copy-"))
		try {
			fs.writeFileSync(path.join(root, "source.txt"), "ok")
			copyPaths([["source.txt", "nested/target.txt"]], root, root)
			expect(fs.readFileSync(path.join(root, "nested/target.txt"), "utf8")).toBe("ok")
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
})

describe("generatePackageJson", () => {
	it("should be a test", () => {
		const generatedPackageJson = generatePackageJson({
			packageJson: {
				name: "roo-cline",
				displayName: "%extension.displayName%",
				description: "%extension.description%",
				publisher: "RooVeterinaryInc",
				version: "3.17.2",
				icon: "assets/icons/icon.png",
				contributes: {
					viewsContainers: {
						activitybar: [
							{
								id: "roo-cline-ActivityBar",
								title: "%views.activitybar.title%",
								icon: "assets/icons/icon.svg",
							},
						],
					},
					views: {
						"roo-cline-ActivityBar": [
							{
								type: "webview",
								id: "roo-cline.SidebarProvider",
								name: "",
							},
						],
					},
					commands: [
						{
							command: "roo-cline.plusButtonClicked",
							title: "%command.newTask.title%",
							icon: "$(edit)",
						},
						{
							command: "roo-cline.openInNewTab",
							title: "%command.openInNewTab.title%",
							category: "%configuration.title%",
						},
					],
					menus: {
						"editor/context": [
							{
								submenu: "roo-cline.contextMenu",
								group: "navigation",
							},
						],
						"roo-cline.contextMenu": [
							{
								command: "roo-cline.addToContext",
								group: "1_actions@1",
							},
						],
						"editor/title": [
							{
								command: "roo-cline.plusButtonClicked",
								group: "navigation@1",
								when: "activeWebviewPanelId == roo-cline.TabPanelProvider",
							},
							{
								command: "roo-cline.settingsButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == roo-cline.TabPanelProvider",
							},
							{
								command: "roo-cline.accountButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == roo-cline.TabPanelProvider",
							},
						],
					},
					submenus: [
						{
							id: "roo-cline.contextMenu",
							label: "%views.contextMenu.label%",
						},
						{
							id: "roo-cline.terminalMenu",
							label: "%views.terminalMenu.label%",
						},
					],
					configuration: {
						title: "%configuration.title%",
						properties: {
							"roo-cline.allowedCommands": {
								type: "array",
								items: {
									type: "string",
								},
								default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
								description: "%commands.allowedCommands.description%",
							},
							"roo-cline.customStoragePath": {
								type: "string",
								default: "",
								description: "%settings.customStoragePath.description%",
							},
						},
					},
				},
				scripts: {
					lint: "eslint **/*.ts",
				},
			},
			overrideJson: {
				name: "octocode-nightly",
				displayName: "OctoCode Nightly",
				publisher: "OctoCode",
				version: "0.0.1",
				icon: "assets/icons/icon-nightly.png",
				scripts: {},
			},
			substitution: ["roo-cline", "octocode-nightly"],
		})

		expect(generatedPackageJson).toStrictEqual({
			name: "octocode-nightly",
			displayName: "OctoCode Nightly",
			description: "%extension.description%",
			publisher: "OctoCode",
			version: "0.0.1",
			icon: "assets/icons/icon-nightly.png",
			contributes: {
				viewsContainers: {
					activitybar: [
						{
							id: "octocode-nightly-ActivityBar",
							title: "%views.activitybar.title%",
							icon: "assets/icons/icon.svg",
						},
					],
				},
				views: {
					"octocode-nightly-ActivityBar": [
						{
							type: "webview",
							id: "octocode-nightly.SidebarProvider",
							name: "",
						},
					],
				},
				commands: [
					{
						command: "octocode-nightly.plusButtonClicked",
						title: "%command.newTask.title%",
						icon: "$(edit)",
					},
					{
						command: "octocode-nightly.openInNewTab",
						title: "%command.openInNewTab.title%",
						category: "%configuration.title%",
					},
				],
				menus: {
					"editor/context": [
						{
							submenu: "octocode-nightly.contextMenu",
							group: "navigation",
						},
					],
					"octocode-nightly.contextMenu": [
						{
							command: "octocode-nightly.addToContext",
							group: "1_actions@1",
						},
					],
					"editor/title": [
						{
							command: "octocode-nightly.plusButtonClicked",
							group: "navigation@1",
							when: "activeWebviewPanelId == octocode-nightly.TabPanelProvider",
						},
						{
							command: "octocode-nightly.settingsButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == octocode-nightly.TabPanelProvider",
						},
						{
							command: "octocode-nightly.accountButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == octocode-nightly.TabPanelProvider",
						},
					],
				},
				submenus: [
					{
						id: "octocode-nightly.contextMenu",
						label: "%views.contextMenu.label%",
					},
					{
						id: "octocode-nightly.terminalMenu",
						label: "%views.terminalMenu.label%",
					},
				],
				configuration: {
					title: "%configuration.title%",
					properties: {
						"octocode-nightly.allowedCommands": {
							type: "array",
							items: {
								type: "string",
							},
							default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
							description: "%commands.allowedCommands.description%",
						},
						"octocode-nightly.customStoragePath": {
							type: "string",
							default: "",
							description: "%settings.customStoragePath.description%",
						},
					},
				},
			},
			scripts: {},
		})
	})
})
