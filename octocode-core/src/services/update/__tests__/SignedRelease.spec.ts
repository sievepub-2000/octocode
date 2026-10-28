import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it } from "vitest"

import { verifyOfficialRelease } from "../SignedRelease"

const keys = generateKeyPairSync("ed25519")
const der = keys.publicKey.export({ format: "der", type: "spki" })
const trust = {
	publicKeySpkiBase64: der.toString("base64"),
	publicKeySha256: createHash("sha256").update(der).digest("hex"),
}
const manifest = {
	schemaVersion: 1,
	product: "OctoCode",
	repository: "sievepub-2000/octocode",
	version: "2.0.0",
	tag: "v2.0",
	assets: {
		"windows-x64-system": { name: "OctoCodeSetup.exe", sha256: "a".repeat(64), size: 42 },
		extension: {
			name: "octocode-0.1.11.vsix",
			version: "0.1.11",
			sha256: "b".repeat(64),
			size: 21,
			minShellVersion: "2.0.0",
		},
	},
}
const metadata = {
	tag_name: "v2.0",
	assets: [
		{
			name: "OctoCodeSetup.exe",
			url: "https://api.github.com/repos/sievepub-2000/octocode/releases/assets/1",
			size: 42,
			digest: "sha256:" + "a".repeat(64),
		},
		{
			name: "octocode-0.1.11.vsix",
			url: "https://api.github.com/repos/sievepub-2000/octocode/releases/assets/2",
			size: 21,
		},
	],
}
const signed = (value: unknown) => {
	const raw = Buffer.from(JSON.stringify(value))
	return { raw, signature: sign(null, raw, keys.privateKey) }
}

describe("official signed release", () => {
	it("verifies the exact bytes and binds both artifact names, sizes and API URLs", () => {
		const { raw, signature } = signed(manifest)
		expect(verifyOfficialRelease(raw, signature, metadata, trust)).toMatchObject({
			version: "2.0.0",
			extension: { version: "0.1.11", name: "octocode-0.1.11.vsix", size: 21 },
			desktop: { name: "OctoCodeSetup.exe", size: 42 },
		})
	})

	it("rejects tampered bytes, another signer and a mismatched pinned key fingerprint before JSON use", () => {
		const { raw, signature } = signed(manifest)
		expect(() =>
			verifyOfficialRelease(Buffer.from(raw.toString().replace("2.0.0", "2.0.1")), signature, metadata, trust),
		).toThrow(/signature/)
		const other = generateKeyPairSync("ed25519")
		expect(() => verifyOfficialRelease(raw, sign(null, raw, other.privateKey), metadata, trust)).toThrow(
			/signature/,
		)
		expect(() =>
			verifyOfficialRelease(raw, signature, metadata, { ...trust, publicKeySha256: "0".repeat(64) }),
		).toThrow(/fingerprint/)
		const invalidJson = Buffer.from("not JSON")
		expect(() => verifyOfficialRelease(invalidJson, signature, metadata, trust)).toThrow(/signature/)
	})

	it("rejects wrong product/repository/tag/version and oversized or non-raw signatures", () => {
		for (const value of [
			{ ...manifest, product: "Other" },
			{ ...manifest, repository: "other/repository" },
			{ ...manifest, tag: "v2.1" },
			{ ...manifest, version: "2.1.0" },
			{ ...manifest, schemaVersion: 2 },
		]) {
			const { raw, signature } = signed(value)
			expect(() => verifyOfficialRelease(raw, signature, metadata, trust)).toThrow()
		}
		const { raw, signature } = signed(manifest)
		expect(() => verifyOfficialRelease(Buffer.alloc(1_048_577), signature, metadata, trust)).toThrow(/size/)
		expect(() => verifyOfficialRelease(raw, Buffer.from(signature.toString("base64")), metadata, trust)).toThrow(
			/64/,
		)
	})

	it("rejects duplicate/missing assets, size or digest mismatch, and URLs outside the exact API repository", () => {
		const { raw, signature } = signed(manifest)
		for (const assets of [
			[metadata.assets[0]],
			[...metadata.assets, metadata.assets[0]],
			[{ ...metadata.assets[0], size: 43 }, metadata.assets[1]],
			[{ ...metadata.assets[0], digest: "sha256:" + "c".repeat(64) }, metadata.assets[1]],
			[{ ...metadata.assets[0], url: "https://example.invalid/installer.exe" }, metadata.assets[1]],
			[
				{ ...metadata.assets[0], url: "https://api.github.com/repos/other/repo/releases/assets/1" },
				metadata.assets[1],
			],
		])
			expect(() => verifyOfficialRelease(raw, signature, { ...metadata, assets }, trust)).toThrow()
	})
})
