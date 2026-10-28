import * as fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { createHash, randomBytes } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { createInterface } from "node:readline"

export type BrokerPaths = {
	directory: string
	descriptor: string
	election: string
	endpoint: string
	socketDirectory?: string
}
export type BrokerDescriptor = {
	version: 1
	pid: number
	startedAt?: string
	hostPid: number
	hostStartedAt?: string
	endpoint: string
	token: string
}
export type BrokerOptions = {
	database: string
	executable: string
	cwd: string
	env: NodeJS.ProcessEnv
	node: string
	script: string
	onLine: (line: string) => void
	onLog: (line: string) => void
	onError: (error: Error) => void
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return isRecord(error) && error.code === "EPERM"
	}
}

/**
 * Birth identity distinguishes a reused PID without terminating the new process.
 * Only our own PID can be cached safely: another process may exit and its PID
 * may be reused between polls without an observable dead interval.
 */
let ownBirth: string | undefined

export function processBirth(pid: number): string | undefined {
	if (!isAlive(pid)) return undefined
	if (pid === process.pid && ownBirth !== undefined) return ownBirth
	try {
		const observed = (() => {
			if (process.platform === "win32") {
				const command = `$ProgressPreference='SilentlyContinue';[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`
				return execFileSync(
					path.join(
						process.env.SystemRoot ?? "C:\\Windows",
						"System32",
						"WindowsPowerShell",
						"v1.0",
						"powershell.exe",
					),
					[
						"-NoProfile",
						"-NonInteractive",
						"-OutputFormat",
						"Text",
						"-EncodedCommand",
						Buffer.from(command, "utf16le").toString("base64"),
					],
					{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
				).trim()
			}
			if (process.platform === "linux") {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
				const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
				return `${boot}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`
			}
			const identity = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim()
			return identity ? createHash("sha256").update(identity).digest("hex") : undefined
		})()
		if (observed && pid === process.pid) ownBirth = observed
		return observed
	} catch {
		return undefined
	}
}

export function processOwnerAlive(pid: number, birth?: unknown): boolean {
	if (!isAlive(pid)) return false
	if (typeof birth !== "string") return true
	const actual = processBirth(pid)
	return actual === undefined || actual === birth
}

export async function brokerPaths(database: string): Promise<BrokerPaths> {
	const parent = await fs.realpath(path.dirname(database))
	const canonical = await fs.realpath(database).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error
		return path.join(parent, path.basename(database))
	})
	const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 24)
	const directory = path.join(parent, `.octocode-host-${hash}`)
	const socketDirectory =
		process.platform === "win32" ? undefined : path.join(tmpdir(), `octocode-${process.getuid?.()}-${hash}`)
	return {
		directory,
		descriptor: path.join(directory, "broker.json"),
		election: path.join(directory, "starting"),
		endpoint:
			process.platform === "win32"
				? `\\\\.\\pipe\\octocode-host-${hash}`
				: path.join(socketDirectory!, "host.sock"),
		socketDirectory,
	}
}

export async function secureBrokerDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 })
	const stat = await fs.lstat(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Host broker directory")
	if (process.platform !== "win32") {
		if (stat.uid !== process.getuid?.()) throw new Error("Host broker directory belongs to another user")
		await fs.chmod(directory, 0o700)
		return
	}
	const command = brokerDirectoryAclCommand(directory)
	execFileSync(
		path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		[
			"-NoProfile",
			"-NonInteractive",
			"-OutputFormat",
			"Text",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		],
		{ windowsHide: true, stdio: "pipe" },
	)
}

