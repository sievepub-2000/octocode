import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import * as vscode from "vscode"
import { CodeIndexStateManager } from "./state-manager"
import type { IndexingState } from "./interfaces/manager"
import type { VectorStoreSearchResult } from "./interfaces/vector-store"
import { isPathInIgnoredDirectory } from "../glob/ignore-utils"

const execute = promisify(execFile)

interface NativeStatus {
	indexed: boolean
	files: number
	definitions: number
	references: number
}

interface NativeMatch {
	path: string
	line: number
	symbol: string
	score: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function isStatus(value: unknown): value is NativeStatus {
	return (
		isRecord(value) &&
		typeof value.indexed === "boolean" &&
		["files", "definitions", "references"].every(
			(key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
		)
	)
}

function isMatch(value: unknown): value is NativeMatch {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.symbol === "string" &&
		typeof value.score === "number" &&
		Number.isFinite(value.score) &&
		Number.isSafeInteger(value.line) &&
		Number(value.line) > 0
	)
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Local symbol/lexical index over the harness's existing .goto_index.bin. */
export class NativeCodeIndexProvider {
	private _state: IndexingState = "Standby"
	private binaryPath = ""
	private root = ""
	private initialized = false
	private build: Promise<void> | undefined
	private readonly requests = new Set<AbortController>()
	private stopped = false
	private watcher: vscode.FileSystemWatcher | undefined
	private refreshTimer: ReturnType<typeof setTimeout> | undefined
	private dirty = false

	constructor(
		private readonly workspacePath: string,
		private readonly context: Pick<vscode.ExtensionContext, "extensionPath">,
		private readonly stateManager: CodeIndexStateManager,
		private readonly limit = 20,
	) {}

	get state(): IndexingState {
		return this._state
	}

	private setState(state: IndexingState, message: string): void {
		this._state = state
		this.stateManager.setSystemState(state, message)
	}

	private showStatus(status: NativeStatus): void {
		this.setState(
			status.indexed ? "Indexed" : "Standby",
			status.indexed
				? `本机代码索引（符号/词法）：${status.files} 个文件，${status.definitions} 个定义`
				: "本机代码索引尚未建立",
		)
	}

	async initialize(): Promise<void> {
		if (this.initialized) return
		this.stopped = false
		try {
			this.root = await fs.realpath(this.workspacePath)
			const name = process.platform === "win32" ? "code-graph.exe" : "code-graph"
			this.binaryPath = path.join(this.context.extensionPath, "bin", `${process.platform}-${process.arch}`, name)
			await fs.access(this.binaryPath)
			const status = await this.run("status")
			if (!isStatus(status)) throw new Error("Invalid native index status")
			if (this.stopped) return
			this.initialized = true
			this.showStatus(status)
			this.watch()
		} catch (error) {
			this.fail(error)
			throw error
		}
	}

	/** Cold start loads a complete cache; explicit startIndexing rebuilds it. */
	async ensureIndex(): Promise<void> {
		await this.initialize()
		if (this.state !== "Indexed" && !this.stopped) await this.startIndexing()
	}

	async startIndexing(): Promise<void> {
		if (this.build) return this.build
		this.stopped = false
		this.watch()
		this.build = (async () => {
			do {
				this.dirty = false
				await this.rebuild()
			} while (this.dirty && !this.stopped)
		})()
		try {
			await this.build
		} finally {
			this.build = undefined
		}
	}

	private async rebuild(): Promise<void> {
		try {
			await this.initialize()
			if (this.stopped) return
			this.setState("Indexing", "正在建立本机代码索引（符号/词法，无网络）…")
			const status = await this.run("index")
			if (!isStatus(status) || !status.indexed) throw new Error("Native index did not finish")
			if (!this.stopped) this.showStatus(status)
		} catch (error) {
			if (!this.stopped) {
				this.fail(error)
				throw error
			}
		}
	}

	stopIndexing(): void {
		this.stopped = true
		this.watcher?.dispose()
		this.watcher = undefined
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = undefined
		for (const request of this.requests) request.abort()
		this.setState("Standby", "本机代码索引已停止，已保存索引保留")
	}

	async clearIndexData(): Promise<void> {
		this.stopIndexing()
		await this.build
		this.stopped = false
		try {
			await this.initialize()
			const status = await this.run("clear")
			if (!isStatus(status) || status.indexed) throw new Error("Native index was not cleared")
			this.showStatus(status)
		} catch (error) {
			this.fail(error)
			throw error
		}
	}

	async searchIndex(query: string, directoryPrefix?: string, limit = this.limit): Promise<VectorStoreSearchResult[]> {
		if (this.stopped || this.state !== "Indexed" || !query.trim()) return []
		const arguments_ = ["--query", query, "--limit", String(limit)]
		if (directoryPrefix) {
			const directory = await fs.realpath(path.resolve(this.root, directoryPrefix))
			if (!within(this.root, directory)) throw new Error("Search directory is outside the workspace")
			arguments_.push("--directory", directory)
		}
		try {
			const output = await this.run("search", arguments_)
			if (!isRecord(output) || !Array.isArray(output.results) || !output.results.every(isMatch)) {
				throw new Error("Invalid native index search response")
			}
			const results: VectorStoreSearchResult[] = []
			for (const match of output.results) {
				const candidate = path.resolve(this.root, match.path)
				if (!within(this.root, candidate)) continue
				// Read source only from the current project, after checking real paths.
				try {
					const real = await fs.realpath(candidate)
					if (!within(this.root, real) || (await fs.lstat(candidate)).isSymbolicLink()) continue
					const metadata = await fs.stat(real)
					if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) continue
					const lines = (await fs.readFile(real, "utf8")).split(/\r?\n/)
					const startLine = Math.max(1, match.line - 3)
					const endLine = Math.min(lines.length, match.line + 8)
					if (match.line > lines.length) continue
					results.push({
						id: `${match.path}:${match.line}:${match.symbol}`,
						score: match.score,
						payload: {
							filePath: real,
							codeChunk: lines.slice(startLine - 1, endLine).join("\n"),
							startLine,
							endLine,
							matchType: "lexical-symbols",
							symbol: match.symbol,
						},
					})
				} catch (error) {
					if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue
					throw error
				}
			}
			return this.stopped ? [] : results
		} catch (error) {
			if (this.stopped) return []
			this.fail(error)
			throw error
		}
	}

	private async run(operation: "index" | "status" | "search" | "clear", arguments_: string[] = []): Promise<unknown> {
		const request = new AbortController()
		this.requests.add(request)
		try {
			const { stdout } = await execute(this.binaryPath, ["machine", operation, this.root, ...arguments_], {
				cwd: this.root,
				windowsHide: true,
				encoding: "utf8",
				signal: request.signal,
				timeout: 10 * 60 * 1000,
				maxBuffer: 4 * 1024 * 1024,
			})
			return JSON.parse(stdout) as unknown
		} finally {
			this.requests.delete(request)
		}
	}

	private fail(error: unknown): void {
		if (!this.stopped)
			this.setState("Error", `本机代码索引失败：${error instanceof Error ? error.message : String(error)}`)
	}

	private watch(): void {
		if (this.watcher || this.stopped) return
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.workspacePath, "**/*"))
		const changed = (uri: vscode.Uri) => {
			const relative = path.relative(this.workspacePath, uri.fsPath)
			if (!within(this.workspacePath, uri.fsPath)) return
			if (relative !== ".gitignore" && relative !== ".rooignore" && isPathInIgnoredDirectory(relative)) return
			this.dirty = true
			if (this.refreshTimer) clearTimeout(this.refreshTimer)
			this.refreshTimer = setTimeout(() => {
				this.refreshTimer = undefined
				void this.startIndexing().catch(() => {
					/* rebuild already publishes its error state */
				})
			}, 500)
		}
		this.watcher.onDidCreate(changed)
		this.watcher.onDidChange(changed)
		this.watcher.onDidDelete(changed)
	}

	dispose(): void {
		this.stopIndexing()
	}
}
