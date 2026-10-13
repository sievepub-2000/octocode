import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import nock from "nock"

import { createNodeProvisionerHost } from "../node-host"
import { EnvironmentProvisioner } from "../provisioner"
import { resolvers } from "../resolvers"

const origin = "https://builds.dotnet.microsoft.com"
const indexPath = "/dotnet/release-metadata/releases-index.json"
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch")!

// Field names and asset naming follow Microsoft's official release metadata.
function channel(version = "10.0", phase = "active", type = "lts", eol = "2028-11-14") {
	return {
		"channel-version": version,
		"latest-release": `${version}.12`,
		"latest-release-date": "2026-09-08",
		security: true,
		"latest-runtime": `${version}.12`,
		"latest-sdk": `${version}.401`,
		product: ".NET",
		"support-phase": phase,
		"release-type": type,
		"releases.json": `${origin}/dotnet/release-metadata/${version}/releases.json`,
		"eol-date": eol,
	}
}

function sdk(version = "10.0.401") {
	return {
		version,
		"version-display": version,
		files: ["win-x64", "win-arm64", "win-x86", "linux-x64"].flatMap((rid) =>
			["exe", "zip"].map((extension) => ({
				name: `dotnet-sdk-${rid}.${extension}`,
				rid,
				url: `${origin}/dotnet/Sdk/${version}/dotnet-sdk-${version}-${rid}.${extension}`,
				hash: "a".repeat(128),
			})),
		),
	}
}

function releases(version = "10.0.401", channelVersion = "10.0") {
	return {
		"channel-version": channelVersion,
		"latest-release": `${channelVersion}.12`,
		"latest-release-date": "2026-09-08",
		"latest-runtime": `${channelVersion}.12`,
		"latest-sdk": version,
		"release-type": "lts",
		"support-phase": "active",
		"eol-date": "2028-11-14",
		releases: [{ "release-version": `${channelVersion}.12`, sdk: sdk(version), sdks: [sdk(version)] }],
	}
}

function mockIndex(entries: unknown = [channel()]) {
	return nock(origin).get(indexPath).reply(200, { "releases-index": entries })
}

function mockReleases(document: unknown = releases(), channelVersion = "10.0") {
	return nock(origin)
		.get(`/dotnet/release-metadata/${channelVersion}/releases.json`)
		.reply(200, typeof document === "string" ? document : JSON.stringify(document))
}

