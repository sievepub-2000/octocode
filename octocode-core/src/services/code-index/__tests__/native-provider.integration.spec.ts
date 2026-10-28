import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NativeCodeIndexProvider } from "../native-provider"
import { CodeIndexStateManager } from "../state-manager"

const watch = vi.hoisted(() => ({ change: vi.fn(), dispose: vi.fn() }))

vi.mock("vscode", () => ({
	RelativePattern: class {
		constructor(
			public base: string,
			public pattern: string,
		) {}
	},
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidCreate: vi.fn(),
			onDidChange: watch.change,
			onDidDelete: vi.fn(),
			dispose: watch.dispose,
		})),
	},
}))

// Explicitly enabled by release validation with the actual newly built binary.
describe.skipIf(!process.env.OCTOCODE_TEST_CODE_GRAPH_PATH)("native provider actual process lifecycle", () => {
	let fixture: string
	let extensionPath: string
	const providers: NativeCodeIndexProvider[] = []
	const provider = (workspace: string) => {
		const instance = new NativeCodeIndexProvider(workspace, { extensionPath }, new CodeIndexStateManager())
		providers.push(instance)
		return instance
	}

	beforeAll(async () => {
		fixture = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-native-index-"))
		extensionPath = path.join(fixture, "extension")
		const bin = path.join(extensionPath, "bin", `${process.platform}-${process.arch}`)
		await fs.mkdir(bin, { recursive: true })
		const name = process.platform === "win32" ? "code-graph.exe" : "code-graph"
		await fs.copyFile(process.env.OCTOCODE_TEST_CODE_GRAPH_PATH!, path.join(bin, name))
		if (process.platform !== "win32") await fs.chmod(path.join(bin, name), 0o700)
	})

	afterAll(async () => {
		for (const instance of providers) instance.dispose()
		await fs.rm(fixture, { recursive: true, force: true })
	})

	it("builds, reads, watches edits, reloads, separates projects, stops and clears", async () => {
		const first = path.join(fixture, "project-a")
		const second = path.join(fixture, "project-b")
		await fs.mkdir(first)
		await fs.mkdir(second)
		await fs.writeFile(path.join(first, "main.rs"), "pub fn projectAlpha() {}\n")
		await fs.writeFile(path.join(second, "main.rs"), "pub fn projectBeta() {}\n")
		await fs.writeFile(path.join(first, ".secret.rs"), "pub fn hiddenSecret() {}\n")
		await fs.symlink(second, path.join(first, "external"), process.platform === "win32" ? "junction" : "dir")
		const a = provider(first)
		await a.ensureIndex()
		expect(a.state).toBe("Indexed")
		const found = await a.searchIndex("PROJECTALPHA")
		expect(found).toHaveLength(1)
		expect(found[0].payload).toMatchObject({ symbol: "projectAlpha", matchType: "lexical-symbols", startLine: 1 })
		expect(found[0].payload?.codeChunk).toContain("pub fn projectAlpha")
		expect(await a.searchIndex("hiddenSecret")).toEqual([])
		expect(await a.searchIndex("projectBeta")).toEqual([])
		await expect(a.searchIndex("projectAlpha", second)).rejects.toThrow("outside the workspace")
		const originalCache = await fs.stat(path.join(first, ".goto_index.bin"))
		a.dispose()
		const loaded = provider(first)
		await loaded.ensureIndex()
		expect(await loaded.searchIndex("projectAlpha")).toHaveLength(1)
		expect((await fs.stat(path.join(first, ".goto_index.bin"))).mtimeMs).toBe(originalCache.mtimeMs)
		const b = provider(second)
		await b.ensureIndex()
		expect(await b.searchIndex("projectAlpha")).toEqual([])
		expect(await loaded.searchIndex("projectBeta")).toEqual([])
		await fs.writeFile(path.join(first, "main.rs"), "pub fn projectEdited() {}\n")
		const change = watch.change.mock.calls.at(-2)?.[0]
		expect(change).toBeTypeOf("function")
		change({ fsPath: path.join(first, "main.rs") })
		await vi.waitFor(async () => expect(await loaded.searchIndex("projectEdited")).toHaveLength(1), {
			timeout: 15000,
			interval: 100,
		})
		expect(await loaded.searchIndex("projectAlpha")).toEqual([])
		loaded.stopIndexing()
		expect(await loaded.searchIndex("projectEdited")).toEqual([])
		expect((await fs.stat(path.join(first, ".goto_index.bin"))).isFile()).toBe(true)
		await loaded.clearIndexData()
		await expect(fs.stat(path.join(first, ".goto_index.bin"))).rejects.toMatchObject({ code: "ENOENT" })
		expect(await loaded.searchIndex("projectEdited")).toEqual([])
		expect(await b.searchIndex("projectBeta")).toHaveLength(1)
		await b.clearIndexData()
	}, 45000)
})
