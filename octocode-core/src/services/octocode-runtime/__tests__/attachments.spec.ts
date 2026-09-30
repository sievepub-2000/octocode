import { it, expect } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAttachments, MAX_ATTACHMENT_BYTES } from "../attachments"

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
