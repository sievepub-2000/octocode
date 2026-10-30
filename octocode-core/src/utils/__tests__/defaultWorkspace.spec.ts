import fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"
import { configuredWorkspacePath, ensureDefaultWorkspace } from "../defaultWorkspace"

describe("configured workspace", () => {
	let root: string
	let configured = ""
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-workspace-"))
		configured = ""
		Object.defineProperty(vscode.window.tabGroups, "all", { configurable: true, value: [] })
		vi.spyOn(vscode.window.tabGroups, "close").mockResolvedValue(true)
		vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		vi.spyOn(fs, "unlink").mockResolvedValue(undefined)
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined })
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: () => configured,
		} as unknown as vscode.WorkspaceConfiguration)
	})
	it.skipIf(process.platform !== "win32")("migrates only an empty regular drive-root marker", async () => {
		const fixture = path.join(root, "legacy")
		await fs.writeFile(fixture, "")
		vi.mocked(fs.lstat).mockResolvedValue(await fs.stat(fixture))
		await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect(fs.unlink).toHaveBeenCalledWith(path.join(path.parse(root).root, "Program"))
		vi.mocked(fs.unlink).mockClear()
		await fs.writeFile(fixture, "user data")
		vi.mocked(fs.lstat).mockResolvedValue(await fs.stat(fixture))
		await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect(fs.unlink).not.toHaveBeenCalled()
	})
	it.skipIf(process.platform !== "win32")(
		"replaces a clean missing drive-root editor with the workspace marker",
		async () => {
			configured = path.join(root, "workspace")
			Object.defineProperty(vscode.workspace, "workspaceFolders", {
				configurable: true,
				value: [{ uri: vscode.Uri.file(configured) }],
			})
			const tab = {
				input: new vscode.TabInputText(vscode.Uri.file(path.join(path.parse(root).root, "Program"))),
				isDirty: false,
				isPreview: false,
			}
			Object.defineProperty(vscode.window.tabGroups, "all", {
				configurable: true,
				value: [{ viewColumn: 2, tabs: [tab] }],
			})
			await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.open",
				vscode.Uri.file(path.join(configured, "Program")),
				{ viewColumn: 2, preserveFocus: true, preview: false },
			)
			expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(tab, true)
			vi.mocked(vscode.window.tabGroups.close).mockClear()
			tab.isDirty = true
			await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
			tab.isDirty = false
			vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("open failed"))
			await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
			const fixture = path.join(root, "user-file")
			await fs.writeFile(fixture, "user data")
			vi.mocked(fs.lstat).mockResolvedValue(await fs.stat(fixture))
			vi.mocked(vscode.commands.executeCommand).mockClear()
			await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
			expect(vscode.window.tabGroups.close).not.toHaveBeenCalled()
		},
	)
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})
	const context = () => ({ globalStorageUri: vscode.Uri.file(path.join(root, "data")) }) as vscode.ExtensionContext
	const output = () => ({ appendLine: vi.fn() }) as unknown as vscode.OutputChannel
	it("defaults to installation workspace and opens it instead of an unrelated restored folder", async () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: vscode.Uri.file(path.join(root, "unrelated")) }],
		})
		const result = await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect(result).toBe(path.join(root, "workspace"))
		expect(await fs.readFile(path.join(result!, "Program"), "utf8")).toBe("")
		await fs.writeFile(path.join(result!, "Program"), "preserve")
		await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect(await fs.readFile(path.join(result!, "Program"), "utf8")).toBe("preserve")
		expect((await fs.stat(path.join(result!, ".git"))).isDirectory()).toBe(true)
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.openFolder",
			vscode.Uri.file(result!),
			false,
		)
	})
	it("uses only the user setting and does not initialise their directory as a repository", async () => {
		configured = path.join(root, "chosen")
		expect(configuredWorkspacePath(path.join(root, "resources", "app"))).toBe(configured)
		await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect((await fs.stat(configured)).isDirectory()).toBe(true)
		await expect(fs.stat(path.join(configured, ".git"))).rejects.toThrow()
	})
	it("repairs a missing marker when the installation workspace is explicitly configured and already open", async () => {
		configured = path.join(root, "workspace")
		await fs.mkdir(path.join(configured, ".git"), { recursive: true })
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: vscode.Uri.file(configured) }],
		})
		expect(await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))).toBeUndefined()
		const marker = path.join(configured, "Program")
		expect(await fs.readFile(marker, "utf8")).toBe("")
		await fs.writeFile(marker, "keep")
		await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect(await fs.readFile(marker, "utf8")).toBe("keep")
		await fs.rm(marker)
		await ensureDefaultWorkspace(context(), output(), path.join(root, "resources", "app"))
		expect(await fs.readFile(marker, "utf8")).toBe("")
	})
	it("does not silently fall back when the chosen path is invalid or unwritable", async () => {
		configured = "relative/path"
		expect(() => configuredWorkspacePath()).toThrow("绝对路径")
		configured = path.join(root, "file")
		await fs.writeFile(configured, "keep")
		await expect(ensureDefaultWorkspace(context(), output())).rejects.toThrow()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(await fs.readFile(configured, "utf8")).toBe("keep")
	})
	it("does not reopen the already selected configured workspace", async () => {
		configured = root
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: vscode.Uri.file(root) }],
		})
		expect(await ensureDefaultWorkspace(context(), output())).toBeUndefined()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})
})
