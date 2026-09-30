const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { EventEmitter } = require("node:events")
const { test } = require("node:test")

const source = fs.readFileSync(path.join(__dirname, "publish-npm.cjs"), "utf8")

function fixture({ answer = "y", tty = true, commitFails = false } = {}) {
	const calls = []
	const branch = "feature/$(injection)`quote`&test"
	const input = new EventEmitter()
	input.isTTY = tty
	const rl = new EventEmitter()
	rl.close = () => rl.emit("close")
	rl.question = (_prompt, callback) => {
		if (answer === null) rl.close()
		else callback(answer)
	}
	const childProcess = {
		execFileSync(file, argv, options) {
			calls.push({ file, argv, options })
			assert.equal(options.shell, undefined)
			if (argv[0] === "rev-parse") return branch
			if (argv[0] === "status") return " M npm/package.metadata.json"
			if (argv[0] === "commit" && commitFails) throw new Error("commit failed")
			return "https://example.test/pr/1"
		},
		execSync(command, options) {
			assert.ok(
				["npm version minor --no-git-tag-version", "pnpm tsup --outDir npm/dist", "npm publish"].includes(
					command,
				),
			)
			calls.push({ command, options })
		},
	}
	const fakeRequire = (name) => {
		if (name === "child_process") return childProcess
		if (name === "readline") return { createInterface: () => rl }
		if (name === "fs")
			return {
				readFileSync: () =>
					JSON.stringify({ name: "fixture", version: "1.2.3", dependencies: { zod: "3.25.76" } }),
				writeFileSync: () => {},
			}
		return require(name)
	}
	fakeRequire.resolve = () => "/fixture/prettier.cjs"
	const context = vm.createContext({
		require: fakeRequire,
		__dirname,
		console: { log() {}, warn() {}, error() {} },
		process: {
			argv: [],
			stdin: input,
			stdout: {},
			env: { SENTINEL: "kept" },
			execPath: process.execPath,
			exit: (code) => {
				throw new Error(`exit ${code}`)
			},
		},
	})
	vm.runInContext(source.slice(0, source.lastIndexOf("\nmain().catch(")), context)
	return { context, calls, branch }
}

test("release subprocesses preserve argv, metadata-only commit, stdin PR body and portable env", async () => {
	const { context, calls, branch } = fixture()
	await context.publish()
	const commit = calls.find((call) => call.argv?.[0] === "commit")
	assert.deepEqual(Array.from(commit.argv.slice(0, 4)), ["commit", "--only", "-m", "chore: bump version to v1.2.3"])
	assert.equal(commit.argv[4], "--")
	assert.equal(commit.argv[5], path.resolve(__dirname, "../npm/package.metadata.json"))
	assert.ok(!calls.some((call) => call.argv?.[0] === "add"))
	const pr = calls.find((call) => call.argv?.[0] === "pr")
	assert.equal(pr.argv[3], branch)
	assert.deepEqual(Array.from(pr.argv.slice(-2)), ["--body-file", "-"])
	assert.ok(pr.options.input.includes("\n### Changes\n"))
	assert.equal(calls.find((call) => call.argv?.[0] === "checkout" && call.argv[1] !== "-b").argv[1], branch)
	const build = calls.find((call) => call.command?.startsWith("pnpm tsup"))
	assert.equal(build.options.env.NODE_ENV, "production")
	assert.equal(build.options.env.SENTINEL, "kept")
	for (const call of calls) assert.ok(path.isAbsolute(call.options.cwd))
})

test("confirmation handles yes, no and EOF; non-TTY publish performs no work", async () => {
	for (const [answer, expected] of [
		["y", true],
		["n", false],
		[null, false],
	]) {
		assert.equal(await fixture({ answer }).context.confirmPublish(), expected)
	}
	const { context, calls } = fixture({ tty: false })
	assert.equal(await context.confirmPublish(), false)
	await assert.rejects(context.publish(), /exit 1/)
	assert.equal(calls.length, 0)
})

test("a failed commit cannot continue to push", () => {
	const { context, calls } = fixture({ commitFails: true })
	context.createVersionBranchAndCommit("1.2.3")
	assert.ok(calls.some((call) => call.argv?.[0] === "commit"))
	assert.ok(!calls.some((call) => call.argv?.[0] === "push"))
})
