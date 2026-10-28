import { createHash } from "crypto"
import { createReadStream } from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { extractTarGzArchive, extractTarXzArchive, extractZipArchive, runProcess } from "../managed-binary/archive"
import { downloadBinaryFile, isTrustedHttpsUrl } from "../managed-binary/download"

import type { EnvironmentDescriptor } from "./manifest"
import type { ProvisionerHost, ProvisionProgress } from "./provisioner"
import { getResolver, type ResolvedDownload, TRUSTED_TOOLCHAIN_DOMAINS } from "./resolvers"

/** Official Ubuntu WSL images; SHA256SUMS in the same directory is the integrity source. */
export const UBUNTU_WSL_RELEASE = "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/"
export const UBUNTU_WSL_ROOTFS = "ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz"

async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256")
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
	return hash.digest("hex")
}

export function expectedSha256(sums: string, fileName: string): string | undefined {
	for (const line of sums.split(/\r?\n/)) {
		const [digest, name] = line.trim().split(/\s+\*?/)
		if (name === fileName && /^[0-9a-f]{64}$/i.test(digest ?? "")) return digest.toLowerCase()
	}
	return undefined
}

/** Refuse anything wildly larger than the biggest toolchain we expect (~3 GB). */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target)
		return true
	} catch {
		return false
	}
}

/** Bundled code runs from dist; direct TypeScript execution runs from services/environments. */
export async function resolvePythonWheelDirectory(moduleDirectory = __dirname): Promise<string> {
	for (const relative of ["../resources/python", "../../resources/python"]) {
		const directory = path.resolve(moduleDirectory, relative)
		if (await pathExists(directory)) return directory
	}
	throw new Error("Bundled Python wheels are missing. Repair or reinstall OctoCode.")
}

/**
 * Vendor archives usually contain a single versioned root directory
 * (`go/`, `jdk-25+9/`, `pandoc-3.11/`). Hoist its contents up one level so the
 * installed layout is stable across version bumps.
 */
async function stripSingleRoot(dir: string): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true })
	if (entries.length !== 1 || !entries[0].isDirectory()) return

	const inner = path.join(dir, entries[0].name)
	for (const entry of await fs.readdir(inner)) {
		await fs.rename(path.join(inner, entry), path.join(dir, entry))
	}
	await fs.rm(inner, { recursive: true, force: true })
}

/** Transient network failures (TLS reset, socket hang-up) should not fail a toolchain install. */
export async function withRetries<T>(label: string, work: () => Promise<T>, attempts = 3, delayMs = 3_000): Promise<T> {
	let lastError: unknown
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await work()
		} catch (error) {
			lastError = error
			const message = error instanceof Error ? error.message : String(error)
			const transient =
				/socket|TLS|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|network|hang up|timed out|timeout|aborted/i.test(
					message,
				)
			if (!transient || attempt === attempts) break
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
		}
	}
	throw lastError instanceof Error ? new Error(`${label} failed: ${lastError.message}`) : lastError
}

async function runBootstrapper(
	targetDir: string,
	executable: string,
	bootstrap: NonNullable<ResolvedDownload["bootstrap"]>,
): Promise<void> {
	const env = Object.fromEntries(
		Object.entries(bootstrap.env ?? {}).map(([key, relative]) => [key, path.join(targetDir, relative)]),
	)
	await withRetries(`${executable}`, () =>
		runProcess(path.join(targetDir, executable), bootstrap.args, bootstrap.timeoutMs ?? 20 * 60_000, env),
	)
}

