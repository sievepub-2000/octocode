import * as https from "https"

import { classifyExtension, looksLikeLanguageServer, type ExtensionManifest } from "../classify"
import { satisfiesEngine, searchExtensions, getExtension } from "../open-vsx"

/**
 * Measures, against the live registry, how much of the marketplace a host can
 * support without reimplementing the VS Code API.
 *
 * This exists because the tiering strategy rests on an empirical claim — "most
 * of the marketplace's value is declarative or protocol-based" — and an
 * architecture decision resting on an unmeasured claim is a guess. Gated behind
 * OCTOCODE_NET_TESTS so the normal suite stays offline.
 */
const enabled = process.env.OCTOCODE_NET_TESTS === "1"

function getJson<T>(url: string, redirectsLeft = 3): Promise<T> {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { "User-Agent": "OctoCode", Accept: "application/json" }, timeout: 25_000 }, (res) => {
				const status = res.statusCode ?? 0
				if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
					res.resume()
					return resolve(getJson<T>(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
				}
				if (status !== 200) {
					res.resume()
					return reject(new Error(`HTTP ${status}`))
				}
				let body = ""
				res.setEncoding("utf8")
				res.on("data", (c) => (body += c))
				res.on("end", () => {
					try {
						resolve(JSON.parse(body))
					} catch (e) {
						reject(e)
					}
				})
			})
			.on("error", reject)
	})
}

describe.skipIf(!enabled)("marketplace tier survey (network)", () => {
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

	it("classifies a broad sample of real extensions", async () => {
		// Sample across the categories a coding agent actually needs, rather than
		// one popularity list, so the result is not skewed by a single category.
		const queries = ["python", "rust", "typescript", "go", "java", "theme", "docker", "kubernetes", "vim", "git"]

		const seen = new Map<string, ExtensionManifest>()
		for (const q of queries) {
			const found = await searchExtensions(q, 12).catch(() => [])
			for (const ext of found) {
				if (seen.has(ext.id)) continue
				try {
					const detail = await getExtension(ext.namespace, ext.name)
					const manifestUrl = `https://open-vsx.org/api/${ext.namespace}/${ext.name}/${detail.version}/file/package.json`
					const manifest = await getJson<ExtensionManifest>(manifestUrl)
					seen.set(ext.id, manifest)
				} catch {
					// A single unavailable manifest must not sink the survey; it is
					// counted as unsampled rather than silently treated as supported.
				}
			}
		}

		const counts: Record<string, number> = { declarative: 0, protocol: 0, api: 0 }
		let lspShaped = 0
		let engineOk = 0
		const HOST_ENGINE = "1.96.0"

		for (const manifest of seen.values()) {
			const { tier } = classifyExtension(manifest)
			counts[tier]++
			if (looksLikeLanguageServer(manifest)) lspShaped++
			if (satisfiesEngine(manifest.engines?.vscode, HOST_ENGINE)) engineOk++
		}

		const total = seen.size
		const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`

		// Written to a file rather than console.log: the runner swallows stdout, and
		// a survey whose result cannot be read is a survey that did not happen.
		const report = [
			`marketplace tier survey (n=${total})`,
			`declarative (no API needed) : ${counts.declarative}  ${pct(counts.declarative)}`,
			`protocol    (LSP/DAP only)  : ${counts.protocol}  ${pct(counts.protocol)}`,
			`api         (needs shim)    : ${counts.api}  ${pct(counts.api)}`,
			`of which LSP-shaped         : ${lspShaped}  ${pct(lspShaped)}`,
			`engine-compatible @${HOST_ENGINE}   : ${engineOk}  ${pct(engineOk)}`,
			"",
			"per-extension:",
			...[...seen.entries()].map(([id, m]) => {
				const c = classifyExtension(m)
				return `  ${c.tier.padEnd(12)} ${id}`
			}),
		].join("\n")

		const out = process.env.OCTOCODE_SURVEY_OUT
		if (out) {
			const fs = await import("fs")
			fs.writeFileSync(out, report, "utf8")
		}

		// The survey must actually have sampled something; an empty result silently
		// "passing" would be worse than failing.
		expect(total).toBeGreaterThan(30)
	}, 600_000)
})
