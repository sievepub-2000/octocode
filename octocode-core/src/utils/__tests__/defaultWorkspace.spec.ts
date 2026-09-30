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
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined })
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: () => configured,
		} as unknown as vscode.WorkspaceConfiguration)
	})
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
