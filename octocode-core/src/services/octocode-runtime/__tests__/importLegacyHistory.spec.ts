import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { importLegacyHistory } from "../importLegacyHistory"

describe("legacy history conversion boundary", () => {
	it("preserves raw records and sources, emits stable canonical turns and backs up before idempotent RPC", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-import-"))
		try {
			const directory = path.join(root, "source", "tasks", "123")
			await fs.mkdir(directory, { recursive: true })
			const original = JSON.stringify([
				{ ts: 1, type: "say", say: "text", text: "goal" },
				{ ts: 2, type: "say", say: "text", text: "answer" },
				{ ts: 3, type: "say", say: "user_feedback", text: "next" },
				{ ts: 4, type: "ask", ask: "tool", text: "never execute" },
			])
			await fs.writeFile(
				path.join(directory, "history_item.json"),
				JSON.stringify({ id: "123", ts: 1, task: "goal" }),
			)
			await fs.writeFile(path.join(directory, "ui_messages.json"), original)
			const call = vi.fn().mockResolvedValueOnce({ imported: true }).mockResolvedValueOnce({ imported: false })
			const options = { sourceRoots: [path.join(root, "source")], backupRoot: path.join(root, "backup"), call }
			const first = await importLegacyHistory(options)
			const second = await importLegacyHistory(options)
			expect(first.imported).toBe(1)
			expect(second.skipped).toBe(1)
			expect(call.mock.calls[0]).toEqual(call.mock.calls[1])
			const payload = call.mock.calls[0][1]
			expect(
				payload.messages.map((message: { role: string; content: string }) => [message.role, message.content]),
			).toEqual([
				["user", "goal"],
				["assistant", "answer"],
				["user", "next"],
			])
			expect(
				payload.events
					.filter((event: { kind: string }) => event.kind === "legacy.turn")
					.map((event: { payload: { user_index: number } }) => event.payload.user_index),
			).toEqual([0, 1])
			expect(payload.events.filter((event: { kind: string }) => event.kind === "legacy.record")).toHaveLength(4)
			expect(await fs.readFile(path.join(first.backups[0], "ui_messages.json"), "utf8")).toBe(original)
			expect(await fs.readFile(path.join(directory, "ui_messages.json"), "utf8")).toBe(original)
			await fs.writeFile(
				path.join(directory, "history_item.json"),
				JSON.stringify({ id: "../escape", ts: 1, task: "goal" }),
			)
			await expect(importLegacyHistory(options)).rejects.toThrow("Invalid legacy metadata")
			expect(call).toHaveBeenCalledTimes(2)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
