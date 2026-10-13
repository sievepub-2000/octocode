import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { hasRuntimeEvent } from "../runtimeEventExists"

// Execute the real narrow cleanup branch, with owned RPC responses. This is a
// consumer contract test, not native dispatch or extension/UI execution.
const source = fs.readFileSync(path.join(__dirname, "../ClineProvider.ts"), "utf8")
const start = source.indexOf("\t\t\tif (handoff) {", source.indexOf("handoff = task"))
const end = source.indexOf('\t\t\tawait notify("runtime.rollover_failed"', start)
if (start < 0 || end <= start) throw new Error("Handoff cleanup branch not found")
const block = source
	.slice(start, end)
	.replace(/runtime\.call<[^\n]+?>/g, "runtime.call")
	.replace("this.log(", "log(")
const cleanup = new Function("handoff", "runtime", "hasRuntimeEvent", "log", `return (async()=>{${block}})()`)

describe("guarded handoff cleanup consumer", () => {
	it.each([true, false, undefined, "true", new Error("owned DB failure")])(
		"preserves settings unless native deletion succeeds: %s",
		async (deleted) => {
			const calls: Array<{ method: string; params: unknown }> = []
			const logs: string[] = []
			const runtime = {
				call: async (method: string, params: unknown) => {
					calls.push({ method, params })
					if (method === "session.get") return { status: "prepared" }
					if (method === "event.page") return { rows: [], next: 0, has_more: false }
					if (deleted instanceof Error) throw deleted
					return { deleted }
				},
			}
			await cleanup({ sessionId: "owned", taskId: "owned-task" }, runtime, hasRuntimeEvent, (text: string) =>
				logs.push(text),
			)
			expect(calls.map((call) => call.method)).toEqual(["session.get", "event.page", "session.delete"])
			expect(calls[2].params).toEqual({ id: "owned", expected_unstarted_task: "owned-task" })
			expect(logs).toHaveLength(deleted === true ? 0 : 1)
		},
	)
})
