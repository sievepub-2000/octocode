import * as https from "https"

/**
 * Turns an environment id into a concrete download.
 *
 * Vendors publish versions in their own way, so each resolver hits that vendor's
 * index/API rather than us pinning a version that rots. Every resolved URL is
 * re-checked against the trusted-domain list before anything is fetched, so a
 * compromised or redirected index cannot point us at an arbitrary host.
 */
export interface ResolvedDownload {
	url: string
	archive: "zip" | "tar.gz" | "tar.xz" | "exe"
	/**
	 * Number of leading path components to drop when extracting. Most vendor
	 * archives contain a single versioned root directory (`go/`, `jdk-21.0.1+12/`)
	 * that we do not want in the final layout.
	 */
	stripRoot?: boolean
	version: string
	/**
	 * For `archive: "exe"` bootstrappers: how to run the downloaded executable
	 * once it sits in the environment directory. Paths in `env` are relative to
	 * that directory. Without this the bootstrapper was only copied into place and
	 * the toolchain it installs never appeared.
	 */
	bootstrap?: { args: string[]; env?: Record<string, string>; timeoutMs?: number }
}

/** Hosts we are willing to download a toolchain from. */
export const TRUSTED_TOOLCHAIN_DOMAINS = [
	"nodejs.org",
	"go.dev",
	"golang.org",
	"dl.google.com",
	"api.adoptium.net",
	"github.com",
	// GitHub hands release downloads off to a signed-URL host. That host has
	// changed before (objects.* -> release-assets.*), so trust the parent domain:
	// isTrustedHttpsUrl matches subdomains, and this survives the next move.
	"githubusercontent.com",
	"static.rust-lang.org",
	"python.org",
	"astral.sh",
	"dot.net",
	"builds.dotnet.microsoft.com",
	"aka.ms",
	"cloud-images.ubuntu.com",
] as const

function httpsGetJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{ headers: { "User-Agent": "OctoCode", Accept: "application/json" }, timeout: timeoutMs },
			(response) => {
				// Vendor indexes redirect freely; follow within the trusted set only.
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
					const location = response.headers.location
					response.resume()
					if (!location) return reject(new Error(`Redirect without Location from ${url}`))
					return resolve(httpsGetJson<T>(new URL(location, url).toString(), timeoutMs))
				}
				if (response.statusCode !== 200) {
					response.resume()
					return reject(new Error(`${url} returned HTTP ${response.statusCode}`))
				}
				let body = ""
				response.setEncoding("utf8")
				response.on("data", (chunk) => (body += chunk))
				response.on("end", () => {
					try {
						resolve(JSON.parse(body))
					} catch (error) {
						reject(new Error(`${url} returned invalid JSON: ${(error as Error).message}`))
					}
				})
			},
		)
		request.on("timeout", () => {
			request.destroy(new Error(`${url} timed out`))
		})
		request.on("error", reject)
	})
}

const winArch = () => (process.arch === "arm64" ? "arm64" : "x64")

/**
 * Python series to provision, kept in step with octocode-core/toolchain.json.
 * Pinned to major.minor rather than an exact patch so security releases are
 * picked up without a code change.
 */
const PYTHON_SERIES = "3.14"

/** Latest non-prerelease asset from a GitHub repo matching `pattern`. */
async function githubRelease(repo: string, pattern: RegExp): Promise<{ url: string; version: string }> {
	const release = await httpsGetJson<{
		tag_name?: string
		assets?: Array<{ name: string; browser_download_url: string }>
	}>(`https://api.github.com/repos/${repo}/releases/latest`)
	const assets = release?.assets ?? []
	const asset = assets.find((a) => pattern.test(a.name))
	if (!asset) {
		throw new Error(`No asset matching ${pattern} in ${repo} ${release?.tag_name ?? "latest"}`)
	}
	return { url: asset.browser_download_url, version: String(release?.tag_name ?? "latest") }
}

export type Resolver = () => Promise<ResolvedDownload>

