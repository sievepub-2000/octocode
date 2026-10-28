/**
 * Bundled development environments and when they are actually needed.
 *
 * Historically every toolchain shipped inside the installer, which made the
 * download ~12 GB even for a user who only ever writes TypeScript. Only a small
 * core is genuinely required to boot; everything else is provisioned the first
 * time a command actually needs it.
 *
 * The manifest is data, not code: `detect` decides "is it already here?",
 * `triggers` decides "does this command need it?", and `source` says where to
 * get it. Adding a toolchain is one entry.
 */

export type EnvironmentTier =
	/** Shipped in the installer. Required before the workbench can run at all. */
	| "core"
	/** Provisioned on demand, silently, the first time the agent's own tooling needs it. */
	| "agent"
	/** Provisioned on demand when a user/agent command requires that language toolchain. */
	| "toolchain"

export type EnvironmentSource =
	/** Resolve the download URL at install time from a vendor API/index. */
	| { kind: "resolver"; resolver: string }
	/** A pinned archive. `sha256` is required — never install an unverified archive. */
	| { kind: "archive"; url: string; sha256: string; archive: "zip" | "tar.gz" | "tar.xz"; version?: string }
	/** Provisioned by an OS-level command rather than an archive (e.g. WSL distributions). */
	| { kind: "system"; command: string }

export interface EnvironmentDescriptor {
	/** Directory name under `environments/`, and the id used by the provisioning tool. */
	id: string
	/** Shown to the user while installing. */
	label: string
	tier: EnvironmentTier
	/**
	 * Approximate installed size in MB. Used only for user-facing messaging
	 * ("this will download about 2 GB") — never for control flow.
	 */
	approxSizeMb: number
	/**
	 * Path, relative to the environment directory, whose existence means
	 * "already installed". Chosen to be an actual executable rather than the
	 * directory itself, so a half-extracted install is not mistaken for a good one.
	 */
	detect: { win32: string; posix: string }
	/**
	 * Whether the payload is included in the installer.
	 *
	 * Deliberately independent of `tier`. Anything with `shipped: false` is
	 * excluded from the installer and fetched from its vendor at first use.
	 */
	shipped: boolean
	/** PATH entries contributed once installed, relative to the environment directory. */
	pathEntries?: { win32: string[]; posix: string[] }
	/**
	 * Leading command words that require this environment. Matched against the
	 * first token of a command line, case-insensitively.
	 */
	triggers?: readonly string[]
	source: EnvironmentSource
	/**
	 * Python distributions installed into the environment after it is unpacked,
	 * using its own interpreter.
	 *
	 * The interpreter a resolver fetches is a plain redistributable: stdlib and
	 * pip, nothing else. Anything the product itself needs from it has to be named
	 * here, or the environment reports "installed" while the thing that wanted it
	 * still fails — which is how the bundled code-review-graph MCP server came to
	 * report `spawn …/python.exe ENOENT` on a fresh machine and, once the
	 * interpreter existed, would have gone on to fail with "No module named".
	 */
	packages?: readonly string[]
	/** Why a user might see this being installed; surfaced in the narration. */
	purpose: string
}

