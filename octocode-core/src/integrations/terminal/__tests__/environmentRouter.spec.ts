import { resolveEnvironmentCommand, selectEnvironment } from "../environmentRouter"

describe("environmentRouter", () => {
	it.each([
		["Get-ChildItem | Select-Object Name", "pwsh"],
		["docker build -t demo .", "wsl:Ubuntu"],
		["gcc main.c -o main", "wsl:Ubuntu"],
		["msbuild demo.sln", "msvc"],
		["./gradlew assembleDebug", "android"],
		["android sdk list '*'", "android"],
		["xcodebuild -scheme App", "macos-remote"],
		["node app.js", "vscode-terminal"],
	])("routes %s to %s", (command, expected) => {
		expect(selectEnvironment(command, { defaultTarget: "auto", wslDistribution: "Ubuntu" })).toBe(expected)
	})

	it("routes Swift through the bundled WSL toolchain and Apple-only commands to macOS", () => {
		expect(selectEnvironment("swift build", {})).toBe("wsl:OctoCode")
		expect(selectEnvironment("swiftc Main.swift", {})).toBe("wsl:OctoCode")
		expect(selectEnvironment("xcodebuild -scheme App", {})).toBe("macos-remote")
		expect(selectEnvironment("cargo test", {})).toBe("vscode-terminal")
		expect(selectEnvironment("python app.py", {})).toBe("vscode-terminal")
		expect(selectEnvironment("pnpm exec tsc --noEmit", {})).toBe("vscode-terminal")
	})

	it("uses the bundled OctoCode distribution when no WSL name is configured", () => {
		expect(selectEnvironment("gcc main.c", {})).toBe("wsl:OctoCode")
	})

	it("honours an explicit route", () => {
		expect(selectEnvironment("node app.js", { defaultTarget: "pwsh" })).toBe("pwsh")
	})

	it("encodes PowerShell commands without shell interpolation", () => {
		const routed = resolveEnvironmentCommand("Write-Output '$HOME'", "pwsh", {})
		expect(routed).toMatch(/^pwsh(?:\.exe)? -NoLogo -NoProfile -NonInteractive -EncodedCommand /)
		expect(Buffer.from(routed.split(" ").at(-1)!, "base64").toString("utf16le")).toBe("Write-Output '$HOME'")
	})

	it("requires a configured WSL distribution for an explicit named route", () => {
		expect(resolveEnvironmentCommand("gcc main.c", "wsl:Ubuntu", {})).toContain('wsl.exe -d "Ubuntu"')
	})

	it("requires an MSVC developer command script", () => {
		expect(() => resolveEnvironmentCommand("cl main.c", "msvc", {})).toThrow(/MSVC/)
	})

	it("rejects an unconfigured or unsafe macOS host", () => {
		expect(() => resolveEnvironmentCommand("xcodebuild", "macos-remote", {})).toThrow(/macOS/)
		expect(() =>
			resolveEnvironmentCommand("xcodebuild", "macos-remote", { macosRemoteHost: "mac; Remove-Item C:/" }),
		).toThrow(/macOS/)
	})

	it("routes remote iOS commands through SSH without interpolating the command locally", () => {
		expect(
			resolveEnvironmentCommand("xcodebuild -scheme 'Demo App'", "macos-remote", {
				macosRemoteHost: "builder@192.168.10.9",
			}),
		).toBe("ssh -- builder@192.168.10.9 'xcodebuild -scheme '\"'\"'Demo App'\"'\"''")
	})
})