describe(".NET SDK resolver", () => {
	beforeEach(() => {
		nock.disableNetConnect()
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-10-01T12:00:00Z"))
		Object.defineProperty(process, "arch", { ...archDescriptor, value: "x64" })
	})

	afterEach(() => {
		nock.cleanAll()
		vi.restoreAllMocks()
		vi.useRealTimers()
		Object.defineProperty(process, "arch", archDescriptor)
	})

	it.each(["x64", "arm64"])("resolves the supported SDK Windows %s ZIP with a concrete version", async (arch) => {
		Object.defineProperty(process, "arch", { ...archDescriptor, value: arch })
		mockIndex()
		mockReleases()
		const result = await resolvers.dotnet()
		expect(result).toEqual({
			url: `${origin}/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-win-${arch}.zip`,
			archive: "zip",
			version: "10.0.401",
		})
	})

	it("selects the numerically highest supported LTS channel from an unsorted index", async () => {
		mockIndex([
			channel("8.0", "maintenance"),
			channel("9.0", "active", "sts"),
			channel("12.0", "preview"),
			channel("14.0", "go-live"),
			channel("16.0", "eol"),
			channel("18.0", "active", "lts", "2026-09-30"),
			channel("10.0", "maintenance"),
		])
		mockReleases()
		await expect(resolvers.dotnet()).resolves.toMatchObject({ version: "10.0.401" })
	})

	it("accepts a maintenance LTS through its end-of-support date", async () => {
		mockIndex([channel("8.0", "maintenance", "lts", "2026-10-01")])
		mockReleases(releases("8.0.425", "8.0"), "8.0")
		await expect(resolvers.dotnet()).resolves.toMatchObject({ version: "8.0.425" })
	})

	it("uses latest-sdk rather than the first release or an older SDK feature band", async () => {
		const document = releases("10.0.402")
		document.releases.unshift({ "release-version": "10.0.11", sdk: sdk("10.0.301"), sdks: [sdk("10.0.301")] })
		mockIndex()
		mockReleases(document)
		await expect(resolvers.dotnet()).resolves.toMatchObject({ version: "10.0.402" })
	})

	it("finds latest-sdk in the official sdks array when it differs from the primary sdk", async () => {
		const document = releases()
		document.releases[0].sdk = sdk("10.0.301")
		mockIndex()
		mockReleases(document)
		await expect(resolvers.dotnet()).resolves.toMatchObject({ version: "10.0.401" })
	})

	it.each(
		[
			[],
			[channel("12.0", "preview")],
			[channel("12.0", "go-live")],
			[channel("12.0", "active", "sts")],
			[channel("12.0", "eol")],
			[channel("12.0", "maintenance", "lts", "2026-09-30")],
		].map((entries) => [entries]),
	)("rejects an index without a currently supported LTS: %j", async (entries) => {
		mockIndex(entries)
		await expect(resolvers.dotnet()).rejects.toThrow(/No supported.*LTS/i)
	})

	it.each([null, {}, { "releases-index": {} }, { "releases-index": [null] }])(
		"rejects malformed index shape: %j",
		async (document) => {
			nock(origin).get(indexPath).reply(200, JSON.stringify(document))
			await expect(resolvers.dotnet()).rejects.toThrow(/Invalid.*NET.*metadata/i)
		},
	)

	it.each([
		{ "channel-version": "latest" },
		{ "eol-date": "invalid" },
		{ "eol-date": "2028-02-30" },
		{ "eol-date": undefined },
		{ "releases.json": undefined },
	])("rejects malformed supported channel fields: %j", async (fields) => {
		mockIndex([{ ...channel(), ...fields }])
		await expect(resolvers.dotnet()).rejects.toThrow(/Invalid.*NET.*metadata/i)
	})

	it.each([
		"https://untrusted.example/releases.json",
		"https://builds.dotnet.microsoft.com.evil.example/releases.json",
		"http://builds.dotnet.microsoft.com/releases.json",
		"https://127.0.0.1/releases.json",
	])("rejects a release metadata URL outside trusted HTTPS: %s", async (url) => {
		mockIndex([{ ...channel(), "releases.json": url }])
		await expect(resolvers.dotnet()).rejects.toThrow(/trusted/i)
	})

	it.each([
		null,
		{},
		{ ...releases(), "channel-version": "8.0" },
		{ ...releases(), "latest-sdk": "LTS" },
		{ ...releases(), "latest-sdk": "10.0.402-preview.1" },
		{ ...releases(), "latest-sdk": "8.0.425" },
		{ ...releases(), releases: {} },
		{ ...releases(), releases: [null] },
	])("rejects malformed or inconsistent release metadata: %j", async (document) => {
		mockIndex()
		mockReleases(JSON.stringify(document))
		await expect(resolvers.dotnet()).rejects.toThrow(/Invalid.*NET.*metadata/i)
	})

	it("rejects a latest-sdk not present in the releases", async () => {
		mockIndex()
		mockReleases({ ...releases(), "latest-sdk": "10.0.402" })
		await expect(resolvers.dotnet()).rejects.toThrow(/No.*SDK.*10\.0\.402/i)
	})

	it.each(
		[[], [sdk().files[0]], [sdk().files[3]], [{ name: "dotnet-sdk-win-x64.zip", rid: "win-arm64" }]].map(
			(files) => [files],
		),
	)("rejects missing or wrong-architecture ZIP assets: %j", async (files) => {
		const document = releases()
		const selectedSdk = { ...sdk(), files }
		mockIndex()
		mockReleases({ ...document, releases: [{ sdk: selectedSdk, sdks: [selectedSdk] }] })
		await expect(resolvers.dotnet()).rejects.toThrow(/No.*ZIP.*win-x64/i)
	})

	it.each([null, {}, "not-files"])("rejects a malformed latest SDK files list: %j", async (files) => {
		mockIndex()
		mockReleases({ ...releases(), releases: [{ sdk: { version: "10.0.401", files } }] })
		await expect(resolvers.dotnet()).rejects.toThrow(/Invalid.*NET.*metadata/i)
	})

	it.each([
		"https://untrusted.example/dotnet-sdk-10.0.401-win-x64.zip",
		"https://evilbuilds.dotnet.microsoft.com.evil.example/dotnet-sdk-10.0.401-win-x64.zip",
		"http://builds.dotnet.microsoft.com/dotnet-sdk-10.0.401-win-x64.zip",
		"https://127.0.0.1/dotnet-sdk-10.0.401-win-x64.zip",
	])("rejects an SDK asset outside trusted HTTPS: %s", async (url) => {
		const document = releases()
		document.releases[0].sdk.files[1].url = url
		mockIndex()
		mockReleases(document)
		await expect(resolvers.dotnet()).rejects.toThrow(/trusted/i)
	})

	it.each([undefined, 42, `${origin}/dotnet/Sdk/10.0.301/dotnet-sdk-10.0.301-win-x64.zip`])(
		"rejects a missing or mismatched SDK ZIP URL: %s",
		async (url) => {
			const selectedSdk = { ...sdk(), files: [{ name: "dotnet-sdk-win-x64.zip", rid: "win-x64", url }] }
			mockIndex()
			mockReleases({ ...releases(), releases: [{ sdk: selectedSdk }] })
			await expect(resolvers.dotnet()).rejects.toThrow(/Invalid.*NET.*metadata/i)
		},
	)

	it("shows why the former script-only EXE result cannot pass the real consumer's detect probe", async () => {
		vi.spyOn(resolvers, "dotnet").mockResolvedValue({
			url: "https://dot.net/v1/dotnet-install.ps1",
			archive: "exe",
			version: "LTS",
		})
		nock("https://dot.net").get("/v1/dotnet-install.ps1").reply(200, "# installer script, not a .NET host")
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-dotnet-old-"))
		try {
			const provisioner = new EnvironmentProvisioner(createNodeProvisionerHost(root))
			await expect(provisioner.ensure("dotnet")).rejects.toThrow(/executable was not found/)
			expect(await fs.readFile(path.join(root, "dotnet", "dotnet-install.ps1"), "utf8")).toContain(
				"installer script",
			)
			expect(await provisioner.isInstalled("dotnet")).toBe(false)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("passes the resolved ZIP through real download, extraction, detection, reuse and removal", async () => {
		mockIndex()
		mockReleases()
		// A tiny ZIP with a synthetic marker, not a runnable SDK; real SDK evidence is separate.
		const payload = Buffer.from(
			"UEsDBBQAAAAAAKemQV1Vuzt0HQAAAB0AAAAKAAAAZG90bmV0LmV4ZU1aIHN5bnRoZXRpYyBTREsgaG9zdCBmaXh0dXJlUEsDBBQAAAAAAKemQV2QVrb1CAAAAAgAAAAVAAAAc2RrLzEwLjAuNDAxLy52ZXJzaW9uMTAuMC40MDFQSwECFAAUAAAAAACnpkFdVbs7dB0AAAAdAAAACgAAAAAAAAAAAAAAgAEAAAAAZG90bmV0LmV4ZVBLAQIUABQAAAAAAKemQV2QVrb1CAAAAAgAAAAVAAAAAAAAAAAAAACAAUUAAABzZGsvMTAuMC40MDEvLnZlcnNpb25QSwUGAAAAAAIAAgB7AAAAgAAAAAAA",
			"base64",
		)
		nock(origin).get("/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-win-x64.zip").reply(200, payload)
		// Let the unchanged resolver expose its original missing-executable failure during RED.
		nock("https://dot.net").get("/v1/dotnet-install.ps1").optionally().reply(200, "# old installer script")
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-dotnet-zip-"))
		try {
			const provisioner = new EnvironmentProvisioner(createNodeProvisionerHost(root))
			const phases: string[] = []
			expect(await provisioner.ensure("dotnet", (progress) => phases.push(progress.phase))).toMatchObject({
				installed: true,
				pathEntries: [path.join(root, "dotnet")],
			})
			expect(phases).toEqual(["resolving", "downloading", "extracting", "done"])
			expect(await fs.readFile(path.join(root, "dotnet", "dotnet.exe"), "utf8")).toBe(
				"MZ synthetic SDK host fixture",
			)
			expect(await fs.readFile(path.join(root, "dotnet", "sdk", "10.0.401", ".version"), "utf8")).toBe("10.0.401")
			expect(await provisioner.isInstalled("dotnet")).toBe(true)
			expect(await new EnvironmentProvisioner(createNodeProvisionerHost(root)).isInstalled("dotnet")).toBe(true)
			expect(await provisioner.ensure("dotnet")).toMatchObject({ installed: false })
			await provisioner.remove("dotnet")
			expect(await provisioner.isInstalled("dotnet")).toBe(false)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