export function brokerDirectoryAclCommand(directory: string): string {
	const literal = directory.replace(/'/g, "''")
	return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$dir='${literal}'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$info=New-Object System.IO.DirectoryInfo($dir)
$existing=$info.GetAccessControl()
$owner=$existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')){throw 'Unexpected Host broker directory owner'}
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
foreach($principal in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))){
 $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($principal,'FullControl',$inherit,'None','Allow')
 $acl.AddAccessRule($rule)
}
$info.SetAccessControl($acl)
$actual=$info.GetAccessControl()
if(-not $actual.AreAccessRulesProtected -or $actual.Access.Count -ne 2){throw 'Host broker directory ACL is not private'}
$actualSids=@($actual.Access|ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique)
if(($actualSids -join ',') -ne ((@($sid.Value,'S-1-5-18')|Sort-Object) -join ',')){throw 'Unexpected Host broker directory ACL principal'}
foreach($rule in $actual.Access){
 if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Invalid Host broker directory ACL rule'}
}`
}

async function readDescriptor(paths: BrokerPaths): Promise<BrokerDescriptor | undefined> {
	let text: string
	try {
		text = await fs.readFile(paths.descriptor, "utf8")
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined
		throw error
	}
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		throw new Error("Invalid Host broker metadata")
	}
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Number.isInteger(value.pid) ||
		typeof value.pid !== "number" ||
		value.pid <= 0 ||
		!Number.isInteger(value.hostPid) ||
		typeof value.hostPid !== "number" ||
		value.hostPid < 0 ||
		value.endpoint !== paths.endpoint ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.token)
	) {
		throw new Error("Invalid Host broker metadata")
	}
	return value as BrokerDescriptor
}

function attach(descriptor: BrokerDescriptor, options: BrokerOptions): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(descriptor.endpoint)
		let ready = false
		const timer = setTimeout(() => socket.destroy(new Error("Host broker authentication timed out")), 5000)
		const lines = createInterface({ input: socket })
		// readline forwards input errors; the socket handler below owns reporting.
		lines.on("error", () => undefined)
		socket.once("connect", () =>
			socket.write(`${JSON.stringify({ broker: "authenticate", token: descriptor.token })}\n`),
		)
		lines.on("line", (line) => {
			let value: unknown
			try {
				value = JSON.parse(line)
			} catch {
				socket.destroy(new Error("Invalid Host broker output"))
				return
			}
			if (isRecord(value) && value.broker === "ready") {
				ready = true
				clearTimeout(timer)
				options.onLog(
					`[OctoCode host] attached broker=${descriptor.pid} pid=${value.hostPid ?? descriptor.hostPid}`,
				)
				resolve(socket)
			} else if (isRecord(value) && value.broker === "error") {
				socket.destroy(new Error(typeof value.message === "string" ? value.message : "Host broker failed"))
			} else if (isRecord(value) && value.broker === "log") {
				if (typeof value.message === "string") options.onLog(`[OctoCode host] ${value.message}`)
			} else if (ready) options.onLine(line)
		})
		socket.on("error", (error) => {
			if (ready) options.onError(error)
			else reject(error)
		})
		socket.once("close", () => {
			clearTimeout(timer)
			lines.close()
			if (!ready) reject(new Error("Host broker closed before authentication"))
		})
	})
}

async function reapDeadElection(paths: BrokerPaths): Promise<void> {
	const readOwner = () =>
		fs
			.readFile(path.join(paths.election, "owner.json"), "utf8")
			.then((text): unknown => JSON.parse(text))
			.catch(() => undefined)
	const dead = (owner: unknown) =>
		isRecord(owner) &&
		typeof owner.pid === "number" &&
		Number.isInteger(owner.pid) &&
		owner.pid <= 0x7fffffff &&
		owner.pid > 0 &&
		!processOwnerAlive(owner.pid, owner.startedAt) &&
		(typeof owner.childPid !== "number" || !processOwnerAlive(owner.childPid, owner.childStartedAt))
	if (!dead(await readOwner())) return
	// Serialize reapers, then atomically retire the directory. No stale reaper can
	// unlink a new startup's owner.json at the original path.
	const marker = path.join(paths.election, "reaping")
	const lock = await fs.open(marker, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
		if (["ENOENT", "EEXIST"].includes(error.code ?? "")) return undefined
		throw error
	})
	if (!lock) return
	await lock.close()
	if (!dead(await readOwner())) {
		await fs.rm(marker, { force: true })
		return
	}
	const retired = `${paths.election}.dead-${randomBytes(16).toString("hex")}`
	await fs.rename(paths.election, retired)
	await fs.rm(path.join(retired, "owner.json"))
	await fs.rm(path.join(retired, "reaping"))
	await fs.rmdir(retired)
}

export async function connectSharedHost(options: BrokerOptions): Promise<net.Socket> {
	const paths = await brokerPaths(options.database)
	await secureBrokerDirectory(paths.directory)
	if (paths.socketDirectory) await secureBrokerDirectory(paths.socketDirectory)
	const deadline = Date.now() + 15_000
	let started = false
	let failed: Error | undefined
	while (Date.now() < deadline) {
		if (failed) throw failed
		const descriptor = await readDescriptor(paths)
		if (
			descriptor &&
			!processOwnerAlive(descriptor.pid, descriptor.startedAt) &&
			descriptor.hostPid > 0 &&
			processOwnerAlive(descriptor.hostPid, descriptor.hostStartedAt)
		) {
			// A crashed transport closes Rust stdin. Observe that child exiting before
			// electing a replacement; never kill an unidentified/reused PID.
			await new Promise<void>((resolve) => setTimeout(resolve, 50))
			continue
		}
		if (descriptor && processOwnerAlive(descriptor.pid, descriptor.startedAt)) {
			try {
				return await attach(descriptor, options)
			} catch (error) {
				// A broker finishing its last-client shutdown can still have a live PID.
				// Wait for transport teardown; database-lock failures remain visible.
				if (!isRecord(error) || !["ECONNREFUSED", "ENOENT", "ECONNRESET"].includes(String(error.code)))
					throw error
				await new Promise<void>((resolve) => setTimeout(resolve, 50))
				continue
			}
		}
		if (started) {
			await new Promise<void>((resolve) => setTimeout(resolve, 50))
			continue
		}
		try {
			await fs.mkdir(paths.election, { mode: 0o700 })
			const nonce = randomBytes(16).toString("hex")
			const startedAt = processBirth(process.pid)
			await fs.writeFile(
				path.join(paths.election, "owner.json"),
				JSON.stringify({ pid: process.pid, startedAt, nonce }),
				{
					mode: 0o600,
				},
			)
			const log = await fs.open(path.join(paths.directory, "broker.log"), "a", 0o600)
			const child = spawn(options.node, [options.script, options.database, options.executable, options.cwd], {
				cwd: options.cwd,
				env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
				detached: true,
				windowsHide: true,
				stdio: ["ignore", log.fd, log.fd],
			})
			const clearOwnFailedElection = async () => {
				const owner: unknown = await fs
					.readFile(path.join(paths.election, "owner.json"), "utf8")
					.then((text) => JSON.parse(text))
					.catch(() => undefined)
				if (isRecord(owner) && owner.pid === process.pid && owner.nonce === nonce) {
					await fs.rm(path.join(paths.election, "owner.json"), { force: true })
					await fs.rmdir(paths.election).catch(() => undefined)
				}
			}
			child.once("error", (error) => {
				failed = error
				void clearOwnFailedElection().catch((error: unknown) =>
					options.onLog(
						`[OctoCode host] startup lease cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
			})
			child.once("exit", (code) => {
				failed = new Error(
					`Host broker exited (${code ?? "unknown"}); see ${path.join(paths.directory, "broker.log")}`,
				)
				void clearOwnFailedElection().catch((error: unknown) =>
					options.onLog(
						`[OctoCode host] startup lease cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
			})
			if (child.pid)
				await fs
					.writeFile(
						path.join(paths.election, "owner.json"),
						JSON.stringify({
							pid: process.pid,
							startedAt,
							childPid: child.pid,
							childStartedAt: processBirth(child.pid),
							nonce,
						}),
						{ mode: 0o600 },
					)
					.catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error
					})
			await log.close()
			child.unref()
			started = true
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error
			await reapDeadElection(paths)
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50))
	}
	throw new Error("Host broker did not become available; a live startup owner was preserved")
}
