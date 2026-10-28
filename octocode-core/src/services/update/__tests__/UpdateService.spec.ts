import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const testSigning = await vi.hoisted(async () => {
	const crypto = await import("node:crypto")
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
	const der = publicKey.export({ format: "der", type: "spki" })
	return {
		RELEASE_PUBLIC_KEY_SPKI_BASE64: der.toString("base64"),
		RELEASE_PUBLIC_KEY_SHA256: crypto.createHash("sha256").update(der).digest("hex"),
		sign: (raw: Buffer) => crypto.sign(null, raw, privateKey),
	}
})
vi.mock("../releaseTrust", () => testSigning)

vi.mock("../../../i18n", () => ({ t: (key: string) => key, changeLanguage: vi.fn() }))

const showInformationMessage = vi.fn()
const showErrorMessage = vi.fn()
const showWarningMessage = vi.fn()
const executeCommand = vi.fn()
const registerCommand = vi.fn()
const getSession = vi.fn()
let settings: Record<string, unknown> = {}
const dirtyDocuments = vi.hoisted(() => [] as { isDirty: boolean }[])
const awaitIdleForUpdate = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("../../octocode-runtime/OctoCodeRuntime", () => ({ getOctoCodeRuntime: () => ({ awaitIdleForUpdate }) }))

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
	authentication: { getSession: (...a: unknown[]) => getSession(...a) },
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
		getSession.mockReset()
		settings = {}
		dirtyDocuments.length = 0
		awaitIdleForUpdate.mockResolvedValue(undefined)
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

	it("uses GitHub login only for the official private release and strips credentials on asset redirects", async () => {
		settings["octocode.update.manifestUrl"] = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
		getSession.mockResolvedValue({ accessToken: "fixture-private-token" })
		const asset = "https://api.github.com/repos/sievepub-2000/octocode/releases/assets/42"
		const bytes = Buffer.from("verified private VSIX")
		const manifest = { version: "0.2.0", url: asset, sha256: createHash("sha256").update(bytes).digest("hex") }
		const raw = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				product: "OctoCode",
				repository: "sievepub-2000/octocode",
				version: "2.0.0",
				tag: "v2.0",
				assets: {
					"windows-x64-system": { name: "OctoCodeSetup.exe", sha256: "a".repeat(64), size: 4 },
					extension: {
						name: "octocode-0.2.0.vsix",
						version: "0.2.0",
						sha256: manifest.sha256,
						size: bytes.length,
					},
				},
			}),
		)
		const metadata = {
			tag_name: "v2.0",
			assets: [
				{ name: "octocode-release.json", url: asset.replace("42", "40"), size: raw.length },
				{ name: "octocode-release.json.sig", url: asset.replace("42", "41"), size: 64 },
				{ name: "octocode-0.2.0.vsix", url: asset, size: bytes.length },
				{ name: "OctoCodeSetup.exe", url: asset.replace("42", "43"), size: 4 },
			],
		}
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
			.mockResolvedValueOnce(new Response(raw))
			.mockResolvedValueOnce(new Response(testSigning.sign(raw)))
			.mockResolvedValueOnce({
				ok: false,
				status: 302,
				headers: new Headers({
					location: "https://release-assets.githubusercontent.com/private.vsix?signature=fixture",
				}),
			})
			.mockResolvedValueOnce(new Response(bytes))
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		const result = await service.check(true)
		expect(result).toMatchObject({ available: true, manifest })
		expect(getSession).toHaveBeenCalledWith("github", ["repo"], { createIfNone: true })
		const downloaded = await service.download(result.manifest!)
		try {
			expect(await fs.readFile(downloaded)).toEqual(bytes)
			for (const [, options] of fetchImpl.mock.calls.slice(0, 4)) {
				expect(options.headers.Authorization).toBe("Bearer fixture-private-token")
				expect(options.redirect).toBe("manual")
			}
			expect(fetchImpl.mock.calls[4][1].headers).not.toHaveProperty("Authorization")
		} finally {
			await fs.rm(path.dirname(downloaded), { recursive: true, force: true })
		}
	})

	it("never opens a login prompt during a background check", async () => {
		settings["octocode.update.manifestUrl"] = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
		getSession.mockResolvedValue(undefined)
		const fetchImpl = vi.fn()
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		expect(await service.check()).toMatchObject({ available: false, error: expect.stringContaining("GitHub") })
		expect(getSession).toHaveBeenCalledWith("github", ["repo"], { silent: true })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("rejects unsigned official releases and direct API assets without a verified manifest", async () => {
		settings["octocode.update.manifestUrl"] = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
		getSession.mockResolvedValue({ id: "oauth-fixture", accessToken: "fixture-token" })
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ assets: [] })))
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		expect(await service.check()).toMatchObject({
			available: false,
			error: expect.stringContaining("unique asset"),
		})
		await expect(
			service.download({
				version: "0.2.0",
				url: "https://api.github.com/repos/sievepub-2000/octocode/releases/assets/42",
				sha256: "a".repeat(64),
			}),
		).rejects.toThrow("verified signed release")
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it("offers OAuth once when an explicit PAT cannot access a private release", async () => {
		settings["octocode.update.manifestUrl"] = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
		getSession
			.mockResolvedValueOnce({ id: "octocode-pat:fixture", accessToken: "fixture-bad-token" })
			.mockResolvedValueOnce({ id: "oauth-fixture", accessToken: "fixture-oauth-token" })
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(new Response("", { status: 403 }))
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		expect(await service.check(true)).toMatchObject({ available: false, error: "HTTP 403" })
		expect(getSession).toHaveBeenLastCalledWith("github", ["repo"], {
			forceNewSession: { detail: expect.any(String) },
		})
		expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer fixture-oauth-token")
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it("streams signed desktop bytes to disk and rejects excess bytes and cancellation", async () => {
		getSession.mockResolvedValue({ id: "oauth-fixture", accessToken: "fixture-token" })
		const bytes = Buffer.alloc(65_537, 23)
		const release = {
			desktop: {
				url: "https://api.github.com/repos/sievepub-2000/octocode/releases/assets/43",
				name: "OctoCodeSetup.exe",
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		} as import("../SignedRelease").OfficialRelease
		const fetchImpl = vi.fn().mockImplementation(async () => new Response(bytes))
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		const file = await service["downloadDesktop"](release, new AbortController().signal, { report: vi.fn() })
		try {
			expect(await fs.readFile(file)).toEqual(bytes)
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true })
		}
		await expect(
			service["downloadDesktop"](
				{ ...release, desktop: { ...release.desktop, size: bytes.length - 1 } },
				new AbortController().signal,
				{ report: vi.fn() },
			),
		).rejects.toThrow("signed size")
		const controller = new AbortController()
		controller.abort()
		await expect(service["downloadDesktop"](release, controller.signal, { report: vi.fn() })).rejects.toThrow()
	})

	it("rejects credential-bearing and insecure asset redirects without a second request", async () => {
		getSession.mockResolvedValue({ accessToken: "fixture-private-token" })
		for (const location of ["http://example.invalid/a.vsix", "https://user:password@example.invalid/a.vsix"]) {
			const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 302, headers: new Headers({ location }) })
			const service = new UpdateService(context, vi.fn(), fetchImpl as never)
			await expect(
				service.download({
					version: "0.2.0",
					url: "https://example.invalid/custom.vsix",
					sha256: "a".repeat(64),
				}),
			).rejects.toThrow("HTTPS without credentials")
			expect(fetchImpl).toHaveBeenCalledOnce()
		}
	})

	it("never authenticates an unrelated custom channel or accepts an external manifest asset", async () => {
		settings["octocode.update.manifestUrl"] = "https://example.invalid/latest.json"
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ version: "0.2.0", url: "https://example.invalid/a.vsix", sha256: "a".repeat(64) }),
		})
		const service = new UpdateService(context, vi.fn(), fetchImpl as never)
		await service.check(true)
		expect(getSession).not.toHaveBeenCalled()
		settings["octocode.update.manifestUrl"] = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
		getSession.mockResolvedValue({ accessToken: "fixture-private-token" })
		fetchImpl.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				assets: [{ name: "octocode-extension-update.json", url: "https://example.invalid/steal" }],
			}),
		})
		expect(await service.check(true)).toMatchObject({ available: false, error: expect.stringContaining("asset") })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
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
		expect(service.check).toHaveBeenCalledWith(true)
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
		awaitIdleForUpdate.mockRejectedValue(new Error("active tasks in another window"))
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
