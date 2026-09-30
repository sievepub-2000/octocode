import * as https from "https"

/**
 * Open VSX gallery client.
 *
 * Open VSX is used rather than the Microsoft marketplace deliberately: the
 * Microsoft gallery's terms permit access only from Visual Studio Code and its
 * official successors, so a third-party host must not query it. Open VSX is the
 * vendor-neutral registry built for exactly this case.
 */

export const OPEN_VSX_API = "https://open-vsx.org/api"

/** Hosts the gallery is allowed to serve extension payloads from. */
export const OPEN_VSX_TRUSTED_DOMAINS = ["open-vsx.org", "openvsx.eclipsecontent.org"] as const

export interface GalleryExtension {
	namespace: string
	name: string
	version: string
	displayName?: string
	description?: string
	downloadCount?: number
	averageRating?: number
	categories?: string[]
	/** Fully-qualified id as used everywhere else: `publisher.name`. */
	id: string
}

export interface GalleryExtensionDetail extends GalleryExtension {
	/** Direct .vsix download URL. */
	downloadUrl?: string
	/** VS Code engine range the extension declares, e.g. "^1.95.0". */
	engine?: string
	dependencies: string[]
}

/** Shape of the fields this client reads out of an Open VSX response. */
interface RawGalleryEntry {
	namespace?: string
	name?: string
	version?: string
	displayName?: string
	description?: string
	downloadCount?: number
	averageRating?: number
	categories?: string[]
	files?: { download?: string }
	engines?: { vscode?: string }
	dependencies?: Array<string | { namespace: string; name: string }>
	bundledExtensions?: Array<string | { namespace: string; name: string }>
}

function getJson<T>(url: string, timeoutMs = 20_000, redirectsLeft = 3): Promise<T> {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{ headers: { "User-Agent": "OctoCode", Accept: "application/json" }, timeout: timeoutMs },
			(response) => {
				const status = response.statusCode ?? 0
				if (status >= 300 && status < 400 && response.headers.location) {
					response.resume()
					if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`))
					return resolve(
						getJson<T>(new URL(response.headers.location, url).toString(), timeoutMs, redirectsLeft - 1),
					)
				}
				if (status !== 200) {
					response.resume()
					return reject(new Error(`Open VSX returned HTTP ${status} for ${url}`))
				}
				let body = ""
				response.setEncoding("utf8")
				response.on("data", (c) => (body += c))
				response.on("end", () => {
					try {
						resolve(JSON.parse(body))
					} catch (error) {
						reject(new Error(`Open VSX returned invalid JSON: ${(error as Error).message}`))
					}
				})
			},
		)
		request.on("timeout", () => request.destroy(new Error(`Open VSX request timed out: ${url}`)))
		request.on("error", reject)
	})
}

export function toGalleryExtension(raw: RawGalleryEntry): GalleryExtension {
	return {
		namespace: raw.namespace ?? "",
		name: raw.name ?? "",
		version: raw.version ?? "",
		displayName: raw.displayName,
		description: raw.description,
		downloadCount: raw.downloadCount,
		averageRating: raw.averageRating,
		categories: raw.categories,
		id: `${raw.namespace ?? ""}.${raw.name ?? ""}`,
	}
}

export async function searchExtensions(query: string, size = 20): Promise<GalleryExtension[]> {
	const url = `${OPEN_VSX_API}/-/search?query=${encodeURIComponent(query)}&size=${size}`
	const result = await getJson<{ extensions?: RawGalleryEntry[] }>(url)
	return (result?.extensions ?? []).map(toGalleryExtension)
}

export async function getExtension(publisher: string, name: string, version = "latest"): Promise<GalleryExtensionDetail> {
	const raw = await getJson<RawGalleryEntry>(
		`${OPEN_VSX_API}/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/${version}`,
	)
	return {
		...toGalleryExtension(raw),
		downloadUrl: raw?.files?.download,
		engine: raw?.engines?.vscode,
		dependencies: [...(raw?.dependencies ?? []), ...(raw?.bundledExtensions ?? [])].map((d) =>
			typeof d === "string" ? d : `${d.namespace}.${d.name}`,
		),
	}
}

/**
 * Whether the host can honour an extension's declared VS Code engine range.
 *
 * We only support caret/greater-or-equal style minimums, which is what
 * essentially every extension publishes. Anything we cannot parse is reported
 * as unsupported rather than assumed compatible — an extension that loads and
 * then fails on a missing API is worse than one that declines to install.
 */
export function satisfiesEngine(engineRange: string | undefined, hostVersion: string): boolean {
	if (!engineRange || engineRange === "*") return true

	const match = engineRange.match(/^\s*(?:\^|>=)?\s*(\d+)\.(\d+)(?:\.(\d+))?/)
	if (!match) return false

	const required: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
	const hostMatch = hostVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
	if (!hostMatch) return false
	const host: [number, number, number] = [Number(hostMatch[1]), Number(hostMatch[2]), Number(hostMatch[3] ?? 0)]

	for (let i = 0; i < 3; i++) {
		if (host[i] > required[i]) return true
		if (host[i] < required[i]) return false
	}
	return true
}
