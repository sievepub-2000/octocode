const { execFileSync } = require("child_process")
const path = require("path")

const windowsValue = (value) => {
	if (/[\0\r\n"%!^&|<>]/.test(value)) throw new Error(`Unsafe command argument: ${value}`)
	return value
}

module.exports = function runCommand(command, args, options) {
	if (process.platform !== "win32") return execFileSync(command, args, options)
	const executable = path.extname(command) || /[\\/]/.test(command) ? command : `${command}.cmd`
	const values = [executable, ...args].map(windowsValue)
	return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "call", ...values], options)
}
