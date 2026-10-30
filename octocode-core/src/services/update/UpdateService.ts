import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"

import * as vscode from "vscode"

import { t } from "../../i18n"
import {
	checkApiDigest,
	findOfficialAsset,
	MAX_RELEASE_BYTES,
	normalizeDesktopVersion,
	verifyOfficialRelease,
	type OfficialRelease,
} from "./SignedRelease"
import { RELEASE_PUBLIC_KEY_SHA256, RELEASE_PUBLIC_KEY_SPKI_BASE64 } from "./releaseTrust"
import { startRecoveryHelper } from "./DesktopRecovery"

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
const GITHUB_RELEASE_URL = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
const GITHUB_ASSET_URL = /^https:\/\/api\.github\.com\/repos\/sievepub-2000\/octocode\/releases\/assets\/\d+$/

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
 * The official release channel also supports the user's GitHub login. Custom
 * channels remain supported; an empty channel disables checks.
 */
export class UpdateService {
	private static installing = false
	private statusBarItem: vscode.StatusBarItem | undefined
	private applying = false
	private downloadedDirectory?: string
	private readonly officialManifests = new WeakMap<UpdateManifest, OfficialRelease>()
	private githubSession?: vscode.AuthenticationSession

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

	private async request(
		url: string,
		timeout: number,
		interactive = false,
		cancellation?: AbortSignal,
	): Promise<Response> {
		const headers: Record<string, string> = {}
		if (url === GITHUB_RELEASE_URL || GITHUB_ASSET_URL.test(url)) {
			const session =
				this.githubSession ?? (await vscode.authentication.getSession("github", ["repo"], { silent: true }))
			if (session) {
				this.githubSession = session
				headers.Authorization = `Bearer ${session.accessToken}`
			}
			headers.Accept = GITHUB_ASSET_URL.test(url) ? "application/octet-stream" : "application/vnd.github+json"
			headers["X-GitHub-Api-Version"] = "2022-11-28"
		}
		const deadline = AbortSignal.timeout(timeout)
		const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline
		let current = url
		for (let redirects = 0; redirects <= 5; redirects++) {
			const response = await this.fetchImpl(current, {
				cache: "no-store",
				signal,
				redirect: "manual",
				headers: redirects === 0 ? headers : {},
			})
			if (
				headers.Authorization !== undefined &&
				[401, 403, 404].includes(response.status) &&
				redirects === 0 &&
				interactive &&
				this.githubSession?.id?.startsWith("octocode-pat:")
			) {
				await response.body?.cancel()
				const oauth = await vscode.authentication.getSession("github", ["repo"], {
					forceNewSession: { detail: "The update token was rejected. Sign in with GitHub OAuth to retry." },
				})
				if (!oauth || oauth.id === this.githubSession.id || oauth.id.startsWith("octocode-pat:"))
					throw new Error(
						"GitHub rejected the update token; OAuth sign-in did not provide an alternative session",
					)
				this.githubSession = oauth
				return this.request(url, timeout, false, cancellation)
			}
			if (![301, 302, 303, 307, 308].includes(response.status)) return response
			const location = response.headers.get("location")
			if (!location) throw new Error("Update redirect is missing its location")
			const next = new URL(location, current)
			if (next.protocol !== "https:" || next.username || next.password)
				throw new Error("Update redirects must use HTTPS without credentials")
			await response.body?.cancel()
			current = next.href
		}
		throw new Error("Too many update redirects")
	}

