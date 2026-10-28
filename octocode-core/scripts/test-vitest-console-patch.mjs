import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import vm from "node:vm"

// Backport of https://github.com/vitest-dev/vitest/pull/11619 (a60b8e1325b3).
const require = createRequire(new URL("../src/package.json", import.meta.url))
const chunks = path.join(path.dirname(require.resolve("vitest/package.json")), "dist/chunks")
const file = fs.readdirSync(chunks).find((name) => /^console\..*\.js$/.test(name))
const source = fs.readFileSync(path.join(chunks, file), "utf8")
const body = source.slice(source.indexOf("\tfunction sendLog("), source.indexOf("\n\treturn new Console("))
assert(body.includes("instanceof EnvironmentTeardownError"), "Official teardown-only handler is installed")
class EnvironmentTeardownError extends Error {}
let handler
let sent
const send = vm.runInNewContext(`(${body.trim()})`, {
	EnvironmentTeardownError,
	RealDate: Date,
	timers: new Map([["task", { stdoutTime: 123 }]]),
	state: () => ({
		rpc: {
			onUserConsoleLog: (payload) => {
				sent = payload
				return {
					catch: (callback) => {
						handler = callback
					},
				}
			},
		},
	}),
})
send("stdout", "task", "actual log", 1)
assert.equal(sent.content, "actual log")
assert.equal(sent.time, 123)
assert.doesNotThrow(() => handler(new EnvironmentTeardownError("worker closed")))
const error = new Error("real RPC failure")
assert.throws(
	() => handler(error),
	(value) => value === error,
)
console.log("Vitest console patch: log delivery preserved; teardown race handled; other errors rethrown")
