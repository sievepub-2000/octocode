import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { createNodeProvisionerHost } from "../node-host"
import { EnvironmentProvisioner, type ProvisionProgress } from "../provisioner"
import { getEnvironment } from "../manifest"

/**
 * Provisions a real toolchain, end to end, against the real vendor.
 *
 * Every other test in this directory mocks the download. That is what let a
 * broken `python` resolver survive: it returned a perfectly well-formed
 * ResolvedDownload for the *uv installer*, so the unit tests were happy while a
 * real install could only ever fail with "executable was not found". Only an
 * actual download-extract-detect cycle proves a resolver is pointed at the right
 * artifact and that stripRoot lands the binary where the manifest looks for it.
 *
 * Gated behind OCTOCODE_NET_TESTS; downloads tens of MB.
 */
const enabled = process.env.OCTOCODE_NET_TESTS === "1"

describe.skipIf(!enabled)("environment provisioning (network, end to end)", () => {
	let root = ""

	beforeAll(async () => {
		const nock = (await import("nock")).default
		nock.cleanAll()
		nock.restore()
		nock.enableNetConnect()
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "octocode-provision-"))
	})

	afterAll(async () => {
		const nock = (await import("nock")).default
		if (!nock.isActive()) nock.activate()
		nock.disableNetConnect()
		if (root) await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {})
	})

	it("installs a working Python where the manifest's detect marker expects it", async () => {
		const provisioner = new EnvironmentProvisioner(createNodeProvisionerHost(root))
		const progress: ProvisionProgress[] = []

		const result = await provisioner.ensure("python", (p) => progress.push(p))

		expect(result.installed).toBe(true)
		// `ensure` already fails when the detect marker is missing, but assert the
		// file directly so a regression names the real problem instead of a phase.
		const env = getEnvironment("python")!
		const marker = path.join(root, "python", process.platform === "win32" ? env.detect.win32 : env.detect.posix)
		expect(fs.existsSync(marker)).toBe(true)

		// The interpreter must actually run — an archive can extract a file of the
		// right name that is not a usable interpreter.
		const { runProcess } = await import("../../managed-binary/archive")
		const { stdout, stderr } = await runProcess(marker, ["--version"], 60_000)
		expect(`${stdout}${stderr}`).toMatch(/^Python 3\.\d+\.\d+/)

		// Progress must state the size before a multi-tens-of-MB download starts,
		// since that line is what the agent narrates to the user.
		expect(progress[0].phase).toBe("resolving")
		expect(progress[0].message).toMatch(/MB|GB/)
		expect(progress.at(-1)!.phase).toBe("done")
	}, 900_000)

	it("treats an already-provisioned environment as present without re-downloading", async () => {
		const provisioner = new EnvironmentProvisioner(createNodeProvisionerHost(root))
		const progress: ProvisionProgress[] = []

		const result = await provisioner.ensure("python", (p) => progress.push(p))

		expect(result.installed).toBe(false)
		expect(progress.map((p) => p.phase)).toEqual(["already-present"])
	}, 120_000)
})
