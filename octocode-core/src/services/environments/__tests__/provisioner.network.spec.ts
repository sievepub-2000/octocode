import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { createNodeProvisionerHost } from "../node-host"
import { EnvironmentProvisioner } from "../provisioner"
import { resolvers } from "../resolvers"

/**
 * Exercises the real network + extraction path.
 *
 * Skipped unless OCTOCODE_NET_TESTS=1 so the normal suite stays hermetic and
 * offline-safe. Run explicitly when changing resolvers or the install pipeline —
 * a resolver that returns a 200 for the wrong asset is invisible to unit tests.
 */
const enabled = process.env.OCTOCODE_NET_TESTS === "1"

describe.skipIf(!enabled)("environment provisioning (network)", () => {
	// The global test setup installs nock and blocks all outbound connections so
	// the normal suite can never reach the internet. This spec is the deliberate
	// exception, so it re-enables real sockets for its own duration only.
	beforeAll(async () => {
		const nock = (await import("nock")).default
		nock.cleanAll()
		nock.restore()
		nock.enableNetConnect()
	})

	afterAll(async () => {
		const nock = (await import("nock")).default
		if (!nock.isActive()) nock.activate()
		nock.disableNetConnect()
	})

	it("resolves every vendor to a concrete, correctly-named asset", async () => {
		const checks: Array<[string, RegExp]> = [
			["golang", /go[\d.]+\.windows-(amd64|arm64)\.zip$/],
			["nodejs", /node-v[\d.]+-win-(x64|arm64)\.zip$/],
			["adoptium", /api\.adoptium\.net\/v3\/binary\/latest\/\d+\//],
			["uv", /uv-(x86_64|aarch64)-pc-windows-msvc\.zip$/],
			["powershell", /PowerShell-[\d.]+-win-(x64|arm64)\.zip$/],
			["protobuf", /protoc-[\d.]+-win64\.zip$/],
			["pandoc", /pandoc-[\d.]+-windows-x86_64\.zip$/],
			["ffmpeg", /ffmpeg-[\d.]+-essentials_build\.zip$/],
		]

		for (const [name, pattern] of checks) {
			const resolved = await resolvers[name]()
			expect(resolved.url, `${name} resolved to ${resolved.url}`).toMatch(pattern)
		}
	}, 180_000)

	it("downloads, extracts and detects a real toolchain end to end", async () => {
		// protobuf is the smallest real environment (~13 MB), so this proves the
		// whole pipeline without moving gigabytes.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-envtest-"))
		try {
			const provisioner = new EnvironmentProvisioner(createNodeProvisionerHost(root))

			expect(await provisioner.isInstalled("protobuf")).toBe(false)

			const phases: string[] = []
			const result = await provisioner.ensure("protobuf", (p) => phases.push(p.phase))

			expect(result.installed).toBe(true)
			expect(phases).toEqual(["resolving", "downloading", "extracting", "done"])
			expect(await provisioner.isInstalled("protobuf")).toBe(true)

			// The detect marker must be a real executable, not just a directory.
			const protoc = path.join(root, "protobuf", "bin", "protoc.exe")
			const stat = await fs.stat(protoc)
			expect(stat.size).toBeGreaterThan(1_000_000)

			// A second call must be a no-op rather than downloading again.
			const again = await provisioner.ensure("protobuf")
			expect(again.installed).toBe(false)
		} finally {
			await fs.rm(root, { recursive: true, force: true }).catch(() => {})
		}
	}, 300_000)
})
