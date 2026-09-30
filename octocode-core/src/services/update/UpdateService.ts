import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"

import * as vscode from "vscode"

import { t } from "../../i18n"

/**
 * What a release says about itself.
 *
 * Only the extension layer is described here — the webview, the extension host
 * code and the two native binaries, about 260 MB. The Electron shell and the
 * 7 GB of bundled toolchains are not: they change rarely and are replaced by the
 * full installer, so shipping them again for a change to a button would move
 * gigabytes to deliver kilobytes.
 */
export interface UpdateManifest {
	/** Semver of the extension this release contains. */
	version: string
	/** Where the .vsix lives. Must use HTTPS, loopback HTTP, or a local file URL. */
	url: string
	/** Lowercase hex SHA-256 of the .vsix, checked before anything is installed. */
	sha256: string
	/** Optional human-readable summary, shown in the update prompt. */
	notes?: string
	/**
	 * Shell version this release needs.
	 *
	 * An extension update cannot change the Electron shell, so a release that
	 * depends on a newer one has to say so rather than install and misbehave.
	 */
	minShellVersion?: string
}

export interface UpdateCheckResult {
	/** True when the manifest names a version newer than the one running. */
	available: boolean
	current: string
	manifest?: UpdateManifest
	/** Set when the check could not reach a conclusion; never thrown at the caller. */
	error?: string
}

const MANIFEST_SETTING = "octocode.update.manifestUrl"
const MODE_SETTING = "octocode.update.mode"

/** Compare numeric versions and SemVer prerelease identifiers. Build metadata has no priority. */
export function isNewer(candidate: string, current: string): boolean {
	const parse = (value: string) => {
		const match =
			/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/.exec(
				value,
			)
		return match
			? { numbers: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)], pre: match[4]?.split(".") }
			: null
	}
	const a = parse(candidate)
	const b = parse(current)
	if (!a || !b) return false
	for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i]
	if (!a.pre) return Boolean(b.pre)
	if (!b.pre) return false
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		if (a.pre[i] === undefined) return false
		if (b.pre[i] === undefined) return true
		if (a.pre[i] === b.pre[i]) continue
		const left = /^\d+$/.test(a.pre[i]) ? Number(a.pre[i]) : a.pre[i]
		const right = /^\d+$/.test(b.pre[i]) ? Number(b.pre[i]) : b.pre[i]
		if (typeof left === "number") return typeof right === "number" ? left > right : true
		return typeof right === "number" ? false : left > right
	}
	return false
}

function allowedUpdateUrl(value: string): boolean {
	try {
		const url = new URL(value)
		return (
			!url.username &&
			!url.password &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
				(url.protocol === "file:" && !url.hostname && !url.search && !url.hash))
		)
	} catch {
		return false
	}
}

/**
 * Self-update for the extension layer.
 *
 * Deliberately inert until someone configures `octocode.update.manifestUrl`:
 * a build that phones home to an address the user never chose is the same
 * mistake as a built-in model endpoint, and this product has just finished
 * paying for that one.
 */
export class UpdateService {
	private static installing = false
	private statusBarItem: vscode.StatusBarItem | undefined
	private applying = false
	private downloadedDirectory?: string

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly log: (message: string) => void,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private get currentVersion(): string {
		return (this.context.extension?.packageJSON?.version as string) ?? "0.0.0"
	}

	private get manifestUrl(): string {
		return (vscode.workspace.getConfiguration().get<string>(MANIFEST_SETTING) ?? "").trim()
	}

