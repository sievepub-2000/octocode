import { describe, expect, it } from "vitest"

import { environmentManifest } from "../manifest"
import { expectedSha256, UBUNTU_WSL_RELEASE, UBUNTU_WSL_ROOTFS } from "../node-host"
import { TRUSTED_TOOLCHAIN_DOMAINS } from "../resolvers"
import { isTrustedHttpsUrl } from "../../managed-binary/download"

const sums = [
	"2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934  ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz",
	"8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea  ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz",
	"fecec1d9b7b750c12c109edb49c13c1006f4a2efabb9b8bf341f11c4c9f2ef11 *ubuntu-noble-wsl-arm64-wsl.rootfs.tar.gz",
].join("\r\n")

describe("on-demand WSL image", () => {
	it("reads the digest for exactly the requested file", () => {
		expect(expectedSha256(sums, UBUNTU_WSL_ROOTFS)).toBe(
			"8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea",
		)
		expect(expectedSha256(sums, "ubuntu-noble-wsl-arm64-wsl.rootfs.tar.gz")).toMatch(/^fecec1d9/)
		expect(expectedSha256(sums, "missing.tar.gz")).toBeUndefined()
		expect(expectedSha256("not-a-digest  " + UBUNTU_WSL_ROOTFS, UBUNTU_WSL_ROOTFS)).toBeUndefined()
	})

	it("downloads from a trusted host and is no longer shipped in the installer", () => {
		expect(isTrustedHttpsUrl(`${UBUNTU_WSL_RELEASE}${UBUNTU_WSL_ROOTFS}`, TRUSTED_TOOLCHAIN_DOMAINS)).toBe(true)
		expect(environmentManifest.find((e) => e.id === "wsl")?.shipped).toBe(false)
	})
})
