import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import {
	brokerPaths,
	processBirth,
	processOwnerAlive,
	isRecord,
	secureBrokerDirectory,
	type BrokerDescriptor,
} from "./RuntimeBrokerClient"

type Client = { socket: net.Socket; authenticated: boolean }
type Owner = { client: Client; sessionId: string; active: boolean }
type Pending = { client: Client; id: number; method: string; taskId?: string }

/** A private per-database transport owner; Rust remains the sole database writer. */
export async function runRuntimeBroker(database: string, executable: string, cwd: string): Promise<void> {
	// The spawn inputs arrive over argv from the electing client. The broker
	// directory is already owner-only, but a corrupted or tampered descriptor /
	// election must not turn into spawning an arbitrary binary: verify the host
	// executable is a real file and the database/cwd exist before any spawn.
	const executableStat = await fs.stat(executable).catch(() => undefined)
	if (!executableStat?.isFile()) {
		console.error(`Host executable is not a regular file: ${executable}`)
		process.exit(2)
	}
	const cwdStat = await fs.stat(cwd).catch(() => undefined)
	if (!cwdStat?.isDirectory()) {
		console.error(`Host working directory is not a directory: ${cwd}`)
		process.exit(2)
	}
	const databaseStat = await fs.stat(database).catch(() => undefined)
	if (databaseStat?.isDirectory()) {
		console.error(`Host database path is a directory: ${database}`)
		process.exit(2)
	}
	const paths = await brokerPaths(database)
	await secureBrokerDirectory(paths.directory)
	if (paths.socketDirectory) await secureBrokerDirectory(paths.socketDirectory)
	const token = randomBytes(32)
	const startedAt = processBirth(process.pid)
	const clients = new Set<Client>()
	const sockets = new Set<net.Socket>()
	const tasks = new Map<string, Owner>()
	const sessions = new Map<string, Owner>()
	const pending = new Map<number, Pending>()
	let host: ChildProcessWithoutNullStreams | undefined
	let hostStartedAt: string | undefined
	let nextId = 1
	let stopping = false
	let idle: NodeJS.Timeout | undefined
	let metadataWrite: Promise<void> = Promise.resolve()
	function publishDescriptor(): Promise<void> {
		metadataWrite = metadataWrite.then(async () => {
			if (stopping) return
			const descriptor: BrokerDescriptor = {
				version: 1,
				pid: process.pid,
				startedAt,
				hostPid: host?.pid ?? 0,
				hostStartedAt,
				endpoint: paths.endpoint,
				token: token.toString("hex"),
			}
			const temporary = `${paths.descriptor}.${process.pid}.tmp`
			await fs.writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 })
			await fs.rename(temporary, paths.descriptor)
		})
		return metadataWrite
	}
	const send = (client: Client, message: unknown) => {
		if (!client.socket.destroyed && !client.socket.writableEnded)
			client.socket.write(`${JSON.stringify(message)}\n`)
	}
	const fail = (message: string) => {
		console.error(message)
		for (const client of clients) send(client, { broker: "error", message })
	}
	async function clearElection(): Promise<void> {
		const owner: unknown = await fs
			.readFile(path.join(paths.election, "owner.json"), "utf8")
			.then((text) => JSON.parse(text))
			.catch(() => undefined)
		if (isRecord(owner) && (owner.pid === process.pid || owner.childPid === process.pid)) {
			await fs.rm(path.join(paths.election, "owner.json"), { force: true })
			await fs.rmdir(paths.election).catch(() => undefined)
		}
	}
	async function cleanup(): Promise<void> {
		await metadataWrite.catch(() => undefined)
		const descriptor: unknown = await fs
			.readFile(paths.descriptor, "utf8")
			.then((text) => JSON.parse(text))
			.catch(() => undefined)
		if (isRecord(descriptor) && descriptor.pid === process.pid) {
			if (paths.socketDirectory) await fs.rm(paths.endpoint, { force: true })
			await fs.rm(paths.descriptor, { force: true })
		}
		await clearElection()
	}
	function finish(code: number): void {
		stopping = true
		clearTimeout(idle)
		for (const socket of sockets) socket.end()
		server.close()
		void cleanup().finally(() => process.exit(code))
	}
	function shutdown(): void {
		if (stopping) return
		stopping = true
		clearTimeout(idle)
		server.close()
		if (!host) {
			finish(0)
			return
		}
		// EOF lets Rust drop agents, their children, and the exclusive runtime lock.
		host.stdin.end()
		const timer = setTimeout(() => host?.kill(), 5000)
		timer.unref()
		host.once("exit", () => clearTimeout(timer))
	}
	function startHost(): ChildProcessWithoutNullStreams {
		if (host) return host
		const child = spawn(executable, ["--db", database], { cwd, env: process.env, windowsHide: true, stdio: "pipe" })
		host = child
		hostStartedAt = child.pid ? processBirth(child.pid) : undefined
		createInterface({ input: child.stdout })
			.on("error", (error: Error) => {
				fail(`Rust Host output failed: ${error.message}`)
				shutdown()
			})
			.on("line", (line) => {
				let message: unknown
				try {
					message = JSON.parse(line)
				} catch {
					fail("Invalid Rust Host output")
					shutdown()
					return
				}
				if (!isRecord(message)) {
					fail("Invalid Rust Host output")
					shutdown()
					return
				}
				if (typeof message.id === "number") {
					const call = pending.get(message.id)
					if (!call) return
					pending.delete(message.id)
					if (
						["harness.prepare", "harness.continue", "harness.handoff"].includes(call.method) &&
						isRecord(message.result) &&
						typeof message.result.task_id === "string" &&
						typeof message.result.session_id === "string"
					) {
						const ownership = { client: call.client, sessionId: message.result.session_id, active: false }
						tasks.set(message.result.task_id, ownership)
						sessions.set(message.result.session_id, ownership)
					}
					if (message.error && call.method === "agent.run" && call.taskId) {
						const owner = tasks.get(call.taskId)
						if (owner) owner.active = false
					}
					send(call.client, { ...message, id: call.id })
				} else if (
					typeof message.kind === "string" &&
					typeof message.task_id === "string" &&
					typeof message.session_id === "string"
				) {
					const owner = tasks.get(message.task_id) ?? sessions.get(message.session_id)
					if (owner) {
						send(owner.client, message)
						if (["agent.finished", "agent.error"].includes(message.kind)) owner.active = false
					}
				} else {
					fail("Unknown Rust Host output")
					shutdown()
				}
			})
		let stderr = ""
		createInterface({ input: child.stderr })
			.on("error", (error: Error) => {
				fail(`Rust Host stderr failed: ${error.message}`)
				shutdown()
			})
			.on("line", (line) => {
				stderr = line.slice(-2000)
				console.error(line)
				for (const client of clients) send(client, { broker: "log", message: line })
			})
		child.stdin.on("error", (error) => {
			fail(`Rust Host input failed: ${error.message}`)
			shutdown()
		})
		child.once("error", (error) => {
			fail(`Rust Host failed: ${error.message}`)
			finish(1)
		})
		child.once("exit", (code, signal) => {
			const expected = stopping
			if (!expected) fail(`OctoCode host exited (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr}` : ""}`)
			finish(expected && code === 0 ? 0 : 1)
		})
		return child
	}
	const server = net.createServer((socket) => {
		if (stopping) {
			socket.destroy()
			return
		}
		sockets.add(socket)
		const client: Client = { socket, authenticated: false }
		let bytes = 0
		socket.setTimeout(5000, () => {
			if (!client.authenticated) socket.destroy()
		})
		socket.on("data", (chunk) => {
			if (!client.authenticated && (bytes += chunk.length) > 1024) socket.destroy()
		})
		socket.on("error", () => undefined)
		// readline uses StringDecoder to preserve multibyte UTF-8 across chunks.
		const lines = createInterface({ input: socket })
		lines.on("error", () => socket.destroy())
		lines.on("line", (line) => {
			if (socket.destroyed || socket.writableEnded) return
			let message: unknown
			try {
				message = JSON.parse(line)
			} catch {
				socket.destroy()
				return
			}
			if (!client.authenticated) {
				const supplied =
					isRecord(message) && typeof message.token === "string" && /^[a-f0-9]{64}$/.test(message.token)
						? Buffer.from(message.token, "hex")
						: Buffer.alloc(0)
				if (
					!isRecord(message) ||
					message.broker !== "authenticate" ||
					supplied.length !== token.length ||
					!timingSafeEqual(supplied, token)
				) {
					send(client, { broker: "error", message: "Host broker authentication failed" })
					socket.end()
					return
				}
				client.authenticated = true
				socket.setTimeout(0)
				clearTimeout(idle)
				clients.add(client)
				const child = startHost()
				void publishDescriptor().catch((error: unknown) => {
					fail(`Host broker metadata failed: ${error instanceof Error ? error.message : String(error)}`)
					shutdown()
				})
				send(client, { broker: "ready", hostPid: child.pid })
				return
			}
			if (
				!isRecord(message) ||
				typeof message.id !== "number" ||
				!Number.isSafeInteger(message.id) ||
				typeof message.method !== "string" ||
				!message.method
			) {
				send(client, { broker: "error", message: "Invalid Host broker request" })
				socket.end()
				return
			}
			const params = isRecord(message.params) ? message.params : {}
			const taskId = typeof params.task_id === "string" ? params.task_id : undefined
			const sessionId = typeof params.session_id === "string" ? params.session_id : ""
			const owner = (taskId ? tasks.get(taskId) : undefined) ?? sessions.get(sessionId)
			if (
				owner?.active &&
				owner.client !== client &&
				(message.method.startsWith("agent.") ||
					["harness.prepare", "harness.continue", "harness.handoff"].includes(message.method))
			) {
				send(client, {
					id: message.id,
					error: { code: -32050, message: "Task is active in another OctoCode window" },
				})
				return
			}
			if (message.method === "agent.run" && taskId) {
				if (owner?.active) {
					send(client, { id: message.id, error: { code: -32050, message: "Task is already active" } })
					return
				}
				const ownership = { client, sessionId, active: true }
				tasks.set(taskId, ownership)
				if (sessionId) sessions.set(sessionId, ownership)
			}
			const id = nextId++
			pending.set(id, { client, id: message.id, method: message.method, taskId })
			if (!host || host.stdin.destroyed || host.stdin.writableEnded) {
				send(client, { id: message.id, error: { code: -32000, message: "Rust Host is not running" } })
				pending.delete(id)
				return
			}
			host.stdin.write(`${JSON.stringify({ id, method: message.method, params: message.params ?? {} })}\n`)
		})
		socket.once("close", () => {
			lines.close()
			sockets.delete(socket)
			clients.delete(client)
			for (const [id, call] of pending) if (call.client === client) pending.delete(id)
			// Models/MCP belong to this extension host. Cancel only its active tasks;
			// Rust persists their cancelled lifecycle before emitting completion.
			for (const [taskId, owner] of tasks)
				if (owner.client === client && owner.active && !stopping) {
					if (host && !host.stdin.destroyed && !host.stdin.writableEnded) {
						host.stdin.write(
							`${JSON.stringify({ id: nextId++, method: "agent.cancel", params: { task_id: taskId } })}\n`,
						)
					}
				}
			if (client.authenticated && clients.size === 0 && !stopping) idle = setTimeout(shutdown, 1000)
		})
	})
	server.on("error", (error) => {
		if (host) {
			fail(`Host broker socket failed: ${error.message}`)
			shutdown()
		}
	})
	// Bind first: concurrent startup losers never open the database or unlink a live socket.
	if (paths.socketDirectory) {
		const old: unknown = await fs
			.readFile(paths.descriptor, "utf8")
			.then((text) => JSON.parse(text))
			.catch(() => undefined)
		if (isRecord(old) && typeof old.pid === "number" && !processOwnerAlive(old.pid, old.startedAt))
			await fs.rm(paths.endpoint, { force: true })
	}
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(paths.endpoint, resolve)
	})
	if (paths.socketDirectory) await fs.chmod(paths.endpoint, 0o600)
	await publishDescriptor()
	await clearElection()
	if (clients.size === 0) idle = setTimeout(shutdown, 15_000)
}

if (typeof require !== "undefined" && require.main === module) {
	void runRuntimeBroker(process.argv[2], process.argv[3], process.argv[4]).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Host broker failed")
		process.exit(1)
	})
}