	/** Asks the configured channel what the latest release is. Never throws. */
	async check(): Promise<UpdateCheckResult> {
		const current = this.currentVersion
		const url = this.manifestUrl
		if (!url) {
			return { available: false, current, error: "no update channel configured" }
		}
		try {
			if (!allowedUpdateUrl(url))
				throw new Error("Update manifest URL must use HTTPS, loopback HTTP or local file")
			let manifest: UpdateManifest
			if (new URL(url).protocol === "file:") {
				manifest = JSON.parse(await fs.readFile(fileURLToPath(url), "utf8")) as UpdateManifest
			} else {
				const response = await this.fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
				if (!response.ok) throw new Error(`HTTP ${response.status}`)
				manifest = (await response.json()) as UpdateManifest
			}
			if (!manifest?.version || !manifest.url || !manifest.sha256) {
				throw new Error("manifest is missing version, url or sha256")
			}
			if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(manifest.version))
				throw new Error("invalid update version")
			if (!allowedUpdateUrl(manifest.url))
				throw new Error("Update package URL must use HTTPS, loopback HTTP or local file")
			if (!/^[\da-fA-F]{64}$/.test(manifest.sha256)) throw new Error("invalid update SHA-256")
			if (manifest.minShellVersion && isNewer(manifest.minShellVersion, vscode.version))
				throw new Error("update requires a newer shell")
			const available = isNewer(manifest.version, current)
			this.log(`[update] channel reports ${manifest.version}, running ${current}`)
			return { available, current, manifest }
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			this.log(`[update] check failed: ${reason} [url=${url}]`)
			return { available: false, current, error: reason }
		}
	}

	/**
	 * Downloads a release and installs it.
	 *
	 * The hash is checked before the file is handed to the extension host: an
	 * update is code, and code that arrived over a network nobody verified is
	 * not something to execute on the strength of a filename.
	 */
	async download(manifest: UpdateManifest): Promise<string> {
		if (!allowedUpdateUrl(manifest.url))
			throw new Error("Update package URL must use HTTPS, loopback HTTP or local file")
		if (!/^[\da-fA-F]{64}$/.test(manifest.sha256)) throw new Error("invalid update SHA-256")
		let bytes: Buffer
		if (new URL(manifest.url).protocol === "file:") {
			bytes = await fs.readFile(fileURLToPath(manifest.url))
		} else {
			const response = await this.fetchImpl(manifest.url, {
				cache: "no-store",
				signal: AbortSignal.timeout(120_000),
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			bytes = Buffer.from(await response.arrayBuffer())
		}
		const digest = crypto.createHash("sha256").update(bytes).digest("hex")
		if (digest !== manifest.sha256.toLowerCase()) {
			throw new Error(`checksum mismatch: expected ${manifest.sha256}, got ${digest}`)
		}
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-update-"))
		const file = path.join(directory, "octocode-update.vsix")
		try {
			await fs.writeFile(file, bytes)
		} catch (error) {
			await fs.rm(directory, { recursive: true, force: true })
			throw error
		}
		this.downloadedDirectory = directory
		this.log(`[update] downloaded ${manifest.version} (${bytes.length} bytes) to ${file}`)
		return file
	}

	/** Hands the package to the extension host, which swaps it in on reload. */
	async install(vsixPath: string): Promise<void> {
		await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath))
		this.log(`[update] installed ${vsixPath}`)
	}

	/** The whole flow, with the prompts. Returns true when an update was applied. */
	async run(interactive: boolean): Promise<boolean> {
		if (UpdateService.installing) return false
		UpdateService.installing = true
		try {
			const result = await this.check()
			if (!result.available || !result.manifest) {
				if (result.error)
					vscode.window.showErrorMessage(t("common:update.check_failed", { error: result.error }))
				else if (interactive)
					vscode.window.showInformationMessage(t("common:update.up_to_date", { version: result.current }))
				return false
			}
			const manifest = result.manifest
			const choice = interactive
				? await vscode.window.showInformationMessage(
						t("common:update.available", { version: manifest.version, notes: manifest.notes ?? "" }),
						t("common:update.install"),
						t("common:update.later"),
					)
				: t("common:update.install")
			if (choice !== t("common:update.install")) return false
			const { getOctoCodeRuntime } = await import("../octocode-runtime/OctoCodeRuntime")
			if (
				vscode.workspace.textDocuments.some((document) => document.isDirty) ||
				getOctoCodeRuntime().hasActiveTasks()
			) {
				vscode.window.showWarningMessage(t("common:update.busy"))
				return false
			}
			try {
				const file = await this.download(manifest)
				try {
					await this.install(file)
				} finally {
					if (this.downloadedDirectory) {
						await fs
							.rm(this.downloadedDirectory, { recursive: true, force: true })
							.catch((error) => this.log(`[update] temporary cleanup failed: ${error}`))
						this.downloadedDirectory = undefined
					}
				}
				await vscode.commands.executeCommand("workbench.action.reloadWindow")
				return true
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				this.log(`[update] install failed: ${reason}`)
				vscode.window.showErrorMessage(t("common:update.failed", { error: reason }))
				return false
			}
		} finally {
			UpdateService.installing = false
		}
	}

	/** Called once at activation. Silent unless the user asked to be told. */
	async checkOnStartup(): Promise<void> {
		// The badge is wired up regardless so the one-click command always
		// exists, but nothing is contacted here unless the user opted in:
		// mode stays the gate, and a manual install never reaches the network.
		this.registerBadge()
		const mode = vscode.workspace.getConfiguration().get<string>(MODE_SETTING) ?? "manual"
		if (mode !== "start" || !this.manifestUrl) return
		const result = await this.check()
		this.renderBadge(result)
		if (!result.available || !result.manifest) return
		const choice = await vscode.window.showInformationMessage(
			t("common:update.available", { version: result.manifest.version, notes: result.manifest.notes ?? "" }),
			t("common:update.install"),
			t("common:update.later"),
		)
		if (choice === t("common:update.install")) await this.run(false)
	}

	/**
	 * Status-bar badge: a red dot plus a "Update" label that is itself the
	 * one-click update button. The dot is the notification the user asked for;
	 * clicking the item installs and reloads without a second hunt for a menu.
	 *
	 * Hidden unless an update is known, so a healthy install shows no chrome.
	 */
	private registerBadge(): void {
		if (this.statusBarItem) return
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000)
		this.statusBarItem.command = "octocode.applyUpdateNow"
		this.context.subscriptions.push(this.statusBarItem)
		this.context.subscriptions.push(
			vscode.commands.registerCommand("octocode.applyUpdateNow", async () => {
				if (this.applying) return
				this.applying = true
				if (this.statusBarItem) {
					this.statusBarItem.text = "$(sync~spin) Updating…"
					this.statusBarItem.backgroundColor = undefined
				}
				let applied = false
				try {
					applied = await this.run(false)
				} finally {
					this.applying = false
					if (applied) this.hideBadge()
					else if (this.statusBarItem) {
						this.statusBarItem.text = "$(circle-filled) Update"
						this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
					}
				}
			}),
		)
	}

	private renderBadge(result: UpdateCheckResult): void {
		if (!this.statusBarItem) this.registerBadge()
		if (!this.statusBarItem) return
		if (result.available && result.manifest) {
			// circle-filled is the red dot; bolt signals "restart to apply".
			this.statusBarItem.text = "$(circle-filled) Update"
			this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
			this.statusBarItem.tooltip = `OctoCode ${result.manifest.version} is ready. Click to install and reload.`
			this.statusBarItem.show()
		} else {
			this.hideBadge()
		}
	}

	private hideBadge(): void {
		if (this.statusBarItem) {
			this.statusBarItem.hide()
		}
	}
}
