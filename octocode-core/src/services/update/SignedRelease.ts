import { createHash, createPublicKey, verify } from "node:crypto"

export const OFFICIAL_RELEASE_URL = "https://api.github.com/repos/sievepub-2000/octocode/releases/latest"
export const OFFICIAL_ASSET_URL =
	/^https:\/\/api\.github\.com\/repos\/sievepub-2000\/octocode\/releases\/assets\/[1-9]\d*$/
export const MAX_RELEASE_BYTES = 1_048_576

export interface ReleaseTrust {
	publicKeySpkiBase64: string
	publicKeySha256: string
}

export interface ReleaseAsset {
	readonly name: string
	readonly url: string
	readonly sha256: string
	readonly size: number
	readonly version: string
	readonly minShellVersion?: string
}

export interface OfficialRelease {
	readonly version: string
	readonly tag: string
	readonly desktop: ReleaseAsset
	readonly extension: ReleaseAsset
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid signed release object")
	return value as Record<string, unknown>
}

export function normalizeDesktopVersion(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid desktop release version")
	const match =
		/^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(-[\da-zA-Z]+(?:[.-][\da-zA-Z]+)*)?(?:\+[\da-zA-Z.-]+)?$/.exec(
			value,
		)
	if (!match) throw new Error("Invalid desktop release version")
	return `${match[1]}.${match[2]}.${match[3] ?? "0"}${match[4] ?? ""}`
}

/** Find one exact API asset. Credentials must never be sent to names/URLs supplied by a manifest. */
export function findOfficialAsset(
	metadata: unknown,
	name: string,
): Record<string, unknown> & { url: string; size: number } {
	const release = object(metadata)
	if (!Array.isArray(release.assets)) throw new Error("Official release has no assets")
	const matches = release.assets.map(object).filter((asset) => asset.name === name)
	if (matches.length !== 1) throw new Error(`Official release requires one unique asset: ${name}`)
	const asset = matches[0]
	if (typeof asset.url !== "string" || !OFFICIAL_ASSET_URL.test(asset.url))
		throw new Error("Invalid official API asset URL")
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0)
		throw new Error("Invalid official asset size")
	return { ...asset, url: asset.url, size: asset.size }
}

export function checkApiDigest(metadata: Record<string, unknown>, sha256: string): void {
	if (metadata.digest !== undefined && metadata.digest !== null && metadata.digest !== `sha256:${sha256}`)
		throw new Error("Official API asset digest does not match the signed release")
}

/** Verify raw UTF-8 bytes before parsing or trusting any JSON/hash fields. */
export function verifyOfficialRelease(
	raw: Uint8Array,
	signature: Uint8Array,
	metadata: unknown,
	trust: ReleaseTrust,
): OfficialRelease {
	if (raw.byteLength === 0 || raw.byteLength > MAX_RELEASE_BYTES) throw new Error("Invalid signed manifest size")
	if (signature.byteLength !== 64) throw new Error("Release signature must contain exactly 64 raw bytes")
	const der = Buffer.from(trust.publicKeySpkiBase64, "base64")
	if (createHash("sha256").update(der).digest("hex") !== trust.publicKeySha256)
		throw new Error("Release public key fingerprint mismatch")
	const key = createPublicKey({ key: der, format: "der", type: "spki" })
	if (key.asymmetricKeyType !== "ed25519" || !verify(null, raw, key, signature))
		throw new Error("Invalid official release signature")
	const manifest = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)))
	if (
		manifest.schemaVersion !== 1 ||
		manifest.product !== "OctoCode" ||
		manifest.repository !== "sievepub-2000/octocode"
	)
		throw new Error("Signed release schema, product or repository mismatch")
	const version = normalizeDesktopVersion(manifest.version)
	if (
		manifest.version !== version ||
		normalizeDesktopVersion(manifest.tag) !== version ||
		object(metadata).tag_name !== manifest.tag
	)
		throw new Error("Signed release tag/version mismatch")
	const assets = object(manifest.assets)
	const artifact = (value: unknown, extension: boolean): ReleaseAsset => {
		const item = object(value)
		const assetVersion = extension ? normalizeDesktopVersion(item.version) : version
		if (extension && assetVersion !== item.version) throw new Error("Invalid signed extension version")
		const expectedName = extension ? `octocode-${assetVersion}.vsix` : "OctoCodeSetup.exe"
		if (item.name !== expectedName || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))
			throw new Error("Invalid signed asset name or SHA-256")
		const api = findOfficialAsset(metadata, expectedName)
		if (item.size !== api.size) throw new Error("Official API asset size does not match the signed release")
		checkApiDigest(api, item.sha256)
		const minShellVersion =
			item.minShellVersion === undefined ? undefined : normalizeDesktopVersion(item.minShellVersion)
		return Object.freeze({
			name: expectedName,
			url: api.url,
			sha256: item.sha256,
			size: api.size,
			version: assetVersion,
			minShellVersion,
		})
	}
	return Object.freeze({
		version,
		tag: String(manifest.tag),
		desktop: artifact(assets["windows-x64-system"], false),
		extension: artifact(assets.extension, true),
	})
}
