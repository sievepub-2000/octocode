export type EnvironmentTarget =
	| "vscode-terminal"
	| "pwsh"
	| "msvc"
	| "android"
	| "macos-remote"
	| `wsl:${string}`
	| `docker:${string}`

export interface EnvironmentRouteConfig {
	defaultTarget?: "auto" | "vscode-terminal" | "pwsh" | "wsl" | "msvc" | "docker" | "android" | "macos-remote"
	wslDistribution?: string
	dockerContext?: string
	msvcDevCmd?: string
	macosRemoteHost?: string
}

const firstCommand = (command: string) => command.trimStart().toLowerCase()
const DEFAULT_WSL_DISTRIBUTION = "OctoCode"

export function selectEnvironment(command: string, config: EnvironmentRouteConfig): EnvironmentTarget {
	const configured = config.defaultTarget ?? "auto"
	if (configured !== "auto") return configuredTarget(configured, config)

	const value = firstCommand(command)
	if (/^(?:get-|set-|new-|remove-|write-|select-|where-|invoke-|start-|stop-)|\.ps1(?:\s|$)/i.test(value))
		return "pwsh"
	if (/^(?:swift|swiftc)(?:\s|$)/.test(value))
		return `wsl:${config.wslDistribution?.trim() || DEFAULT_WSL_DISTRIBUTION}`
	if (/^(?:xcodebuild|xcrun|simctl|pod)(?:\s|$)/.test(value)) return "macos-remote"
	if (/^(?:\.\/?gradlew|gradle|android|adb|sdkmanager|avdmanager)(?:\s|$)/.test(value)) return "android"
	if (/^(?:msbuild|cl)(?:\.exe)?(?:\s|$)/.test(value) || /\.(?:sln|vcxproj)(?:\s|$)/.test(value)) return "msvc"
	if (/^(?:docker|gcc|g\+\+|make|apt|apt-get)(?:\s|$)/.test(value))
		return `wsl:${config.wslDistribution?.trim() || DEFAULT_WSL_DISTRIBUTION}`
	return "vscode-terminal"
}

function configuredTarget(
	target: Exclude<EnvironmentRouteConfig["defaultTarget"], undefined | "auto">,
	config: EnvironmentRouteConfig,
): EnvironmentTarget {
	if (target === "wsl") return `wsl:${config.wslDistribution?.trim() || DEFAULT_WSL_DISTRIBUTION}`
	if (target === "docker") return `docker:${config.dockerContext?.trim() || "default"}`
	return target
}

export function resolveEnvironmentCommand(
	command: string,
	target: EnvironmentTarget,
	config: EnvironmentRouteConfig,
): string {
	switch (target) {
		case "vscode-terminal":
		case "android":
			return command
		case "pwsh":
			return `pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`
		case "msvc": {
			const devCmd = config.msvcDevCmd?.trim()
			if (!devCmd) throw new Error("MSVC developer command path is not configured")
			return `cmd.exe /d /s /c ""${devCmd.replaceAll('"', '""')}" -no_logo && ${command}"`
		}
		case "macos-remote": {
			const host = config.macosRemoteHost?.trim()
			if (!host || !/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d+)?$/.test(host))
				throw new Error("A valid remote macOS SSH host is not configured")
			return `ssh -- ${host} ${quotePosix(command)}`
		}
		default:
			if (target.startsWith("wsl:")) {
				const distribution = target.slice(4)
				const selector = distribution === "default" ? "" : ` -d ${quoteWindowsArgument(distribution)}`
				return `wsl.exe${selector} -- bash -lc ${quoteWindowsArgument(quotePosix(command))}`
			}
			if (target.startsWith("docker:")) {
				const context = target.slice(7)
				const match = command.match(/^\s*docker(?:\.exe)?\s+(.*)$/is)
				if (!match) throw new Error("The Docker environment route requires a docker command")
				return `docker.exe --context ${quoteWindowsArgument(context)} ${match[1]}`
			}
			return command
	}
}

const quotePosix = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
const quoteWindowsArgument = (value: string): string => `"${value.replaceAll('"', '\\"')}"`
