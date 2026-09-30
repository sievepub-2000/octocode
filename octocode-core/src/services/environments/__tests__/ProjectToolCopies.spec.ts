import { afterEach, expect, it } from "vitest"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ProjectToolCopies } from "../ProjectToolCopies"

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

it("isolates lightweight tool references by project session and removes only its own copy", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-tool-copies-"))
	roots.push(root)
	const first = new ProjectToolCopies(root)
	const second = new ProjectToolCopies(root)
	const firstCopy = await first.record("mcp", "shared", "/global/mcp.json")
	const secondCopy = await second.record("mcp", "shared", "/global/mcp.json")
	const third = new ProjectToolCopies(root)
	const [concurrentA, concurrentB] = await Promise.all([
		third.record("skill", "alpha", "/global/alpha/SKILL.md"),
		third.record("skill", "beta", "/global/beta/SKILL.md"),
	])
	expect(path.dirname(path.dirname(concurrentA!))).toBe(path.dirname(path.dirname(concurrentB!)))
	expect(firstCopy).not.toBe(secondCopy)
	expect(JSON.parse(await fs.readFile(path.join(firstCopy!, "reference.json"), "utf8"))).toEqual({
		kind: "mcp",
		name: "shared",
		globalPath: "/global/mcp.json",
	})
	expect(await fs.readFile(path.join(firstCopy!, "config.json"), "utf8")).toBe("{}\n")
	expect((await fs.stat(path.join(firstCopy!, "data"))).isDirectory()).toBe(true)
	await first.dispose()
	await expect(fs.access(firstCopy!)).rejects.toThrow()
	await expect(fs.access(secondCopy!)).resolves.toBeUndefined()
	await second.dispose()
	await third.dispose()
})

it("rejects a linked tool-copy directory before creating files outside the workspace", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-workspace-"))
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-outside-"))
	roots.push(workspace, outside)
	const link = path.join(workspace, ".octocode")
	await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
	try {
		await expect(new ProjectToolCopies(workspace).record("mcp", "shared", "/global/mcp.json")).rejects.toThrow(
			"Tool copy path leaves the workspace",
		)
		await expect(fs.access(path.join(outside, "tool-copies"))).rejects.toMatchObject({ code: "ENOENT" })
	} finally {
		await fs.unlink(link)
	}
})

it("does not write or remove outside data when its parent is replaced after creation", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-workspace-"))
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-outside-"))
	roots.push(workspace, outside)
	const copies = new ProjectToolCopies(workspace)
	const copy = (await copies.record("mcp", "shared", "/global/mcp.json"))!
	const session = path.dirname(path.dirname(copy))
	const parent = path.dirname(session)
	const preserved = `${parent}-original`
	await fs.rename(parent, preserved)
	const externalSession = path.join(outside, path.basename(session))
	await fs.mkdir(externalSession)
	await fs.writeFile(path.join(externalSession, "keep.txt"), "user data")
	await fs.symlink(outside, parent, process.platform === "win32" ? "junction" : "dir")
	try {
		await expect(copies.record("skill", "next", "/global/SKILL.md")).rejects.toThrow("Tool copy path")
		await expect(copies.dispose()).rejects.toThrow("Tool copy path")
		expect(await fs.readFile(path.join(externalSession, "keep.txt"), "utf8")).toBe("user data")
		expect(await fs.readdir(externalSession)).toEqual(["keep.txt"])
	} finally {
		await fs.unlink(parent)
		await fs.rename(preserved, parent)
		await copies.dispose()
	}
})
