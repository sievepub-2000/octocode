import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { environmentManifest, getExcludedFromInstallerIds } from "../manifest"

/**
 * The build script and the manifest each hold half of one decision: which
 * environments ship inside the installer. Nothing links them at compile time,
 * and a mismatch is silent in both directions — shipping an on-demand toolchain
 * quietly re-bloats the download, while excluding one that has no resolver
 * leaves a toolchain that can never be installed. So assert they agree.
 */
function findBuildScript(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 8; i++) {
		const candidate = path.join(dir, "build-desktop-product.remote.ps1")
		if (fs.existsSync(candidate)) return candidate
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	throw new Error("Could not locate build-desktop-product.remote.ps1 above the package directory")
}

function findInnoScript(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 8; i++) {
		const candidate = path.join(dir, "desktop-shell", "build", "win32", "code.iss")
		if (fs.existsSync(candidate)) return candidate
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	throw new Error("Could not locate desktop-shell/build/win32/code.iss above the package directory")
}

function parseOnDemandListFromScript(script: string): string[] {
	const block = script.match(/\$onDemandEnvironments\s*=\s*@\(([\s\S]*?)\)/)
	if (!block) throw new Error("build script no longer declares $onDemandEnvironments")
	return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
}

describe("installer payload", () => {
	it("ships the verified Protobuf 36.2 compiler on Windows", () => {
		const protobuf = environmentManifest.find((env) => env.id === "protobuf")
		expect(protobuf?.shipped).toBe(process.platform === "win32")
		if (process.platform === "win32") {
			expect(protobuf?.source).toEqual({
				kind: "archive",
				version: "36.2",
				url: "https://github.com/protocolbuffers/protobuf/releases/download/v36.2/protoc-36.2-win64.zip",
				sha256: "f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3",
				archive: "zip",
			})
			expect(getExcludedFromInstallerIds()).not.toContain("protobuf")
		} else expect(protobuf?.source.kind).toBe("resolver")
	})
	it("excludes exactly the environments the manifest marks as not shipped", () => {
		const script = fs.readFileSync(findBuildScript(), "utf8")
		expect(parseOnDemandListFromScript(script)).toEqual(getExcludedFromInstallerIds())
	})

	it("bootstraps with an interpreter that is actually installed", () => {
		// RunRequiredEnvironmentScript runs initialize.ps1 (which registers the WSL
		// distribution) and uninitialize.ps1 (which unregisters it). Pointing it at
		// a bundled interpreter broke exactly once: PowerShell 7 became an on-demand
		// environment, so pwsh.exe was absent at install time, initialize.ps1 never
		// ran, and a clean install silently shipped with no Linux toolchain.
		const iss = fs.readFileSync(findInnoScript(), "utf8")

		const start = iss.indexOf("procedure RunRequiredEnvironmentScript")
		expect(start).toBeGreaterThan(-1)
		const bootstrap = iss.slice(start, iss.indexOf("end;", start) + 4)

		// Collected rather than asserted per-id so a failure names every offender.
		const offenders = getExcludedFromInstallerIds().filter((id) => bootstrap.includes("environments\\" + id + "\\"))
		expect(offenders).toEqual([])
	})

	it("only excludes environments that can actually be re-downloaded", () => {
		// Excluding something with no download path would strand it permanently. A
		// resolver fetches an archive; a system source (WSL) downloads at first use.
		for (const env of environmentManifest.filter((e) => !e.shipped)) {
			expect(["resolver", "system"], `${env.id} is excluded but has no download source`).toContain(
				env.source.kind,
			)
		}
	})

	it("ships every environment that has no way to be fetched later", () => {
		for (const env of environmentManifest.filter((e) => !["resolver", "system"].includes(e.source.kind))) {
			expect(env.shipped, `${env.id} cannot be downloaded, so it must ship`).toBe(true)
		}
	})

	it("keeps the shipped set small enough to be worth the exercise", () => {
		const shippedMb = environmentManifest.filter((e) => e.shipped).reduce((sum, e) => sum + e.approxSizeMb, 0)
		const onDemandMb = environmentManifest.filter((e) => !e.shipped).reduce((sum, e) => sum + e.approxSizeMb, 0)

		// The bundled Linux image dominates what still ships; everything else that
		// remains should be small. If this flips, on-demand provisioning has stopped
		// earning its complexity.
		expect(onDemandMb).toBeGreaterThan(4000)
		// Python and Code Graph ship together so code intelligence works offline.
		expect(shippedMb - 5300).toBeLessThan(1100)
	})
})