export const resolvers: Record<string, Resolver> = {
	async golang() {
		const index =
			await httpsGetJson<Array<{ version: string; files: Array<{ filename: string }> }>>(
				"https://go.dev/dl/?mode=json",
			)
		const stable = index?.[0]
		// Go names its archives with Go's own GOARCH ("amd64"), not the "x64"
		// spelling most other vendors use.
		const suffix = `windows-${process.arch === "arm64" ? "arm64" : "amd64"}.zip`
		const file = stable?.files?.find((f) => String(f.filename).endsWith(suffix))
		if (!file) throw new Error(`No Go archive for ${suffix}`)
		return {
			url: `https://go.dev/dl/${file.filename}`,
			archive: "zip",
			stripRoot: true,
			version: String(stable.version),
		}
	},

	async adoptium() {
		const releases = await httpsGetJson<{ most_recent_lts?: number }>(
			"https://api.adoptium.net/v3/info/available_releases",
		)
		const lts = releases?.most_recent_lts
		if (!lts) throw new Error("Adoptium did not report an LTS release")
		return {
			url: `https://api.adoptium.net/v3/binary/latest/${lts}/ga/windows/${winArch()}/jdk/hotspot/normal/eclipse`,
			archive: "zip",
			stripRoot: true,
			version: `jdk-${lts}`,
		}
	},

	async uv() {
		const { url, version } = await githubRelease(
			"astral-sh/uv",
			new RegExp(`uv-${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc\\.zip$`),
		)
		return { url, archive: "zip", version }
	},

	async powershell() {
		const { url, version } = await githubRelease("PowerShell/PowerShell", new RegExp(`win-${winArch()}\\.zip$`))
		return { url, archive: "zip", version }
	},

	async protobuf() {
		const { url, version } = await githubRelease(
			"protocolbuffers/protobuf",
			new RegExp(`protoc-.*-win${process.arch === "arm64" ? "64" : "64"}\\.zip$`),
		)
		return { url, archive: "zip", version }
	},

	async pandoc() {
		const { url, version } = await githubRelease("jgm/pandoc", /windows-x86_64\.zip$/)
		return { url, archive: "zip", stripRoot: true, version }
	},

	async ffmpeg() {
		const { url, version } = await githubRelease("GyanD/codexffmpeg", /-essentials_build\.zip$/)
		return { url, archive: "zip", stripRoot: true, version }
	},

	async nodejs() {
		const index = await httpsGetJson<Array<{ version: string; lts: string | false }>>(
			"https://nodejs.org/dist/index.json",
		)
		const lts = index?.find((r) => r.lts)
		if (!lts) throw new Error("nodejs.org did not report an LTS release")
		return {
			url: `https://nodejs.org/dist/${lts.version}/node-${lts.version}-win-${winArch()}.zip`,
			archive: "zip",
			stripRoot: true,
			version: String(lts.version),
		}
	},

	async rustup() {
		// rustup-init is a small bootstrapper that then fetches the toolchain itself;
		// this is the vendor-supported path and keeps us out of the business of
		// tracking individual component archives.
		return {
			url: `https://static.rust-lang.org/rustup/dist/${
				process.arch === "arm64" ? "aarch64" : "x86_64"
			}-pc-windows-msvc/rustup-init.exe`,
			archive: "exe",
			version: "stable",
			// Same homes the product exports to every terminal (bootstrap-node.ts), so the
			// cargo/rustc proxies find this toolchain rather than ~/.rustup.
			bootstrap: {
				args: ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", "stable"],
				env: { CARGO_HOME: "cargo", RUSTUP_HOME: "rustup" },
				timeoutMs: 30 * 60_000,
			},
		}
	},

	async android() {
		// Google does not publish a JSON index for command-line tools; the URL is
		// stable and versioned, so it is pinned here and updated deliberately.
		return {
			url: "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
			archive: "zip",
			version: "11076708",
		}
	},

	async dotnet() {
		return {
			url: "https://dot.net/v1/dotnet-install.ps1",
			archive: "exe",
			version: "LTS",
		}
	},

	async python() {
		// Interpreters come from python-build-standalone — the same self-contained
		// builds uv provisions internally, but fetched directly.
		//
		// This previously delegated to resolvers.uv(), which was wrong in a way that
		// could never work: uv is an *installer*, not an interpreter, so the archive
		// unpacked uv.exe while the manifest's detect marker looks for python.exe.
		// Provisioning therefore failed every time, taking the bundled
		// code-review-graph MCP server down with it.
		const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
		const series = PYTHON_SERIES.replace(".", "\\.")
		const { url } = await githubRelease(
			"astral-sh/python-build-standalone",
			// `install_only` is the redistributable layout (bin + stdlib + pip).
			// Excludes `_stripped` (no symbols) and `freethreaded` (no-GIL) builds,
			// which share the prefix and would otherwise match first.
			new RegExp(`^cpython-${series}\\.\\d+\\+\\d+-${arch}-pc-windows-msvc-install_only\\.tar\\.gz$`),
		)
		// Report the interpreter version rather than the release date tag, so a
		// mismatch against toolchain.json is visible in diagnostics.
		const version = url.match(/cpython-(\d+\.\d+\.\d+)/)?.[1] ?? PYTHON_SERIES
		return { url, archive: "tar.gz", stripRoot: true, version }
	},
}

export function getResolver(name: string): Resolver {
	const resolver = resolvers[name]
	if (!resolver) throw new Error(`No download resolver named "${name}"`)
	return resolver
}
