import { resolvers, TRUSTED_TOOLCHAIN_DOMAINS } from "../resolvers"
import { environmentManifest } from "../manifest"

/**
 * Exercises the real resolvers against the real vendor APIs.
 *
 * A resolver that returns a plausible-looking URL for the wrong artifact fails
 * only at install time, on a user's machine, as "the executable was not found".
 * That already happened once: `python` delegated to `uv`, so provisioning
 * unpacked uv.exe while the manifest looked for python.exe, and the bundled
 * code-review-graph MCP server could never start. These tests resolve for real
 * so that class of mistake is caught here instead.
 *
 * Gated behind OCTOCODE_NET_TESTS so the default suite stays offline.
 */
const enabled = process.env.OCTOCODE_NET_TESTS === "1"

describe.skipIf(!enabled)("toolchain resolvers (network)", () => {
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

	it("resolves a real CPython interpreter, not the uv installer", async () => {
		const resolved = await resolvers.python()

		// The artifact must be an interpreter distribution...
		expect(resolved.url).toMatch(/cpython-/)
		expect(resolved.url).toMatch(/install_only\.tar\.gz$/)
		// ...and specifically NOT the variants that share the prefix.
		expect(resolved.url).not.toMatch(/_stripped/)
		expect(resolved.url).not.toMatch(/freethreaded/)
		// The regression this guards: uv is an installer, not an interpreter.
		expect(resolved.url).not.toMatch(/astral-sh\/uv\//)

		expect(resolved.archive).toBe("tar.gz")
		// install_only archives carry a single `python/` root that must be stripped
		// for python.exe to land where the manifest's detect marker looks.
		expect(resolved.stripRoot).toBe(true)
		expect(resolved.version).toMatch(/^3\.\d+\.\d+$/)
	}, 120_000)

	it("keeps the provisioned Python in step with toolchain.json", async () => {
		const fs = await import("fs")
		const path = await import("path")
		const { fileURLToPath } = await import("url")

		let dir = path.dirname(fileURLToPath(import.meta.url))
		let toolchainPath = ""
		for (let i = 0; i < 8; i++) {
			const candidate = path.join(dir, "toolchain.json")
			if (fs.existsSync(candidate)) {
				toolchainPath = candidate
				break
			}
			const parent = path.dirname(dir)
			if (parent === dir) break
			dir = parent
		}
		expect(toolchainPath).not.toBe("")

		const declared = JSON.parse(fs.readFileSync(toolchainPath, "utf8")).python as string
		const resolved = await resolvers.python()
		// Same major.minor series; the patch floats so security releases arrive
		// without a code change.
		expect(resolved.version.split(".").slice(0, 2).join(".")).toBe(declared.split(".").slice(0, 2).join("."))
	}, 120_000)

	it("resolves every on-demand environment to a trusted host", async () => {
		const onDemand = environmentManifest.filter((e) => !e.shipped && e.source.kind === "resolver")
		expect(onDemand.length).toBeGreaterThan(5)

		const failures: string[] = []
		for (const env of onDemand) {
			try {
				const resolved = await resolvers[(env.source as { resolver: string }).resolver]()
				const host = new URL(resolved.url).hostname
				const trusted = TRUSTED_TOOLCHAIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
				if (!trusted) failures.push(`${env.id}: untrusted host ${host}`)
				if (!/^https:/.test(resolved.url)) failures.push(`${env.id}: not https`)
			} catch (error) {
				failures.push(`${env.id}: ${(error as Error).message}`)
			}
		}
		expect(failures).toEqual([])
	}, 600_000)
})
