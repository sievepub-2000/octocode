import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"

type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>
type RecordValue = Record<string, unknown>
const FILES = ["history_item.json", "ui_messages.json", "api_conversation_history.json", "task_metadata.json"]
const TASK_LIMIT = 64 * 1024 * 1024
const TOTAL_LIMIT = 512 * 1024 * 1024
const RECORD_LIMIT = 100_000
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value)
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const inside = (root: string, target: string) => {
	const relative = path.relative(root, target)
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** The only legacy task-data reader. It never starts an agent or writes a legacy store. */
export async function importLegacyHistory({
	sourceRoots,
	backupRoot,
	call,
	onProgress,
}: {
	sourceRoots: string[]
	backupRoot: string
	call: HostCall
	onProgress?: (progress: { found: number; imported: number; skipped: number }) => void
}): Promise<{ found: number; imported: number; skipped: number; backups: string[] }> {
	const result = { found: 0, imported: 0, skipped: 0, backups: [] as string[] }
	let totalBytes = 0
	const roots = new Set<string>()
	for (const candidate of sourceRoots) {
		let root: string
		try {
			root = await fs.realpath(candidate)
		} catch (error) {
			if (absent(error)) continue
			throw error
		}
		const canonical = process.platform === "win32" ? root.toLowerCase() : root
		if (roots.has(canonical)) continue
		roots.add(canonical)
		const tasks = path.join(root, "tasks")
		let entries: import("node:fs").Dirent[]
		try {
			if (!(await fs.lstat(tasks)).isDirectory() || !inside(root, await fs.realpath(tasks)))
				throw new Error(`Unsafe legacy tasks directory: ${tasks}`)
			entries = await fs.readdir(tasks, { withFileTypes: true })
		} catch (error) {
			if (absent(error)) continue
			throw error
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new Error(`Legacy task link is not allowed: ${entry.name}`)
			if (!entry.isDirectory()) continue
			if (!/^[A-Za-z0-9-]+$/.test(entry.name)) throw new Error(`Unsafe legacy task id: ${entry.name}`)
			const directory = path.join(tasks, entry.name)
			if (!inside(tasks, await fs.realpath(directory)))
				throw new Error(`Legacy task escapes storage: ${entry.name}`)
			const buffers = new Map<string, Buffer>()
			let taskBytes = 0
			for (const name of FILES) {
				const file = path.join(directory, name)
				let stat: Awaited<ReturnType<typeof fs.lstat>>
				try {
					stat = await fs.lstat(file)
				} catch (error) {
					if (absent(error)) continue
					throw error
				}
				if (!stat.isFile() || !inside(directory, await fs.realpath(file)))
					throw new Error(`Unsafe legacy file: ${file}`)
				if (taskBytes + stat.size > TASK_LIMIT || totalBytes + stat.size > TOTAL_LIMIT)
					throw new Error(`Legacy import byte limit exceeded: ${file}`)
				const bytes = await fs.readFile(file)
				taskBytes += bytes.length
				totalBytes += bytes.length
				if (taskBytes > TASK_LIMIT || totalBytes > TOTAL_LIMIT)
					throw new Error(`Legacy import byte limit exceeded while reading: ${file}`)
				buffers.set(name, bytes)
			}
			const metadataBytes = buffers.get("history_item.json")
			if (!metadataBytes) throw new Error(`Legacy task has no history_item.json: ${directory}`)
			const metadata: unknown = JSON.parse(metadataBytes.toString("utf8"))
			if (
				!record(metadata) ||
				metadata.id !== entry.name ||
				typeof metadata.task !== "string" ||
				typeof metadata.ts !== "number" ||
				!Number.isFinite(metadata.ts)
			)
				throw new Error(`Invalid legacy metadata: ${directory}`)
			const uiBytes = buffers.get("ui_messages.json")
			const rows: unknown = uiBytes ? JSON.parse(uiBytes.toString("utf8")) : []
			if (!Array.isArray(rows) || rows.length > RECORD_LIMIT || rows.some((row) => !record(row)))
				throw new Error(`Invalid or oversized legacy UI history: ${directory}`)
			const source_key = digest("legacy-task\0" + entry.name)
			const hash = createHash("sha256")
			for (const [name, bytes] of buffers) {
				hash.update(name)
				hash.update("\0")
				hash.update(String(bytes.length))
				hash.update("\0")
				hash.update(bytes)
			}
			const source_hash = hash.digest("hex")
			const id = `${source_key.slice(0, 8)}-${source_key.slice(8, 12)}-5${source_key.slice(13, 16)}-a${source_key.slice(17, 20)}-${source_key.slice(20, 32)}`
			const backup = path.resolve(backupRoot, source_key, source_hash)
			if (!inside(path.resolve(backupRoot), backup) || inside(directory, backup))
				throw new Error("Backup must be outside the legacy task directory")
			await fs.mkdir(backup, { recursive: true })
			for (const [name, bytes] of buffers) {
				const target = path.join(backup, name)
				try {
					await fs.writeFile(target, bytes, { flag: "wx" })
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
					if (!(await fs.readFile(target)).equals(bytes))
						throw new Error(`Existing legacy backup differs: ${target}`)
				}
			}
			const messages: Array<{ role: string; content: string; created_at: number }> = [
				{ role: "user", content: metadata.task, created_at: metadata.ts },
			]
			const events: Array<{ kind: string; payload: unknown }> = [
				{ kind: "legacy.turn", payload: { task_id: `${id}-turn-0`, prompt: metadata.task, user_index: 0 } },
			]
			let userIndex = 0
			for (const [index, row] of (rows as RecordValue[]).entries()) {
				events.push({ kind: "legacy.record", payload: row })
				if (typeof row.text !== "string" || !row.text) continue
				if (index === 0 && row.text === metadata.task) continue
				const user = row.type === "say" && row.say === "user_feedback"
				const assistant =
					row.type === "say" && ["text", "completion_result", "subtask_result"].includes(String(row.say))
				if (!user && !assistant) continue
				messages.push({
					role: user ? "user" : "assistant",
					content: row.text,
					created_at: typeof row.ts === "number" && Number.isFinite(row.ts) ? row.ts : metadata.ts,
				})
				if (user) {
					userIndex++
					events.push({
						kind: "legacy.turn",
						payload: { task_id: `${id}-turn-${userIndex}`, prompt: row.text, user_index: userIndex },
					})
				} else events.push({ kind: "text", payload: { text: row.text } })
			}
			if (messages.length > RECORD_LIMIT || events.length > RECORD_LIMIT)
				throw new Error(`Legacy import record limit exceeded: ${directory}`)
			result.found++
			const imported = await call("session.import_legacy", {
				id,
				source_key,
				source_hash,
				title: metadata.task,
				workspace: typeof metadata.workspace === "string" ? metadata.workspace : null,
				created_at: metadata.ts,
				updated_at: metadata.ts,
				messages,
				events,
			})
			if (!record(imported) || typeof imported.imported !== "boolean")
				throw new Error("Invalid legacy import response")
			if (imported.imported) result.imported++
			else result.skipped++
			result.backups.push(backup)
			onProgress?.({ found: result.found, imported: result.imported, skipped: result.skipped })
		}
	}
	return result
}