export const environmentManifest: readonly EnvironmentDescriptor[] = [
	// ------------------------------------------------------------------ core
	{
		id: "node",
		label: "Node.js",
		tier: "core",
		approxSizeMb: 150,
		shipped: true,
		detect: { win32: "node.exe", posix: "bin/node" },
		pathEntries: { win32: ["."], posix: ["bin"] },
		triggers: ["node", "npm", "npx", "pnpm", "pnpx"],
		source: { kind: "resolver", resolver: "nodejs" },
		purpose: "Runs the extension host, the agent harness, and Node-based tooling.",
	},
	{
		id: "scripts",
		label: "Product scripts",
		tier: "core",
		approxSizeMb: 1,
		shipped: true,
		detect: { win32: "initialize.ps1", posix: "initialize.ps1" },
		pathEntries: { win32: ["."], posix: ["."] },
		source: { kind: "archive", url: "", sha256: "", archive: "zip" },
		purpose: "Installer and environment bootstrap scripts.",
	},

	// ----------------------------------------------------------------- agent
	{
		id: "powershell",
		label: "PowerShell 7",
		tier: "agent",
		approxSizeMb: 245,
		shipped: false,
		detect: { win32: "pwsh.exe", posix: "pwsh" },
		pathEntries: { win32: ["."], posix: ["."] },
		triggers: ["pwsh"],
		source: { kind: "resolver", resolver: "powershell" },
		purpose: "Cross-platform shell used for Windows automation.",
	},
	{
		id: "python",
		label: "Python",
		tier: "agent",
		approxSizeMb: 560,
		shipped: true,
		detect: { win32: "python.exe", posix: "bin/python3" },
		pathEntries: { win32: [".", "Scripts"], posix: ["bin"] },
		triggers: ["python", "python3", "pip", "pip3"],
		source: { kind: "resolver", resolver: "python" },
		packages: ["code-review-graph==2.3.8+octocode.1"],
		purpose: "Hosts the code-review-graph MCP server and Python tooling.",
	},
	{
		id: "uv",
		label: "uv (Python package manager)",
		tier: "agent",
		approxSizeMb: 50,
		shipped: false,
		detect: { win32: "uv.exe", posix: "uv" },
		pathEntries: { win32: ["."], posix: ["."] },
		triggers: ["uv", "uvx"],
		source: { kind: "resolver", resolver: "uv" },
		purpose: "Fast Python dependency resolution for MCP servers.",
	},

	// ------------------------------------------------------------- toolchain
	{
		id: "rust",
		label: "Rust toolchain",
		tier: "toolchain",
		approxSizeMb: 2100,
		shipped: false,
		detect: { win32: "cargo/bin/cargo.exe", posix: "cargo/bin/cargo" },
		pathEntries: { win32: ["cargo/bin"], posix: ["cargo/bin"] },
		triggers: ["cargo", "rustc", "rustup", "rustfmt", "clippy-driver"],
		source: { kind: "resolver", resolver: "rustup" },
		purpose: "Building and testing Rust projects.",
	},
	{
		id: "jdk",
		label: "Java (Temurin JDK)",
		tier: "toolchain",
		approxSizeMb: 289,
		shipped: false,
		detect: { win32: "bin/java.exe", posix: "bin/java" },
		pathEntries: { win32: ["bin"], posix: ["bin"] },
		triggers: ["java", "javac", "jar", "mvn", "gradle"],
		source: { kind: "resolver", resolver: "adoptium" },
		purpose: "Building and running Java projects.",
	},
	{
		id: "go",
		label: "Go toolchain",
		tier: "toolchain",
		approxSizeMb: 236,
		shipped: false,
		detect: { win32: "bin/go.exe", posix: "bin/go" },
		pathEntries: { win32: ["bin"], posix: ["bin"] },
		triggers: ["go", "gofmt"],
		source: { kind: "resolver", resolver: "golang" },
		purpose: "Building and testing Go projects.",
	},
	{
		id: "dotnet",
		label: ".NET SDK",
		tier: "toolchain",
		approxSizeMb: 770,
		shipped: false,
		detect: { win32: "dotnet.exe", posix: "dotnet" },
		pathEntries: { win32: ["."], posix: ["."] },
		triggers: ["dotnet", "msbuild"],
		source: { kind: "resolver", resolver: "dotnet" },
		purpose: "Building and running .NET projects.",
	},
	{
		id: "ffmpeg",
		label: "FFmpeg",
		tier: "toolchain",
		approxSizeMb: 191,
		shipped: false,
		detect: { win32: "bin/ffmpeg.exe", posix: "bin/ffmpeg" },
		pathEntries: { win32: ["bin"], posix: ["bin"] },
		triggers: ["ffmpeg", "ffprobe"],
		source: { kind: "resolver", resolver: "ffmpeg" },
		purpose: "Audio and video processing.",
	},
	{
		id: "pandoc",
		label: "Pandoc",
		tier: "toolchain",
		approxSizeMb: 223,
		shipped: false,
		detect: { win32: "pandoc.exe", posix: "bin/pandoc" },
		pathEntries: { win32: ["."], posix: ["bin"] },
		triggers: ["pandoc"],
		source: { kind: "resolver", resolver: "pandoc" },
		purpose: "Document format conversion.",
	},
	{
		id: "protobuf",
		label: "Protocol Buffers",
		tier: "toolchain",
		approxSizeMb: 13,
		shipped: process.platform === "win32",
		detect: { win32: "bin/protoc.exe", posix: "bin/protoc" },
		pathEntries: { win32: ["bin"], posix: ["bin"] },
		triggers: ["protoc"],
		source:
			process.platform === "win32"
				? {
						kind: "archive",
						version: "36.2",
						url: "https://github.com/protocolbuffers/protobuf/releases/download/v36.2/protoc-36.2-win64.zip",
						sha256: "f0c128dc0d8492eceece83bb459a4c0e316764b929ffbf1aa416357fd644edd3",
						archive: "zip",
					}
				: { kind: "resolver", resolver: "protobuf" },
		purpose: "Compiling .proto definitions.",
	},
	{
		id: "android",
		label: "Android SDK command-line tools",
		tier: "toolchain",
		approxSizeMb: 668,
		shipped: false,
		detect: { win32: "cmdline-tools/latest/bin/sdkmanager.bat", posix: "cmdline-tools/latest/bin/sdkmanager" },
		pathEntries: {
			win32: ["platform-tools", "cmdline-tools/latest/bin"],
			posix: ["platform-tools", "cmdline-tools/latest/bin"],
		},
		triggers: ["adb", "sdkmanager", "avdmanager", "gradlew"],
		source: { kind: "resolver", resolver: "android" },
		purpose: "Building and deploying Android projects.",
	},
	{
		id: "wsl",
		label: "Linux environment (WSL2)",
		tier: "toolchain",
		// The official Ubuntu 24.04 WSL rootfs, downloaded and registered the first
		// time a Linux command runs (it used to ship as a 5.3 GB image).
		approxSizeMb: 400,
		shipped: false,
		// The registration lives in the Windows registry, not on disk, so presence
		// is confirmed by the provisioner querying `wsl -l -q` rather than by a file.
		detect: { win32: "", posix: "" },
		triggers: ["gcc", "g++", "make", "swift", "swiftc", "docker", "apt", "apt-get"],
		source: { kind: "system", command: "wsl-import" },
		purpose: "Runs GCC/Clang, Swift and Docker workloads that require Linux.",
	},
]

