import { it, expect } from "vitest"
import { mkdtemp, writeFile, rm, readFile, mkdir, symlink, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAttachments, copyAttachmentsIntoSession, MAX_ATTACHMENT_BYTES } from "../attachments"

it("preserves original bytes and earlier turns with the same attachment name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "octocode-attachment-copies-"))
	try {
		const file = join(dir, "中文.pdf")
		const session = join(dir, "session")
		await writeFile(file, Buffer.from([0, 255, 42]))
		const [first] = await copyAttachmentsIntoSession([file], session)
		await writeFile(file, "second turn")
		const [second] = await copyAttachmentsIntoSession([file], session)
		expect(second).not.toBe(first)
		expect(await readFile(first)).toEqual(Buffer.from([0, 255, 42]))
		expect(await readFile(second, "utf8")).toBe("second turn")
		await expect(copyAttachmentsIntoSession(Array<string>(21).fill(file), session)).rejects.toThrow("20 个")
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

it("rejects an attachment directory redirected outside its session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "octocode-attachment-link-"))
	try {
		const session = join(dir, "session")
		const external = join(dir, "outside")
		await mkdir(session)
		await mkdir(external)
		await symlink(external, join(session, "attachments"), process.platform === "win32" ? "junction" : "dir")
		const file = join(dir, "document.txt")
		await writeFile(file, "private")
		await expect(copyAttachmentsIntoSession([file], session)).rejects.toThrow("附件目录")
		expect(await readdir(external)).toEqual([])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

it("reads Unicode text, labels truncation and rejects oversized or unsupported binary input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "octocode-attachments-"))
	try {
		const text = join(dir, "中文.txt")
		await writeFile(text, "附件内容\n".repeat(2200))
		const result = await readAttachments([text])
		expect(result).toContain("附件内容")
		expect(result).toContain('"truncated":true')
		await writeFile(text, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
		await expect(readAttachments([text])).rejects.toThrow("20 MB")
		const binary = join(dir, "data.bin")
		await writeFile(binary, Buffer.from([0, 255, 0, 254]))
		await expect(readAttachments([binary])).rejects.toThrow()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
