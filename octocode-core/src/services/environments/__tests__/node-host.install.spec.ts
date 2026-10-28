import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createNodeProvisionerHost, resolvePythonWheelDirectory } from "../node-host"
import type { EnvironmentDescriptor } from "../manifest"
import { downloadBinaryFile } from "../../managed-binary/download"
import { extractZipArchive } from "../../managed-binary/archive"

vi.mock("../../managed-binary/download", async (original) => ({
	...(await original<typeof import("../../managed-binary/download")>()),
	downloadBinaryFile: vi.fn(),
}))
vi.mock("../../managed-binary/archive", async (original) => ({
	...(await original<typeof import("../../managed-binary/archive")>()),
	extractZipArchive: vi.fn(),
}))

const roots: string[] = []
afterEach(async () => {
	vi.clearAllMocks()
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function temporaryRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-host-install-"))
	roots.push(root)
	return root
}

describe("environment archive installation", () => {
	const payload = Buffer.from("isolated archive fixture")
	const descriptor: EnvironmentDescriptor = {
		id: "fixture",
		label: "Fixture",
		tier: "toolchain",
		shipped: false,
		approxSizeMb: 1,
		detect: { win32: "tool.exe", posix: "tool" },
		purpose: "Test only",
		source: {
			kind: "archive",
			url: "https://github.com/fixture/tool.zip",
			archive: "zip",
			sha256: createHash("sha256").update(payload).digest("hex"),
		},
	}

	it("verifies the pinned archive and stages on the destination volume", async () => {
		const root = await temporaryRoot()
		vi.mocked(downloadBinaryFile).mockImplementation(async (_url, destination) => {
			expect(path.relative(root, destination)).not.toMatch(/^\.\./)
			await fs.writeFile(destination, payload)
		})
		vi.mocked(extractZipArchive).mockImplementation(async (_archive, destination) => {
			await fs.writeFile(path.join(destination, "tool.exe"), "installed")
		})
		await createNodeProvisionerHost(root).installArchive(descriptor, path.join(root, "fixture"), () => {})
		expect(await fs.readFile(path.join(root, "fixture/tool.exe"), "utf8")).toBe("installed")
		expect(await fs.readdir(root)).toEqual(["fixture"])
	})

	it("rejects a checksum mismatch before extraction or replacement", async () => {
		const root = await temporaryRoot()
		await fs.mkdir(path.join(root, "fixture"))
		await fs.writeFile(path.join(root, "fixture/existing"), "preserved")
		vi.mocked(downloadBinaryFile).mockImplementation(async (_url, destination) => {
			await fs.writeFile(destination, "corrupted archive")
		})
		await expect(
			createNodeProvisionerHost(root).installArchive(descriptor, path.join(root, "fixture"), () => {}),
		).rejects.toThrow(/SHA-256/)
		expect(extractZipArchive).not.toHaveBeenCalled()
		expect(await fs.readFile(path.join(root, "fixture/existing"), "utf8")).toBe("preserved")
		expect(await fs.readdir(root)).toEqual(["fixture"])
	})
})

describe("bundled Python wheels", () => {
	it.each(["dist", "services/environments"])("resolves resources from %s", async (layout) => {
		const root = await temporaryRoot()
		const wheels = path.join(root, "resources/python")
		await fs.mkdir(wheels, { recursive: true })
		expect(await resolvePythonWheelDirectory(path.join(root, layout))).toBe(wheels)
	})

	it("finds the actual product wheel in a source checkout", async () => {
		const wheels = await resolvePythonWheelDirectory()
		expect((await fs.readdir(wheels)).some((name) => name.endsWith(".whl"))).toBe(true)
	})
})
