import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

/** Per-session workspace references to globally installed tools, never tool installations. */
export class ProjectToolCopies {
	private sessionDirectory?: Promise<string>
	private workspaceRoot?: string

	constructor(private readonly workspaceDirectory?: string) {}

	async record(kind: "skill" | "mcp" | "plugin", name: string, globalPath: string): Promise<string | undefined> {
		if (!this.workspaceDirectory) return undefined
		if (!this.sessionDirectory) {
			this.sessionDirectory = (async () => {
				const workspace = await fs.realpath(this.workspaceDirectory!)
				this.workspaceRoot = workspace
				const insideWorkspace = (candidate: string) => {
					const relative = path.relative(workspace, candidate)
					return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
				}
				const metadata = path.join(workspace, ".octocode")
				await fs.mkdir(metadata, { recursive: true })
				if (!insideWorkspace(await fs.realpath(metadata)))
					throw new Error("Tool copy path leaves the workspace")
				const parent = path.join(await fs.realpath(metadata), "tool-copies")
				await fs.mkdir(parent, { recursive: true })
				const realParent = await fs.realpath(parent)
				if (!insideWorkspace(realParent)) throw new Error("Tool copy path leaves the workspace")
				return fs.mkdtemp(path.join(realParent, "session-"))
			})()
		}
		const key = createHash("sha256").update(`${kind}:${name}`).digest("hex").slice(0, 16)
		const session = await this.sessionDirectory
		await this.assertUnchangedPath(session)
		const kindDirectory = path.join(session, kind)
		await fs.mkdir(kindDirectory, { recursive: true })
		await this.assertUnchangedPath(kindDirectory)
		const directory = path.join(kindDirectory, key)
		await fs.mkdir(directory, { recursive: true })
		await this.assertUnchangedPath(directory)
		const data = path.join(directory, "data")
		await fs.mkdir(data, { recursive: true })
		await this.assertUnchangedPath(data)
		try {
			await fs.writeFile(path.join(directory, "config.json"), "{}\n", { flag: "wx" })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		}
		await fs.writeFile(path.join(directory, "reference.json"), JSON.stringify({ kind, name, globalPath }), "utf8")
		return directory
	}

	async dispose(): Promise<void> {
		if (this.sessionDirectory) {
			const directory = await this.sessionDirectory
			try {
				await this.assertUnchangedPath(directory)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				this.sessionDirectory = undefined
				return
			}
			await fs.rm(directory, { recursive: true, force: true })
			this.sessionDirectory = undefined
		}
	}

	private async assertUnchangedPath(directory: string): Promise<void> {
		const resolved = await fs.realpath(directory)
		const relative = path.relative(this.workspaceRoot!, resolved)
		if (
			path.relative(directory, resolved) !== "" ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			throw new Error("Tool copy path changed or leaves the workspace")
	}
}
