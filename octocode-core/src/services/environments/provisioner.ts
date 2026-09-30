import * as path from "path"

import { type EnvironmentDescriptor, environmentManifest, findEnvironmentForCommand, getEnvironment } from "./manifest"

export type ProvisionPhase = "already-present" | "resolving" | "downloading" | "extracting" | "done" | "failed"

export interface ProvisionProgress {
	id: string
	label: string
	phase: ProvisionPhase
	/** Human-readable line suitable for the agent to narrate verbatim. */
	message: string
	receivedBytes?: number
	totalBytes?: number
}

export interface ProvisionResult {
	id: string
	/** False when the environment was already installed and nothing was downloaded. */
	installed: boolean
	/** PATH entries this environment contributes, absolute. */
	pathEntries: string[]
}

/**
 * Everything that touches the outside world. Kept injectable so the decision
 * logic below can be tested without a network, a filesystem, or a WSL host.
 */
export interface ProvisionerHost {
	environmentsDir: string
	platform: NodeJS.Platform
	pathExists(absolutePath: string): Promise<boolean>
	/** Download + verify + extract into `targetDir`. Must be atomic from the caller's view. */
	installArchive(
		env: EnvironmentDescriptor,
		targetDir: string,
		onProgress: (p: ProvisionProgress) => void,
	): Promise<void>
	/** WSL distributions are registered in the OS, not detectable as a file. */
	isWslDistroRegistered(distroName: string): Promise<boolean>
	importWslDistro(distroName: string, onProgress: (p: ProvisionProgress) => void): Promise<void>
	/**
	 * Install `env.packages` with the environment's own interpreter, then write
	 * `marker` so the result is detectable. Writing the marker last is what makes
	 * a failed or interrupted install visible as "not installed" rather than as a
	 * complete one.
	 */
	installPackages(
		env: EnvironmentDescriptor,
		targetDir: string,
		marker: string,
		onProgress: (p: ProvisionProgress) => void,
	): Promise<void>
	/** Delete an installed environment: its directory, and for WSL its registration. */
	removeEnvironment(env: EnvironmentDescriptor, targetDir: string): Promise<void>
}

/**
 * Where the record of an environment's installed packages lives.
 *
 * The package list is part of the file name, so changing what the product needs
 * invalidates the marker on its own: an environment provisioned before a package
 * was added stops counting as installed and is completed on next use. Comparing
 * file contents would need a read in the detect path for the same result.
 */
export function packagesMarkerPath(envDir: string, packages: readonly string[]): string {
	const slug = packages.join("_").replace(/[^a-z0-9_.-]/gi, "-")
	return path.join(envDir, `.octocode-packages-${slug}`)
}

export const OCTOCODE_WSL_DISTRO = "OctoCode"

export class EnvironmentProvisioner {
	/**
	 * In-flight installs, keyed by environment id. Two tools racing to run
	 * `cargo build` must produce one download, not two writing the same directory.
	 */
	private readonly inFlight = new Map<string, Promise<ProvisionResult>>()

	constructor(private readonly host: ProvisionerHost) {}

	private isWin(): boolean {
		return this.host.platform === "win32"
	}

	private envDir(env: EnvironmentDescriptor): string {
		return path.join(this.host.environmentsDir, env.id)
	}

	resolvePathEntries(env: EnvironmentDescriptor): string[] {
		const entries = this.isWin() ? env.pathEntries?.win32 : env.pathEntries?.posix
		if (!entries?.length) return []
		const base = this.envDir(env)
		return entries.map((rel) => (rel === "." ? base : path.join(base, rel)))
	}

	async isInstalled(id: string): Promise<boolean> {
		const env = getEnvironment(id)
		if (!env) return false

		if (env.source.kind === "system") {
			return this.host.isWslDistroRegistered(OCTOCODE_WSL_DISTRO)
		}

		const rel = this.isWin() ? env.detect.win32 : env.detect.posix
		// An environment with no detect marker cannot be probed; treat as absent
		// rather than silently claiming success.
		if (!rel) return false

		const dir = this.envDir(env)
		if (!(await this.host.pathExists(path.join(dir, rel)))) return false

		// An interpreter without the packages the product asked for is not a
		// finished environment: whatever wanted it would start and then fail on the
		// missing module, which is far harder to read than "not installed yet".
		if (env.packages?.length) {
			return this.host.pathExists(packagesMarkerPath(dir, env.packages))
		}

		return true
	}

	/**
	 * Uninstall an on-demand environment. Core environments ship with the product
	 * and are refused; an install in progress must finish first.
	 */
	async remove(id: string): Promise<void> {
		const env = getEnvironment(id)
		if (!env) throw new Error(`Unknown environment "${id}"`)
		if (env.tier === "core" || env.shipped)
			throw new Error(`${env.label} is part of the base installation and cannot be removed.`)
		if (this.inFlight.has(id)) throw new Error(`${env.label} is being installed; try again when it finishes.`)
		await this.host.removeEnvironment(env, this.envDir(env))
	}