	/** Bound manifest reads even when the server omits or lies about Content-Length. */
	private async readAsset(url: string, limit: number, interactive: boolean, timeout = 15_000): Promise<Buffer> {
		const response = await this.request(url, timeout, interactive)
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		if (!response.body) throw new Error("Release asset has no body")
		const reader = response.body.getReader()
		const chunks: Uint8Array[] = []
		let size = 0
		try {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				size += value.byteLength
				if (size > limit) throw new Error("Release asset exceeds its size limit")
				chunks.push(value)
			}
		} finally {
			await reader.cancel().catch(() => {})
		}
		return Buffer.concat(chunks, size)
	}

	private async officialRelease(interactive: boolean): Promise<OfficialRelease> {
		const metadataBytes = await this.readAsset(GITHUB_RELEASE_URL, MAX_RELEASE_BYTES, interactive)
		const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes))
		const manifest = findOfficialAsset(metadata, "octocode-release.json")
		const signature = findOfficialAsset(metadata, "octocode-release.json.sig")
		if (manifest.size > MAX_RELEASE_BYTES || signature.size !== 64)
			throw new Error("Invalid signed release asset size")
		const raw = await this.readAsset(manifest.url, MAX_RELEASE_BYTES, interactive)
		const sig = await this.readAsset(signature.url, 64, interactive)
		const verified = verifyOfficialRelease(raw, sig, metadata, {
			publicKeySpkiBase64: RELEASE_PUBLIC_KEY_SPKI_BASE64,
			publicKeySha256: RELEASE_PUBLIC_KEY_SHA256,
		})
		if (raw.length !== manifest.size || sig.length !== signature.size)
			throw new Error("Release asset size mismatch")
		checkApiDigest(manifest, crypto.createHash("sha256").update(raw).digest("hex"))
		checkApiDigest(signature, crypto.createHash("sha256").update(sig).digest("hex"))
		return verified
	}

	private async desktopVersion(): Promise<string> {
		const root = vscode.env.appRoot
		for (const name of ["product.json", "package.json"]) {
			const product = JSON.parse(await fs.readFile(path.join(root, name), "utf8")) as { version?: unknown }
			if (product.version !== undefined) return normalizeDesktopVersion(product.version)
		}
		throw new Error("The installed desktop does not declare its product version")
	}

	private async ensureIdle(): Promise<void> {
		if (vscode.workspace.textDocuments.some((document) => document.isDirty))
			throw new Error("Save all documents before updating")
		const { getOctoCodeRuntime } = await import("../octocode-runtime/OctoCodeRuntime")
		await getOctoCodeRuntime().awaitIdleForUpdate()
	}

	private async downloadDesktop(
		release: OfficialRelease,
		signal: AbortSignal,
		progress: vscode.Progress<{ increment?: number; message?: string }>,
	): Promise<string> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-recovery-"))
		const partial = path.join(directory, "download.part")
		try {
			const response = await this.request(release.desktop.url, 3_600_000, true, signal)
			if (!response.ok || !response.body) throw new Error(`Installer download failed: HTTP ${response.status}`)
			const contentLength = response.headers.get("content-length")
			if (contentLength !== null && Number(contentLength) !== release.desktop.size) {
				await response.body.cancel()
				throw new Error("Signed installer size mismatch")
			}
			const file = await fs.open(partial, "wx")
			const reader = response.body.getReader()
			const hash = crypto.createHash("sha256")
			let size = 0
			try {
				for (;;) {
					signal.throwIfAborted()
					const { done, value } = await reader.read()
					if (done) break
					size += value.byteLength
					if (size > release.desktop.size) throw new Error("Installer exceeds the signed size")
					hash.update(value)
					await file.writeFile(value)
					progress.report({ increment: (value.byteLength / release.desktop.size) * 100 })
				}
				await file.sync()
			} finally {
				await reader.cancel().catch(() => {})
				await file.close()
			}
			if (size !== release.desktop.size || hash.digest("hex") !== release.desktop.sha256)
				throw new Error("Signed installer verification failed")
			const installer = path.join(directory, release.desktop.name)
			await fs.rename(partial, installer)
			return installer
		} catch (error) {
			await fs.rm(directory, { recursive: true, force: true })
			throw error
		}
	}

	/** Full installer recovery using extension HTTPS, independent of the native update service. */
	async recoverDesktop(): Promise<boolean> {
		if (UpdateService.installing) return false
		UpdateService.installing = true
		let directory: string | undefined
		let handedOff = false
		let cancelHelper: (() => Promise<void>) | undefined
		try {
			if (process.platform !== "win32" || process.arch !== "x64" || vscode.env.remoteName)
				throw new Error("Desktop recovery requires the local Windows x64 application")
			const executable = await fs.realpath(process.execPath)
			const expected = await fs.realpath(path.resolve(vscode.env.appRoot, "..", "..", "OctoCode.exe"))
			if (executable.toLowerCase() !== expected.toLowerCase())
				throw new Error("Cannot identify the running OctoCode desktop")
			const mainPid = Number(process.env.VSCODE_PID)
			if (!Number.isSafeInteger(mainPid) || mainPid <= 0)
				throw new Error("Cannot identify the main application process")
			await this.ensureIdle()
			const release = await this.officialRelease(true)
			if (isNewer(await this.desktopVersion(), release.version))
				throw new Error("Desktop recovery cannot downgrade this installation")
			const choice = await vscode.window.showWarningMessage(
				`Download the verified OctoCode ${release.version} full installer? Your conversations and settings will be preserved.`,
				{ modal: true },
				"Download",
				"Cancel",
			)
			if (choice !== "Download") return false
			const installer = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Downloading verified OctoCode recovery installer",
					cancellable: true,
				},
				async (progress, token) => {
					const controller = new AbortController()
					const subscription = token.onCancellationRequested(() => controller.abort())
					try {
						if (token.isCancellationRequested) controller.abort()
						return await this.downloadDesktop(release, controller.signal, progress)
					} finally {
						subscription.dispose()
					}
				},
			)
			directory = path.dirname(installer)
			await this.ensureIdle()
			const confirmed = await vscode.window.showWarningMessage(
				`OctoCode ${release.version} is verified. Quit all OctoCode windows and install now? Installation will stop if a window vetoes quitting.`,
				{ modal: true },
				"Quit and install",
				"Cancel",
			)
			if (confirmed !== "Quit and install") return false
			await this.ensureIdle()
			await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true })
			cancelHelper = await startRecoveryHelper(directory, {
				mainPid,
				executable,
				installer,
				sha256: release.desktop.sha256,
				version: release.version,
				journal: path.join(this.context.globalStorageUri.fsPath, "desktop-recovery.json"),
			})
			await this.ensureIdle()
			const veto = await vscode.commands.executeCommand<boolean>("workbench.action.quit")
			if (veto !== false) {
				await cancelHelper()
				throw new Error(
					veto === true
						? "Application quit was cancelled; recovery stopped"
						: "This shell did not confirm the quit result; recovery stopped",
				)
			}
			handedOff = true
			// A vetoed workbench quit resolves too. Keep concurrent updates blocked
			// until the helper's bounded wait has ended; never kill that process.
			setTimeout(() => {
				UpdateService.installing = false
				void fs
					.readFile(path.join(this.context.globalStorageUri.fsPath, "desktop-recovery.json"), "utf8")
					.then((raw) => {
						const record = JSON.parse(raw) as { state?: string }
						if (record.state && !["completed", "cancelled"].includes(record.state))
							void vscode.window.showWarningMessage(
								`OctoCode recovery stopped (${record.state}). Close or save the blocking work before trying again.`,
							)
					})
					.catch(() => this.log("[update] recovery status unavailable"))
			}, 100_000).unref()
			return true
		} catch (error) {
			await cancelHelper?.().catch(() => {})
			const reason = error instanceof Error ? error.message : String(error)
			this.log(`[update] desktop recovery failed: ${reason}`)
			void vscode.window.showErrorMessage(`OctoCode recovery failed: ${reason}`)
			return false
		} finally {
			if (directory && !handedOff && !cancelHelper) await fs.rm(directory, { recursive: true, force: true })
			if (!handedOff) UpdateService.installing = false
		}
	}

	/** Asks the configured channel what the latest release is. Never throws. */
	async check(interactive = false): Promise<UpdateCheckResult> {
		const current = this.currentVersion
		const url = this.manifestUrl
		if (!url) {
			return { available: false, current, error: "no update channel configured" }
		}
		try {
			if (!allowedUpdateUrl(url))
				throw new Error("Update manifest URL must use HTTPS, loopback HTTP or local file")
			let manifest: UpdateManifest
			if (url === GITHUB_RELEASE_URL) {
				const release = await this.officialRelease(interactive)
				manifest = Object.freeze({ ...release.extension })
				this.officialManifests.set(manifest, release)
			} else if (new URL(url).protocol === "file:") {
				manifest = JSON.parse(await fs.readFile(fileURLToPath(url), "utf8")) as UpdateManifest
			} else {
				const response = await this.request(url, 15_000, interactive)
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
			if (
				manifest.minShellVersion &&
				isNewer(
					manifest.minShellVersion,
					url === GITHUB_RELEASE_URL ? await this.desktopVersion() : vscode.version,
				)
			)
				throw new Error("update requires a newer shell")
			const available = isNewer(manifest.version, current)
			this.log(`[update] channel reports ${manifest.version}, running ${current}`)
			return { available, current, manifest }
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			this.log(`[update] check failed: ${reason}`)
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
		if (
			(this.manifestUrl === GITHUB_RELEASE_URL || GITHUB_ASSET_URL.test(manifest.url)) &&
			!this.officialManifests.has(manifest)
		)
			throw new Error("Official update requires a verified signed release")
		if (!allowedUpdateUrl(manifest.url))
			throw new Error("Update package URL must use HTTPS, loopback HTTP or local file")
		if (!/^[\da-fA-F]{64}$/.test(manifest.sha256)) throw new Error("invalid update SHA-256")
		let bytes: Buffer
		const signed = this.officialManifests.get(manifest)
		if (new URL(manifest.url).protocol === "file:") {
			bytes = await fs.readFile(fileURLToPath(manifest.url))
		} else if (signed) {
			bytes = await this.readAsset(manifest.url, signed.extension.size, false, 120_000)
		} else {
			const response = await this.request(manifest.url, 120_000)
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			bytes = Buffer.from(await response.arrayBuffer())
		}
		const digest = crypto.createHash("sha256").update(bytes).digest("hex")
		if (signed && bytes.length !== signed.extension.size) throw new Error("Signed update package size mismatch")
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
			// Every run follows a user action, including a rail click or startup confirmation.
			const result = await this.check(true)
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
			try {
				if (vscode.workspace.textDocuments.some((document) => document.isDirty))
					throw new Error("Unsaved documents")
				// The Host knows sessions from every window; this process only
				// sees its own. Re-check at install time so a task started
				// between the prompt and this point cannot be overwritten.
				await getOctoCodeRuntime().awaitIdleForUpdate()
			} catch (busy) {
				vscode.window.showWarningMessage(t("common:update.busy"))
				this.log(`[update] install deferred: ${busy instanceof Error ? busy.message : busy}`)
				return false
			}
			try {
				const file = await this.download(manifest)
				try {
					await this.ensureIdle()
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
		if (this.context.globalStorageUri?.fsPath) {
			const journal = path.join(this.context.globalStorageUri.fsPath, "desktop-recovery.json")
			try {
				const record = JSON.parse(await fs.readFile(journal, "utf8")) as { state?: string }
				const pending = record.state === "waiting_for_exit" || record.state === "installing"
				if (record.state && !pending && !["completed", "cancelled"].includes(record.state))
					void vscode.window.showWarningMessage(
						`The previous OctoCode recovery did not complete (${record.state}). Your existing installation is preserved; run Recover OctoCode with Full Installer to try again.`,
					)
				if (!pending) await fs.unlink(journal)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					this.log("[update] could not read the previous recovery status")
			}
		}
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