export function createNodeProvisionerHost(environmentsDir: string): ProvisionerHost {
	return {
		environmentsDir,
		platform: process.platform,
		pathExists,

		async installArchive(
			env: EnvironmentDescriptor,
			targetDir: string,
			onProgress: (p: ProvisionProgress) => void,
		): Promise<void> {
			const resolved =
				env.source.kind === "resolver"
					? await withRetries(`${env.label} resolution`, getResolver(env.source.resolver))
					: env.source.kind === "archive"
						? {
								url: env.source.url,
								archive: env.source.archive,
								version: env.source.version ?? "pinned",
								stripRoot: false,
							}
						: (() => {
								throw new Error(`${env.label} is not installed from an archive`)
							})()

			// Re-validate after resolution: the vendor index is untrusted input, and a
			// redirected or tampered index must not be able to point us at a new host.
			if (!isTrustedHttpsUrl(resolved.url, TRUSTED_TOOLCHAIN_DOMAINS)) {
				throw new Error(`${env.label} resolved to an untrusted download host: ${resolved.url}`)
			}

			// Staging must share the destination volume: Windows cannot rename from
			// the user's C: temp directory into an installation on another drive.
			await fs.mkdir(path.dirname(targetDir), { recursive: true })
			const work = await fs.mkdtemp(path.join(path.dirname(targetDir), `.octocode-env-${env.id}-`))
			const archivePath = path.join(work, `payload.${resolved.archive === "exe" ? "exe" : resolved.archive}`)
			const staging = path.join(work, "staging")

			try {
				onProgress({
					id: env.id,
					label: env.label,
					phase: "downloading",
					message: `Downloading ${env.label} ${resolved.version}…`,
					totalBytes: env.approxSizeMb * 1024 * 1024,
				})

				await withRetries(`${env.label} download`, () =>
					downloadBinaryFile(resolved.url, archivePath, {
						name: env.label,
						trustedDomains: TRUSTED_TOOLCHAIN_DOMAINS,
						timeoutMs: 60_000,
						maxBytes: MAX_ARCHIVE_BYTES,
					}),
				)
				if (env.source.kind === "archive") {
					const actual = await sha256File(archivePath)
					if (!/^[0-9a-f]{64}$/i.test(env.source.sha256) || actual !== env.source.sha256.toLowerCase()) {
						throw new Error(`${env.label} archive failed its SHA-256 check.`)
					}
				}

				onProgress({
					id: env.id,
					label: env.label,
					phase: "extracting",
					message: `Installing ${env.label} ${resolved.version}…`,
				})

				await fs.mkdir(staging, { recursive: true })

				if (resolved.archive === "exe") {
					// Bootstrappers (rustup-init, dotnet-install) are kept as-is; the
					// environment's own installer places the toolchain.
					await fs.rename(archivePath, path.join(staging, path.basename(resolved.url)))
				} else if (resolved.archive === "zip") {
					await extractZipArchive(archivePath, staging)
				} else if (resolved.archive === "tar.gz") {
					await extractTarGzArchive(archivePath, staging)
				} else {
					await extractTarXzArchive(archivePath, staging)
				}

				if (resolved.stripRoot) {
					await stripSingleRoot(staging)
				}

				// Swap in atomically-ish: a half-extracted directory must never be
				// mistaken for a finished install by the detect probe.
				await fs.mkdir(path.dirname(targetDir), { recursive: true })
				await fs.rm(targetDir, { recursive: true, force: true })
				await fs.rename(staging, targetDir)

				if (resolved.archive === "exe" && resolved.bootstrap) {
					await runBootstrapper(targetDir, path.basename(resolved.url), resolved.bootstrap).catch(
						async (error) => {
							// A half-bootstrapped directory must not linger as a failed install.
							await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {})
							throw error
						},
					)
				}
			} finally {
				await fs.rm(work, { recursive: true, force: true }).catch(() => {})
			}
		},

		async installPackages(
			env: EnvironmentDescriptor,
			targetDir: string,
			marker: string,
			onProgress: (p: ProvisionProgress) => void,
		): Promise<void> {
			const packages = env.packages ?? []
			if (!packages.length) return

			// The environment's own detect marker *is* its interpreter, so this needs
			// no second path convention and cannot drift from what `isInstalled`
			// probes for.
			const relative = process.platform === "win32" ? env.detect.win32 : env.detect.posix
			const interpreter = path.join(targetDir, relative)
			if (!(await pathExists(interpreter))) {
				throw new Error(`${env.label} has no interpreter at ${interpreter} to install packages with`)
			}

			onProgress({
				id: env.id,
				label: env.label,
				phase: "extracting",
				message: `Installing ${packages.join(", ")}…`,
			})

			// `--no-input` so a prompt cannot hang a background install, and
			// `--no-warn-script-location` because the Scripts directory is on
			// OctoCode's own PATH rather than the user's.
			await runProcess(
				interpreter,
				[
					"-m",
					"pip",
					"install",
					"--no-input",
					"--disable-pip-version-check",
					"--no-warn-script-location",
					"--find-links",
					await resolvePythonWheelDirectory(),
					...packages,
				],
				20 * 60_000,
			)

			// Written last: an interrupted install leaves no marker, so the
			// environment reports "not installed" and is completed on next use
			// rather than being trusted as finished.
			await fs.writeFile(marker, `${packages.join("\n")}\n`, "utf8")
		},

		async removeEnvironment(env: EnvironmentDescriptor, targetDir: string): Promise<void> {
			if (env.source.kind === "system" && process.platform === "win32") {
				// Unregistering deletes the distribution's disk; the directory goes with it.
				await runProcess("wsl.exe", ["--unregister", "OctoCode"], 5 * 60_000).catch(() => undefined)
			}
			await fs.rm(targetDir, { recursive: true, force: true })
		},

		async isWslDistroRegistered(distroName: string): Promise<boolean> {
			if (process.platform !== "win32") return false
			try {
				const { stdout } = await runProcess("wsl.exe", ["--list", "--quiet"], 30_000)
				// wsl.exe emits UTF-16LE; strip the NULs rather than mis-decoding.
				return stdout
					.replace(/\0/g, "")
					.split(/\r?\n/)
					.map((line) => line.trim())
					.includes(distroName)
			} catch {
				return false
			}
		},

		async importWslDistro(distroName: string, onProgress: (p: ProvisionProgress) => void): Promise<void> {
			const label = "Linux environment (WSL2)"
			const installDir = path.join(environmentsDir, "wsl", distroName)
			const work = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-env-wsl-"))
			const rootfs = path.join(work, UBUNTU_WSL_ROOTFS)
			const sums = path.join(work, "SHA256SUMS")
			const download = (url: string, to: string) =>
				downloadBinaryFile(url, to, {
					name: label,
					trustedDomains: TRUSTED_TOOLCHAIN_DOMAINS,
					timeoutMs: 20 * 60_000,
					maxBytes: MAX_ARCHIVE_BYTES,
				})
			try {
				onProgress({ id: "wsl", label, phase: "downloading", message: "Downloading Ubuntu 24.04 for WSL…" })
				await download(`${UBUNTU_WSL_RELEASE}SHA256SUMS`, sums)
				await download(`${UBUNTU_WSL_RELEASE}${UBUNTU_WSL_ROOTFS}`, rootfs)
				const expected = expectedSha256(await fs.readFile(sums, "utf8"), UBUNTU_WSL_ROOTFS)
				const actual = await sha256File(rootfs)
				if (!expected || expected !== actual) {
					throw new Error(
						`Ubuntu WSL image failed its SHA-256 check (expected ${expected ?? "none"}, got ${actual}).`,
					)
				}
				onProgress({ id: "wsl", label, phase: "extracting", message: "Registering the Linux environment…" })
				await fs.mkdir(installDir, { recursive: true })
				await runProcess("wsl.exe", ["--import", distroName, installDir, rootfs, "--version", "2"], 15 * 60_000)
				// The stock rootfs has no compiler; install the toolchain the manifest triggers promise.
				onProgress({
					id: "wsl",
					label,
					phase: "extracting",
					message: "Installing build tools in the Linux environment…",
				})
				await runProcess(
					"wsl.exe",
					[
						"-d",
						distroName,
						"-u",
						"root",
						"--",
						"bash",
						"-lc",
						"apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q build-essential git curl ca-certificates",
					],
					30 * 60_000,
				)
			} finally {
				await fs.rm(work, { recursive: true, force: true }).catch(() => {})
			}
		},
	}
}