	/**
	 * Ensure `id` is installed, downloading it if necessary.
	 *
	 * Concurrent calls for the same id share one installation. A failed install
	 * is not cached: the next call retries rather than inheriting the failure.
	 */
	async ensure(id: string, onProgress: (p: ProvisionProgress) => void = () => {}): Promise<ProvisionResult> {
		const env = getEnvironment(id)
		if (!env) {
			throw new Error(`Unknown environment "${id}". Known: ${environmentManifest.map((e) => e.id).join(", ")}`)
		}

		const existing = this.inFlight.get(id)
		if (existing) return existing

		const run = this.install(env, onProgress).finally(() => {
			this.inFlight.delete(id)
		})

		this.inFlight.set(id, run)
		return run
	}

	private async install(
		env: EnvironmentDescriptor,
		onProgress: (p: ProvisionProgress) => void,
	): Promise<ProvisionResult> {
		const pathEntries = this.resolvePathEntries(env)

		if (await this.isInstalled(env.id)) {
			onProgress({
				id: env.id,
				label: env.label,
				phase: "already-present",
				message: `${env.label} is already available.`,
			})
			return { id: env.id, installed: false, pathEntries }
		}

		if (env.tier === "core") {
			// Core environments ship with the installer. If one is missing the
			// installation is damaged, and silently re-downloading it would paper
			// over that rather than surfacing it.
			throw new Error(
				`${env.label} is part of the base installation but is missing. Repair or reinstall OctoCode rather than provisioning it at runtime.`,
			)
		}

		onProgress({
			id: env.id,
			label: env.label,
			phase: "resolving",
			message: `Setting up ${env.label} (about ${formatSize(env.approxSizeMb)}). ${env.purpose}`,
		})

		try {
			if (env.source.kind === "system") {
				await this.host.importWslDistro(OCTOCODE_WSL_DISTRO, onProgress)
			} else {
				const dir = this.envDir(env)
				const executable = this.isWin() ? env.detect.win32 : env.detect.posix
				if (!(await this.host.pathExists(path.join(dir, executable))))
					await this.host.installArchive(env, dir, onProgress)
				if (env.packages?.length) {
					onProgress({
						id: env.id,
						label: env.label,
						phase: "extracting",
						message: `Installing ${env.packages.join(", ")} into ${env.label}…`,
					})
					await this.host.installPackages(env, dir, packagesMarkerPath(dir, env.packages), onProgress)
				}
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			onProgress({
				id: env.id,
				label: env.label,
				phase: "failed",
				message: `Could not set up ${env.label}: ${reason}`,
			})
			throw new Error(`Failed to provision ${env.label}: ${reason}`)
		}

		// Trust but verify: a resolver can return a 200 for a wrong archive shape,
		// leaving a directory that exists but has no usable executable in it.
		if (!(await this.isInstalled(env.id))) {
			const message = `${env.label} finished installing but its executable was not found where expected.`
			onProgress({ id: env.id, label: env.label, phase: "failed", message })
			throw new Error(message)
		}

		onProgress({ id: env.id, label: env.label, phase: "done", message: `${env.label} is ready.` })
		return { id: env.id, installed: true, pathEntries }
	}

	/**
	 * The environment an executable path belongs to, if it lives inside one.
	 *
	 * Trigger words cannot answer this: the bundled MCP servers are configured
	 * with absolute paths built from `${env:OCTOCODE_PYTHON_BASE}` and friends, so
	 * the leading token is a full path to an interpreter, not `python`. Without
	 * this the servers spawn against a directory that has not been provisioned yet
	 * and fail with ENOENT — which is what a fresh install did.
	 */
	environmentForExecutable(executable: string): EnvironmentDescriptor | undefined {
		if (!executable) return undefined

		const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").toLowerCase()
		const root = normalize(this.host.environmentsDir)
		const target = normalize(executable)
		if (!target.startsWith(`${root}/`)) return undefined

		const id = target.slice(root.length + 1).split("/")[0]
		return environmentManifest.find((env) => env.id.toLowerCase() === id)
	}

	/**
	 * Ensure whatever environment an executable path lives in, if any.
	 */
	async ensureForExecutable(
		executable: string,
		onProgress?: (p: ProvisionProgress) => void,
	): Promise<ProvisionResult | undefined> {
		const env = this.environmentForExecutable(executable)
		if (!env) return undefined
		return this.ensure(env.id, onProgress)
	}

	/**
	 * Ensure whatever environment a command needs, if any.
	 * Returns undefined when the command needs nothing that is provisioned.
	 */
	async ensureForCommand(
		command: string,
		onProgress?: (p: ProvisionProgress) => void,
	): Promise<ProvisionResult | undefined> {
		const env = findEnvironmentForCommand(command)
		if (!env) return undefined
		return this.ensure(env.id, onProgress)
	}
}

export function formatSize(mb: number): string {
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}
