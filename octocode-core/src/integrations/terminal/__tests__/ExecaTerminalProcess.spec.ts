import { Buffer } from "buffer"
import { describe, expect, it } from "vitest"

import { createShellInvocation } from "../ExecaTerminalProcess"

describe("createShellInvocation", () => {
	const command = '$value = `"中文🙂`"; Write-Output $value'

	it("encodes PowerShell without changing command characters", () => {
		const invocation = createShellInvocation(command, "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")
		expect(invocation.args.slice(0, -1)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
		])
		const script = Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le")
		expect(script).toContain("$ProgressPreference='SilentlyContinue'")
		expect(script).toContain(command)
	})

	it("uses the native Windows PowerShell path by default", () => {
		const invocation = createShellInvocation("Get-Date", "", "win32", { SystemRoot: "D:\\Windows" })
		expect(invocation.file).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
	})

	it("starts bash without profiles", () => {
		expect(createShellInvocation("printf '$x'", "", "linux")).toEqual({
			file: "/bin/bash",
			args: ["--noprofile", "--norc", "-c", "printf '$x'"],
		})
	})

	it("starts zsh without profiles", () => {
		expect(createShellInvocation("printf '$x'", "", "darwin")).toEqual({
			file: "/bin/zsh",
			args: ["-f", "-c", "printf '$x'"],
		})
	})
})