const byId = new Map(environmentManifest.map((e) => [e.id, e]))

export function getEnvironment(id: string): EnvironmentDescriptor | undefined {
	return byId.get(id)
}

/** Environments shipped inside the installer. */
export function getCoreEnvironmentIds(): string[] {
	return environmentManifest.filter((e) => e.tier === "core").map((e) => e.id)
}

/** Everything that is provisioned after installation rather than shipped. */
export function getOnDemandEnvironmentIds(): string[] {
	return environmentManifest.filter((e) => e.tier !== "core").map((e) => e.id)
}

/**
 * Environment directories the installer must NOT package.
 *
 * The build script excludes exactly these from the payload copy. A drift test
 * asserts the two lists agree, because a mismatch is silent in both directions:
 * shipping something unnecessarily just bloats the download, while excluding
 * something with no resolver would leave a permanently broken toolchain.
 */
export function getExcludedFromInstallerIds(): string[] {
	return environmentManifest
		.filter((e) => !e.shipped)
		.map((e) => e.id)
		.sort()
}

/**
 * Which environment, if any, a command line requires.
 *
 * Matches only the FIRST token so that a command merely *mentioning* a tool
 * ("echo install rust") does not drag in a 2 GB download.
 */
export function findEnvironmentForCommand(command: string): EnvironmentDescriptor | undefined {
	const first = command
		.trim()
		.replace(/^["']/, "")
		.split(/[\s;|&]/, 1)[0]
		?.toLowerCase()

	if (!first) return undefined

	// Strip a path prefix and any executable extension: "./gradlew", "C:\...\cargo.exe".
	const base = first
		.replace(/\\/g, "/")
		.split("/")
		.pop()!
		.replace(/\.(exe|cmd|bat|ps1)$/i, "")

	return environmentManifest.find((e) => e.triggers?.includes(base))
}

/**
 * The environment an already-resolved routing target requires.
 *
 * `findEnvironmentForCommand` matches the command's leading token, which is the
 * right question for toolchains that run in the plain terminal (cargo, go, java).
 * It is the wrong question for routed targets: the router sends `Get-Process` to
 * pwsh by matching PowerShell's verb-prefix grammar, and `./gradlew` to the
 * Android SDK, neither of which appears in any trigger list. Deriving the need
 * from the route instead keeps one source of truth for "what does this command
 * actually run inside".
 *
 * Takes a plain string rather than the router's EnvironmentTarget type so the
 * manifest stays free of a dependency on the terminal integration.
 */
export function environmentForRouteTarget(target: string): EnvironmentDescriptor | undefined {
	if (target === "pwsh") return getEnvironment("powershell")
	if (target === "android") return getEnvironment("android")
	if (target.startsWith("wsl:")) return getEnvironment("wsl")
	// vscode-terminal runs in the ambient shell; msvc uses an externally installed
	// Visual Studio; macos-remote and docker: execute on another host entirely.
	return undefined
}
