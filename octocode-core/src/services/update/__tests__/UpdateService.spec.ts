import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

vi.mock("../../../i18n", () => ({ t: (key: string) => key, changeLanguage: vi.fn() }))

const showInformationMessage = vi.fn()
const showErrorMessage = vi.fn()
const showWarningMessage = vi.fn()
const executeCommand = vi.fn()
const registerCommand = vi.fn()
let settings: Record<string, unknown> = {}
const dirtyDocuments = vi.hoisted(() => [] as { isDirty: boolean }[])
const hasActiveTasks = vi.hoisted(() => vi.fn(() => false))

vi.mock("../../octocode-runtime/OctoCodeRuntime", () => ({ getOctoCodeRuntime: () => ({ hasActiveTasks }) }))

// A status bar item records what the badge rendered, so the red-dot and the
// one-click command can be asserted rather than eyeballed.
const badge = {
	text: "",
	visible: false,
	command: undefined as string | undefined,
	backgroundColor: undefined as unknown,
	show() {
		this.visible = true
	},
	hide() {
		this.visible = false
	},
	dispose() {},
}

vi.mock("vscode", () => ({
	version: "1.132.0",
	window: {
		showInformationMessage: (...a: unknown[]) => showInformationMessage(...a),
		showErrorMessage: (...a: unknown[]) => showErrorMessage(...a),
		showWarningMessage: (...a: unknown[]) => showWarningMessage(...a),
		createStatusBarItem: () => badge,
	},
	workspace: { textDocuments: dirtyDocuments, getConfiguration: () => ({ get: (key: string) => settings[key] }) },
	commands: {
		executeCommand: (...a: unknown[]) => executeCommand(...a),
		registerCommand: (...a: unknown[]) => registerCommand(...a),
	},
	Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
	StatusBarAlignment: { Right: 2, Left: 1 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
}))

import { UpdateService, isNewer } from "../UpdateService"

const context = {
	extension: { packageJSON: { version: "0.1.0" } },
	subscriptions: [] as { dispose: () => void }[],
} as never

describe("isNewer", () => {
	it("orders releases by their numeric parts", () => {
		expect(isNewer("0.1.1", "0.1.0")).toBe(true)
		expect(isNewer("0.2.0", "0.1.9")).toBe(true)
		expect(isNewer("1.0.0", "0.9.9")).toBe(true)
		expect(isNewer("0.1.0", "0.1.0")).toBe(false)
		expect(isNewer("0.0.9", "0.1.0")).toBe(false)
		// A shorter version is not automatically older: 0.2 beats 0.1.9.
		expect(isNewer("0.2", "0.1.9")).toBe(true)
	})
	it("orders prereleases below stable releases and ignores build metadata", () => {
		expect(isNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true)
		expect(isNewer("1.0.0", "1.0.0-rc.2")).toBe(true)
		expect(isNewer("1.0.0+new", "1.0.0+old")).toBe(false)
	})
})

describe("UpdateService", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		settings = {}
		dirtyDocuments.length = 0
		hasActiveTasks.mockReturnValue(false)
		// The badge is module-level; clear it so one test's red dot cannot
		// satisfy the next test's assertion.
		badge.visible = false
		badge.text = ""
		badge.backgroundColor = undefined
		badge.command = undefined
	})

	it("contacts nothing until an update channel is configured", async () => {
		const fetchImpl = vi.fn()
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)

		const result = await service.check()

		// The point of the feature being inert: a build that phones home to an
		// address the user never chose is the mistake this product just paid for
		// with its model endpoint.
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(result).toMatchObject({ available: false, current: "0.1.0" })
	})

	it("reports an update when the channel names a newer version", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		const manifest = { version: "0.2.0", url: "https://example.invalid/o.vsix", sha256: "a".repeat(64) }
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => manifest })
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)

		await expect(service.check()).resolves.toMatchObject({ available: true, manifest })
	})

	it("reads a local workspace manifest and package without network access", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-update-test-"))
		let downloaded: string | undefined
		try {
			const packagePath = path.join(directory, "octocode-0.2.0.vsix")
			const bytes = Buffer.from("local verified package")
			await fs.writeFile(packagePath, bytes)
			const manifest = {
				version: "0.2.0",
				url: pathToFileURL(packagePath).href,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			}
			const manifestPath = path.join(directory, "latest.json")
			await fs.writeFile(manifestPath, JSON.stringify(manifest))
			settings["octocode.update.manifestUrl"] = pathToFileURL(manifestPath).href
			const fetchImpl = vi.fn()
			const service = new UpdateService(context, vi.fn(), fetchImpl as never)
			expect(await service.check()).toMatchObject({ available: true, manifest })
			downloaded = await service.download(manifest)
			expect(await fs.readFile(downloaded)).toEqual(bytes)
			expect(fetchImpl).not.toHaveBeenCalled()
		} finally {
			if (downloaded) await fs.rm(path.dirname(downloaded), { recursive: true, force: true })
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("rejects a release requiring a newer shell", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		const manifest = {
			version: "0.2.0",
			url: "https://example.invalid/o.vsix",
			sha256: "a".repeat(64),
			minShellVersion: "1.133.0",
		}
		const service = new UpdateService(
			context,
			vi.fn(),
			vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }),
		)
		await expect(service.check()).resolves.toMatchObject({
			available: false,
			error: expect.stringContaining("shell"),
		})
	})

	it("rejects an insecure remote package URL before downloading", async () => {
		const service = new UpdateService(context, vi.fn(), vi.fn())
		await expect(
			service.download({ version: "0.2.0", url: "http://example.invalid/o.vsix", sha256: "a".repeat(64) }),
		).rejects.toThrow(/URL|HTTPS|https/)
		await expect(
			service.download({ version: "0.2.0", url: "file://example.invalid/share/o.vsix", sha256: "a".repeat(64) }),
		).rejects.toThrow(/URL|local file/)
	})

	it("applies a rail click without asking for installation again", async () => {
		const manifest = { version: "0.2.0", url: "https://example.invalid/o.vsix", sha256: "a".repeat(64) }
		const service = new UpdateService(context, vi.fn())
		vi.spyOn(service, "check").mockResolvedValue({ available: true, current: "0.1.0", manifest })
		vi.spyOn(service, "download").mockResolvedValue("update.vsix")
		vi.spyOn(service, "install").mockResolvedValue()
		await expect(service.run(false)).resolves.toBe(true)
		expect(service.install).toHaveBeenCalledOnce()
		expect(executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow")
		expect(showInformationMessage).not.toHaveBeenCalledWith("common:update.installed", expect.anything())
		expect(showInformationMessage).not.toHaveBeenCalledWith(
			"common:update.available",
			expect.anything(),
			expect.anything(),
		)
	})

	it("keeps the update available while a document or task is active", async () => {
		const manifest = { version: "0.2.0", url: "https://example.invalid/o.vsix", sha256: "a".repeat(64) }
		const service = new UpdateService(context, vi.fn())
		vi.spyOn(service, "check").mockResolvedValue({ available: true, current: "0.1.0", manifest })
		const download = vi.spyOn(service, "download").mockResolvedValue("update.vsix")
		dirtyDocuments.push({ isDirty: true })
		await expect(service.run(false)).resolves.toBe(false)
		expect(download).not.toHaveBeenCalled()
		dirtyDocuments.length = 0
		hasActiveTasks.mockReturnValue(true)
		await expect(service.run(false)).resolves.toBe(false)
		expect(download).not.toHaveBeenCalled()
		expect(showWarningMessage).toHaveBeenCalledTimes(2)
	})

	it("serializes updates started from separate service instances", async () => {
		const manifest = { version: "0.2.0", url: "https://example.invalid/o.vsix", sha256: "a".repeat(64) }
		let finishDownload: (file: string) => void = () => {}
		const first = new UpdateService(context, vi.fn())
		const second = new UpdateService(context, vi.fn())
		for (const service of [first, second])
			vi.spyOn(service, "check").mockResolvedValue({ available: true, current: "0.1.0", manifest })
		vi.spyOn(first, "download").mockReturnValue(
			new Promise((resolve) => {
				finishDownload = resolve
			}),
		)
		vi.spyOn(first, "install").mockResolvedValue()
		const secondDownload = vi.spyOn(second, "download").mockResolvedValue("second.vsix")
		const running = first.run(false)
		await vi.waitFor(() => expect(first.download).toHaveBeenCalledOnce())
		await expect(second.run(false)).resolves.toBe(false)
		expect(secondDownload).not.toHaveBeenCalled()
		finishDownload("first.vsix")
		await running
	})

	it("removes the downloaded package after installation", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		const bytes = new TextEncoder().encode("verified package")
		const manifest = {
			version: "0.2.0",
			url: "https://example.invalid/o.vsix",
			sha256: createHash("sha256").update(bytes).digest("hex"),
		}
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, json: async () => manifest })
			.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes.buffer })
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		const install = vi.spyOn(service, "install").mockResolvedValue()
		await expect(service.run(false)).resolves.toBe(true)
		const downloadedFile = install.mock.calls[0][0]
		await expect(fs.access(downloadedFile)).rejects.toThrow()
	})

	it("keeps a failed check to itself rather than throwing at activation", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"))
		const log = vi.fn()
		const service = new UpdateService(context, log, fetchImpl as never)

		const result = await service.check()

		expect(result).toMatchObject({ available: false, error: "offline" })
		expect(log).toHaveBeenCalledWith(expect.stringContaining("offline"))
	})

	it("refuses a download whose bytes do not match the manifest", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		const fetchImpl = vi
			.fn()
			.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("payload").buffer })
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)

		// An update is code. Executing bytes nobody verified, on the strength of
		// a filename, is how a broken mirror becomes a compromised install.
		await expect(
			service.download({ version: "0.2.0", url: "https://example.invalid/o.vsix", sha256: "0".repeat(64) }),
		).rejects.toThrow(/checksum mismatch/)
		expect(executeCommand).not.toHaveBeenCalled()
	})

	it("stays quiet on startup unless asked to look", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		settings["octocode.update.mode"] = "manual"
		const fetchImpl = vi.fn()
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)

		await service.checkOnStartup()

		expect(fetchImpl).not.toHaveBeenCalled()
		// Quiet means no badge too: nothing is asserted about updates that was
		// never checked.
		expect(badge.visible).toBe(false)
	})

	it("raises a red-dot badge that is itself the one-click update", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		settings["octocode.update.mode"] = "start"
		const manifest = {
			version: "0.2.0",
			url: "https://example.invalid/octocode-0.2.0.vsix",
			sha256: "a".repeat(64),
		}
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => manifest })
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)

		await service.checkOnStartup()

		// Red dot plus label, and the item is clickable to the apply command.
		expect(badge.visible).toBe(true)
		expect(badge.text).toContain("circle-filled")
		expect(badge.backgroundColor).toBeInstanceOf(Object)
		expect(badge.command).toBe("octocode.applyUpdateNow")
		expect(registerCommand).toHaveBeenCalledWith("octocode.applyUpdateNow", expect.any(Function))
	})

	it("keeps the update badge available after a failed apply", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		settings["octocode.update.mode"] = "start"
		const manifest = { version: "0.2.0", url: "https://example.invalid/o.vsix", sha256: "a".repeat(64) }
		const service = new UpdateService(
			context,
			vi.fn(),
			vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }),
		)
		await service.checkOnStartup()
		vi.spyOn(service, "run").mockResolvedValue(false)
		const apply = registerCommand.mock.calls.find(([name]) => name === "octocode.applyUpdateNow")?.[1]
		expect(apply).toBeTypeOf("function")
		await apply!()
		expect(badge.visible).toBe(true)
		expect(badge.text).toContain("Update")
	})

	it("hides the badge when the channel reports no update", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		settings["octocode.update.mode"] = "start"
		const manifest = {
			version: "0.1.0",
			url: "https://example.invalid/octocode-0.1.0.vsix",
			sha256: "a".repeat(64),
		}
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => manifest })
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)

		await service.checkOnStartup()

		expect(badge.visible).toBe(false)
	})
})
