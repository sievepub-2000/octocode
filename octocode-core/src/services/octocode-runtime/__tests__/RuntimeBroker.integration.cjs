/* Run with Node --test using the bundled Node/Rust environment. */
/* global require, __dirname */
const process = require("node:process")
const { Buffer } = require("node:buffer")
const { setTimeout } = require("node:timers")
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const net = require("node:net")
const { spawn, execFileSync } = require("node:child_process")
const { createInterface } = require("node:readline")
const esbuild = require("esbuild")
const source = path.resolve(__dirname, "..")
let fixture = process.env.OCTOCODE_BROKER_TEST_FIXTURE
let fixtureDirectory
before(async () => {
	if (fixture) return
	fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-broker-fixture-"))
	fixture = path.join(fixtureDirectory, process.platform === "win32" ? "broker-process.exe" : "broker-process")
	const args = [path.join(__dirname, "fixtures", "broker-process.rs"), "-o", fixture]
	if (process.platform === "win32" && process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER)
		args.push(
			"-C",
			`linker=${process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER}`,
			"-C",
			"linker-flavor=lld-link",
		)
	execFileSync("rustc", args, { windowsHide: true, stdio: "pipe" })
})
after(async () => {
	if (fixtureDirectory)
		await fs.rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, timeout = 10000) {
	const end = Date.now() + timeout
	while (Date.now() < end) {
		const value = await fn()
		if (value) return value
		await sleep(25)
	}
	throw new Error("Condition timed out")
}
async function setup() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-broker-test-"))
	const broker = path.join(directory, "broker.cjs")
	const api = path.join(directory, "client.cjs")
	await esbuild.build({
		entryPoints: [path.join(source, "RuntimeBroker.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile: broker,
	})
	await esbuild.build({
		entryPoints: [path.join(source, "RuntimeBrokerClient.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile: api,
	})
	return { directory, broker, apiFile: api, ...require(api) }
}
function connection(api, executable, database) {
	const messages = [],
		logs = [],
		errors = []
	let socket,
		id = 1
	const waiters = new Map()
	return {
		messages,
		logs,
		errors,
		async open() {
			socket = await api.connectSharedHost({
				database,
				executable,
				cwd: api.directory,
				env: process.env,
				node: process.execPath,
				script: api.broker,
				onLine(line) {
					const msg = JSON.parse(line)
					messages.push(msg)
					const waiter = waiters.get(msg.id)
					if (waiter) {
						waiters.delete(msg.id)
						waiter(msg)
					}
				},
				onLog(line) {
					logs.push(line)
				},
				onError(error) {
					errors.push(error.message)
				},
			})
			return this
		},
		async call(method, params = {}, requestId = id++, fragment = false) {
			const response = new Promise((resolve) => waiters.set(requestId, resolve))
			const payload = Buffer.from(JSON.stringify({ id: requestId, method, params }) + "\n")
			if (fragment) {
				for (const byte of payload) {
					socket.write(Buffer.from([byte]))
					await sleep(1)
				}
			} else socket.write(payload)
			const msg = await Promise.race([
				response,
				sleep(10000).then(() => {
					throw new Error("RPC timed out: " + method)
				}),
			])
			if (msg.error) throw new Error(msg.error.message)
			return msg.result
		},
		close() {
			socket?.end()
		},
		destroy() {
			socket?.destroy()
		},
	}
}
async function stopped(api, database) {
	const paths = await api.brokerPaths(database)
	await until(async () => {
		try {
			await fs.access(paths.descriptor)
			return false
		} catch {
			return true
		}
	})
}
test(
	"authentication, fragmented UTF-8, same-id isolation, detached owner, private ACL and election",
	{ timeout: 60000 },
	async () => {
		const api = await setup(),
			database = path.join(api.directory, "fake.db")
		let a, b, c, brokerChild
		try {
			// Start only the transport; unauthenticated RPC must not even spawn the Host.
			brokerChild = spawn(process.execPath, [api.broker, database, fixture, api.directory], {
				cwd: api.directory,
				windowsHide: true,
				stdio: "pipe",
			})
			const paths = await api.brokerPaths(database)
			const descriptor = await until(async () =>
				fs
					.readFile(paths.descriptor, "utf8")
					.then(JSON.parse)
					.catch(() => undefined),
			)
			const unauthorized = net.connect(descriptor.endpoint)
			const denied = new Promise((resolve) => unauthorized.once("close", resolve))
			unauthorized.on("error", () => {})
			unauthorized.write(JSON.stringify({ id: 1, method: "health" }) + "\n")
			unauthorized.resume()
			await denied
			await assert.rejects(fs.access(path.join(api.directory, "fixture-host-started")))
			a = await connection(api, fixture, database).open()
			b = await connection(api, fixture, database).open()
			const [first, second] = await Promise.all([
				a.call("echo", { window: "甲🙂", value: "中文✅" }, 1, true),
				b.call("echo", { window: "乙🚀", value: "第二窗口" }, 1, true),
			])
			assert.deepEqual(first, { window: "甲🙂", value: "中文✅" })
			assert.deepEqual(second, { window: "乙🚀", value: "第二窗口" })
			assert.equal(a.messages.length, 1)
			assert.equal(b.messages.length, 1)
			assert.equal(a.logs[0].match(/broker=(\d+)/)[1], b.logs[0].match(/broker=(\d+)/)[1])
			assert(!a.messages.some((msg) => JSON.stringify(msg).includes("乙")))
			// ACL inspection contains identities/rights only, never authentication material.
			if (process.platform === "win32") {
				const { execFileSync } = require("node:child_process")
				const literal = paths.directory.replace(/'/g, "''")
				const command = `$ProgressPreference='SilentlyContinue';$a=(New-Object System.IO.DirectoryInfo('${literal}')).GetAccessControl();$a.AreAccessRulesProtected;($a.Access|ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})`
				const result = execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-OutputFormat",
						"Text",
						"-EncodedCommand",
						Buffer.from(command, "utf16le").toString("base64"),
					],
					{ encoding: "utf8", windowsHide: true },
				)
				assert(result.startsWith("True"))
				assert(!result.includes("S-1-1-0"))
				assert(!result.includes("S-1-5-32-545"))
			} else {
				assert.equal((await fs.stat(paths.directory)).mode & 0o777, 0o700)
			}
			a.close()
			await sleep(200)
			assert.deepEqual(await b.call("echo", { still: "运行🙂" }), { still: "运行🙂" })
			b.close()
			await stopped(api, database)
			// A stale owner can be removed only after a confirmed dead PID.
			await fs.mkdir(paths.election)
			await fs.writeFile(path.join(paths.election, "owner.json"), JSON.stringify({ pid: brokerChild.pid }))
			await until(() => !api.isAlive(brokerChild.pid))
			;[b, c] = await Promise.all([
				connection(api, fixture, database).open(),
				connection(api, fixture, database).open(),
			])
			assert.equal(b.logs[0].match(/broker=(\d+)/)[1], c.logs[0].match(/broker=(\d+)/)[1])
			assert.deepEqual(await b.call("echo", { restarted: true }), { restarted: true })
			b.close()
			c.close()
			await stopped(api, database)
			// Reused PID fixture: the current live process has a different birth identity.
			await fs.writeFile(
				paths.descriptor,
				JSON.stringify({
					version: 1,
					pid: process.pid,
					startedAt: "old-birth",
					hostPid: process.pid,
					hostStartedAt: "old-host-birth",
					endpoint: paths.endpoint,
					token: "0".repeat(64),
				}),
			)
			await fs.mkdir(paths.election)
			await fs.writeFile(
				path.join(paths.election, "owner.json"),
				JSON.stringify({ pid: process.pid, startedAt: "old-birth" }),
			)
			b = await connection(api, fixture, database).open()
			assert.deepEqual(await b.call("echo", { reuse: true }), { reuse: true })
			assert(api.isAlive(process.pid))
			b.close()
			await stopped(api, database)
			await fs.mkdir(paths.election)
			await fs.writeFile(path.join(paths.election, "owner.json"), JSON.stringify({ pid: process.pid }))
			await assert.rejects(connection(api, fixture, database).open(), /live startup owner was preserved/)
			assert.equal(
				JSON.parse(await fs.readFile(path.join(paths.election, "owner.json"), "utf8")).pid,
				process.pid,
			)
		} finally {
			a?.destroy()
			b?.destroy()
			c?.destroy()
			brokerChild?.kill()
			await fs.rm(api.directory, { recursive: true, force: true })
		}
	},
)
test(
	"real Rust Host: one DB lock, concurrent tasks, owner-only cancellation, switching and restart persistence",
	{ timeout: 90000 },
	async () => {
		const api = await setup(),
			database = path.join(api.directory, "real.db")
		const host =
			process.env.OCTOCODE_BROKER_TEST_HOST || path.resolve(source, "../../bin/win32-x64/octocode-host.exe")
		let a, b, c
		try {
			// Concurrent fresh clients exercise startup election, not just attachment.
			;[a, b] = await Promise.all([
				connection(api, host, database).open(),
				connection(api, host, database).open(),
			])
			await Promise.all([a.call("health", {}, 1), b.call("health", {}, 1)])
			assert.equal(a.logs[0].match(/broker=(\d+)/)[1], b.logs[0].match(/broker=(\d+)/)[1])
			await a.call("setting.set", { key: "broker-test", value: { text: "持久化🙂" } })
			assert.deepEqual(await b.call("setting.get", { key: "broker-test" }), { text: "持久化🙂" })
			const conflicting = spawn(host, ["--db", database], { windowsHide: true, stdio: "pipe" })
			let error = ""
			conflicting.stderr.on("data", (chunk) => (error += chunk))
			assert.equal(await new Promise((resolve) => conflicting.once("exit", resolve)), 1)
			assert.match(error, /database is locked/)
			await b.call("health")
			const prepare = (client, prompt) =>
				client.call("harness.prepare", {
					title: prompt,
					workspace: api.directory,
					prompt,
					provider: {
						apiProvider: "openai",
						openAiModelId: "fixture",
						openAiBaseUrl: "http://127.0.0.1:1/v1",
						openAiApiKey: "fixture",
					},
				})
			const ta = await prepare(a, "long owner A"),
				tb = await prepare(b, "short owner B")
			const run = async (client, task, prompt) => {
				const home = path.join(api.directory, task.task_id)
				await fs.mkdir(home)
				return client.call("agent.run", {
					task_id: task.task_id,
					session_id: task.session_id,
					executable: fixture,
					harness_home: home,
					cwd: task.working_directory,
					model: task.route.model,
					prompt,
					supervision: { max_interventions: 0 },
				})
			}
			await Promise.all([run(a, ta, "long owner A"), run(b, tb, "short owner B")])
			await until(() => a.messages.some((msg) => msg.kind === "text"))
			await until(() => b.messages.some((msg) => msg.kind === "text"))
			assert(a.messages.filter((msg) => msg.kind).every((msg) => msg.task_id === ta.task_id))
			assert(b.messages.filter((msg) => msg.kind).every((msg) => msg.task_id === tb.task_id))
			await assert.rejects(b.call("agent.cancel", { task_id: ta.task_id }), /another OctoCode window/)
			a.destroy()
			const cancelled = await until(async () => {
				const session = await b.call("session.get", { id: ta.session_id })
				return session.status === "cancelled" && session
			})
			assert.equal(cancelled.status, "cancelled")
			await until(() => b.messages.some((msg) => msg.kind === "agent.finished"))
			const finish = b.messages.find((msg) => msg.kind === "agent.finished")
			assert.equal(finish.payload.success, true)
			assert.equal(finish.payload.cancelled, false)
			const events = await b.call("event.list", { session_id: tb.session_id })
			assert(JSON.stringify(events).includes("完整答案✅"))
			// Opening an existing inactive session in a new window transfers future events.
			c = await connection(api, host, database).open()
			const resumed = await c.call("harness.continue", {
				session_id: tb.session_id,
				prompt: "short switched",
				provider: {
					apiProvider: "openai",
					openAiModelId: "fixture",
					openAiBaseUrl: "http://127.0.0.1:1/v1",
					openAiApiKey: "fixture",
				},
			})
			const before = b.messages.filter((msg) => msg.kind).length
			await run(c, resumed, "short switched")
			await until(() => c.messages.some((msg) => msg.kind === "agent.finished"))
			assert.equal(b.messages.filter((msg) => msg.kind).length, before)
			const last = await prepare(b, "long final owner")
			await run(b, last, "long final owner")
			await until(() => b.messages.some((msg) => msg.kind === "agent.started" && msg.task_id === last.task_id))
			b.close()
			c.close()
			await stopped(api, database)
			// Actual reopening proves Rust released the exclusive lock; persistent state remains.
			b = await connection(api, host, database).open()
			assert.deepEqual(await b.call("setting.get", { key: "broker-test" }), { text: "持久化🙂" })
			assert.equal((await b.call("session.get", { id: last.session_id })).status, "cancelled")
			const after = await b.call("event.list", { session_id: tb.session_id })
			assert(JSON.stringify(after).includes("完整答案✅"))
			// Kill only our isolated transport, then prove orphan Host exit and nonce rotation.
			const paths = await api.brokerPaths(database)
			// brokerPaths resolves the parent through fs.realpath, and on this machine
			// os.tmpdir() is a symlinked path, so compare against the resolved directory.
			assert(path.basename(paths.directory).startsWith(".octocode-host-"))
			assert(path.dirname(paths.directory) === (await fs.realpath(api.directory)))
			const previous = await until(async () => {
				const value = JSON.parse(await fs.readFile(paths.descriptor, "utf8"))
				return value.hostPid > 0 && value
			})
			assert.equal(String(previous.pid), b.logs[0].match(/broker=(\d+)/)[1])
			process.kill(previous.pid)
			await until(() => !api.isAlive(previous.pid))
			b = await connection(api, host, database).open()
			assert(!api.isAlive(previous.hostPid))
			assert.deepEqual(await b.call("setting.get", { key: "broker-test" }), { text: "持久化🙂" })
			const current = JSON.parse(await fs.readFile(paths.descriptor, "utf8"))
			assert.notEqual(current.token, previous.token)
			const oldClient = net.connect(current.endpoint),
				rejected = []
			const lines = createInterface({ input: oldClient })
			lines.on("line", (line) => rejected.push(JSON.parse(line)))
			const closed = new Promise((resolve) => oldClient.once("close", resolve))
			oldClient.on("error", () => {})
			oldClient.write(JSON.stringify({ broker: "authenticate", token: previous.token }) + "\n")
			await closed
			lines.close()
			assert(rejected.some((msg) => msg.broker === "error"))
			assert(!rejected.some((msg) => msg.broker === "ready"))
			b.close()
			await stopped(api, database)
		} finally {
			a?.destroy()
			b?.destroy()
			c?.destroy()
			await sleep(1500)
			await fs.rm(api.directory, { recursive: true, force: true })
		}
	},
)
test(
	"broker outlives the first extension-host process and releases the last client DB lock",
	{ timeout: 30000 },
	async () => {
		const api = await setup(),
			database = path.join(api.directory, "detached.db")
		const host =
			process.env.OCTOCODE_BROKER_TEST_HOST || path.resolve(source, "../../bin/win32-x64/octocode-host.exe")
		const worker = path.join(api.directory, "first-window.cjs")
		let child, b
		try {
			await fs.writeFile(
				worker,
				`const {connectSharedHost}=require(process.argv[2]);
connectSharedHost({database:process.argv[4],executable:process.argv[5],cwd:process.argv[6],env:process.env,node:process.execPath,script:process.argv[3],onLine(){},onLog(){},onError(error){process.send({error:error.message})}}).then(socket=>{process.send({ready:true});process.on('message',()=>{socket.end();setTimeout(()=>process.exit(0),50)})}).catch(error=>{process.send({error:error.message});process.exit(1)});`,
			)
			child = require("node:child_process").fork(
				worker,
				[api.apiFile, api.broker, database, host, api.directory],
				{ execPath: process.execPath, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
			)
			const ready = await new Promise((resolve) => child.once("message", resolve))
			assert.deepEqual(ready, { ready: true })
			b = await connection(api, host, database).open()
			await b.call("setting.set", { key: "detached", value: true })
			const exited = new Promise((resolve) => child.once("exit", resolve))
			child.send("close")
			assert.equal(await exited, 0)
			assert.equal(await b.call("setting.get", { key: "detached" }), true)
			await b.call("health")
			b.close()
			await stopped(api, database)
			b = await connection(api, host, database).open()
			assert.equal(await b.call("setting.get", { key: "detached" }), true)
			b.close()
			await stopped(api, database)
		} finally {
			b?.destroy()
			child?.kill()
			await sleep(1500)
			await fs.rm(api.directory, { recursive: true, force: true })
		}
	},
)
test("unexpected clean Host exit is an observable broker failure", { timeout: 30000 }, async () => {
	const api = await setup(),
		database = path.join(api.directory, "zero-exit.db")
	let child, client
	try {
		child = spawn(process.execPath, [api.broker, database, fixture, api.directory], {
			cwd: api.directory,
			windowsHide: true,
			stdio: "pipe",
		})
		const exited = new Promise((resolve) => child.once("exit", resolve))
		const paths = await api.brokerPaths(database)
		await until(async () =>
			fs
				.access(paths.descriptor)
				.then(() => true)
				.catch(() => false),
		)
		client = await connection(api, fixture, database).open()
		const request = client.call("exit.zero").catch(() => undefined)
		assert.equal(await exited, 1)
		assert(client.errors.some((message) => message.includes("exited (0)")))
		await request
		await stopped(api, database)
	} finally {
		client?.destroy()
		child?.kill()
		await fs.rm(api.directory, { recursive: true, force: true })
	}
})
test(
	"Windows ACL fixture: trusted owners keep private DACLs and foreign owners are rejected",
	{ timeout: 30000 },
	async () => {
		if (process.platform !== "win32") return
		const api = await setup()
		try {
			const { execFileSync } = require("node:child_process")
			const probe = (owner) => {
				// Only identity and filesystem access are fixtures. The shipped ACL command
				// and real .NET DirectorySecurity/AccessRule construction run unchanged.
				const prefix = `$global:fixtureAcl=New-Object System.Security.AccessControl.DirectorySecurity
$global:fixtureAcl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('${owner}')))
$fixtureInfo=New-Object PSObject
$fixtureInfo|Add-Member ScriptMethod GetAccessControl {$global:fixtureAcl}
$fixtureInfo|Add-Member ScriptMethod SetAccessControl {param($acl);$global:fixtureAcl=$acl;$acl.AreAccessRulesProtected;$acl.Access.Count}
try {
`
				const command = api
					.brokerDirectoryAclCommand(api.directory)
					.replace(
						"$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
						"$identity=@{User=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;Owner=(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))}",
					)
					.replace("$info=New-Object System.IO.DirectoryInfo($dir)", "$info=$fixtureInfo")
				return execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-OutputFormat",
						"Text",
						"-EncodedCommand",
						Buffer.from(prefix + command + "\n} catch { 'REJECTED' }", "utf16le").toString("base64"),
					],
					{ encoding: "utf8", windowsHide: true, stdio: "pipe" },
				)
			}
			for (const owner of ["S-1-5-32-544", "S-1-5-18"]) {
				const protectedAcl = probe(owner)
				assert.match(protectedAcl, /True/)
				assert.match(protectedAcl, /2/)
				assert(!protectedAcl.includes("REJECTED"))
			}
			assert.match(probe("S-1-1-0"), /REJECTED/)
		} finally {
			await fs.rm(api.directory, { recursive: true, force: true })
		}
	},
)
