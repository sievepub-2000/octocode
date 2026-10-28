import { describe, expect, it } from "vitest"

import { appendRuntimeEvents, compactTranscriptEvents, describeRuntimeEvent } from "../runtimeEvent"

describe("describeRuntimeEvent", () => {
	it("shows a recoverable prefill memory error while preserving the server cause and original event", () => {
		const payload = {
			message: "server memory unavailable",
			error_code: "prefill_memory_exceeded",
			http_status: 400,
			recoverable: true,
		}
		const event = { kind: "error", payload }
		const rendered = describeRuntimeEvent(event)
		expect(rendered).toContain("prefill_memory_exceeded")
		expect(rendered).toContain("server memory unavailable")
		expect(rendered).toContain("conversation is preserved")
		expect(payload.error_code).toBe("prefill_memory_exceeded")
		expect(describeRuntimeEvent({ kind: "text", payload })).toBe("server memory unavailable")
	})
	it("preserves the first delta time without inventing a time for undated history", () => {
		const event = { task_id: "task", session_id: "session", kind: "text", payload: { data: "first" } }
		const later = { ...event, created_at: 2000, payload: { data: " second" } }
		expect(appendRuntimeEvents([{ ...event, created_at: 1000 }], [later])[0].created_at).toBe(1000)
		expect(appendRuntimeEvents([event], [later])[0].created_at).toBeUndefined()
		expect(
			compactTranscriptEvents([
				{ ...event, created_at: 1000, payload: { data: "<octo_thought>reason</octo_thought>answer" } },
			]).map((item) => item.created_at),
		).toEqual([1000, 1000])
	})
	it("shows the model error cause without turning cumulative usage into error text", () => {
		const cause = "reqwest error stream: error sending request for url (http://2.2.2.2:8000/v1/chat/completions)"
		const detail = { message: cause, promptUsage: { inputTokens: 2573154, outputTokens: 9644, modelCalls: 22 } }
		const payload = { message: `Internal error: ${JSON.stringify(detail)}` }
		for (const kind of ["error", "agent.error"]) {
			expect(describeRuntimeEvent({ kind, payload })).toBe(cause)
			expect(
				describeRuntimeEvent({ kind, payload: { message: `Internal error: ${JSON.stringify(cause)}` } }),
			).toBe(cause)
		}
		expect(JSON.parse(payload.message.slice("Internal error: ".length))).toEqual(detail)
		expect(describeRuntimeEvent({ kind: "error", payload: { message: cause } })).toBe(cause)
		expect(describeRuntimeEvent({ kind: "error", payload: { message: "Internal error: {invalid" } })).toBe(
			"Internal error: {invalid",
		)
		expect(describeRuntimeEvent({ kind: "text", payload })).toBe(payload.message)
	})
	it("coalesces live chunks without mutating prior state or losing usage and plan barriers", () => {
		const text = { task_id: "t", session_id: "s", kind: "text", payload: { data: "x" } }
		const first = [text]
		const joined = appendRuntimeEvents(
			first,
			Array.from({ length: 50000 }, () => text),
		)
		expect(first).toEqual([text])
		expect(joined).toHaveLength(1)
		expect(describeRuntimeEvent(joined[0])).toHaveLength(50001)
		const barrier = { ...text, kind: "usage", payload: { data: "usage" } }
		expect(appendRuntimeEvents(joined, [barrier, text]).map((event) => event.kind)).toEqual([
			"text",
			"usage",
			"text",
		])
	})
	it("does not join unrelated task streams or text across hidden tool boundaries", () => {
		const event = (task_id: string, kind: string, payload: unknown) => ({ task_id, session_id: "s", kind, payload })
		const rows = compactTranscriptEvents([
			event("a", "text", { data: "first answer" }),
			event("b", "text", { data: "second answer" }),
			event("b", "tool_call", { kind: "execute" }),
			event("b", "text", { data: "after command" }),
		])
		expect(rows.map((row) => describeRuntimeEvent(row))).toEqual(["first answer", "second answer", "after command"])
	})
	it("keeps compression and failures visible in the real transcript filter", () => {
		const kinds = [
			"auto_compact_started",
			"auto_compact_completed",
			"auto_compact_failed",
			"error",
			"agent.finished",
		]
		const events = kinds.map((kind) => ({
			task_id: "t",
			session_id: "s",
			kind,
			payload: { percentage: 90, error: "offline", success: false },
		}))
		expect(compactTranscriptEvents(events).map((event) => event.kind)).toEqual(kinds)
		expect(describeRuntimeEvent(events[0])).toContain("90%")
		expect(describeRuntimeEvent(events[2])).toContain("offline")
	})
	it("renders live text, tools and terminal status without losing fallback payloads", () => {
		expect(describeRuntimeEvent({ kind: "text", payload: { data: "hello" } })).toBe("hello")
		expect(describeRuntimeEvent({ kind: "user.message", payload: { text: "continue" } })).toBe("continue")
		expect(
			describeRuntimeEvent({
				kind: "tool_call",
				payload: { toolName: "run_terminal_cmd", status: "in_progress" },
			}),
		).toBe("run_terminal_cmd · in_progress")
		expect(describeRuntimeEvent({ kind: "custom", payload: { value: 1 } })).toContain('"value": 1')
	})

	it("keeps a user-input request visible with its question", () => {
		const transcript = compactTranscriptEvents([
			{
				task_id: "task",
				session_id: "session",
				kind: "agent.needs_input",
				payload: { status: "needs_input", question: "Which branch?", options: ["main"] },
			},
		])

		expect(transcript.map(({ kind }) => kind)).toEqual(["agent.needs_input"])
		expect(describeRuntimeEvent(transcript[0])).toBe("Which branch?")
	})

	it("compacts streaming text and keeps internal protocol events out of the chat transcript", () => {
		const event = (kind: string, payload: unknown) => ({ task_id: "task", session_id: "session", kind, payload })
		const compacted = compactTranscriptEvents([
			event("available_commands", { commands: ["test"] }),
			event("thought", { data: "Think" }),
			event("thought", { data: "ing" }),
			event("text", { data: "UI_SMOKE" }),
			event("text", { data: "_OK" }),
			event("usage", { input_tokens: 10 }),
			event("end", { stopReason: "end_turn" }),
			event("agent.finished", { success: true }),
		])

		expect(compacted.map(({ kind }) => kind)).toEqual(["thought", "text", "agent.finished"])
		expect(describeRuntimeEvent(compacted[0])).toBe("Thinking")
		expect(describeRuntimeEvent(compacted[1])).toBe("UI_SMOKE_OK")
	})

	it("keeps every model text stream in chat and excludes workbench and terminal events", () => {
		const event = (kind: string, payload: unknown) => ({ task_id: "task", session_id: "session", kind, payload })
		const events = [
			event("agent.started", { pid: 1 }),
			event("thought", { data: "<think>Plan" }),
			event("thought", { data: " carefully</think>" }),
			event("thought", { raw: { token: 42 } }),
			event("tool_call", { kind: "execute", toolName: "run_terminal_cmd", status: "in_progress" }),
			event("text", { data: "answer" }),
			event("usage", { input_tokens: 10 }),
		]
		const transcript = compactTranscriptEvents(events)

		expect(transcript.map(({ kind }) => kind)).toEqual(["thought", "text"])
		expect(describeRuntimeEvent(transcript[0])).toBe("Plan carefully")
		expect(describeRuntimeEvent(transcript[1])).toBe("answer")
		expect(transcript.some(({ kind }) => kind.startsWith("tool") || kind.startsWith("terminal"))).toBe(false)
	})

	it("keeps non-command execution summaries in chat but leaves commands to the terminal", () => {
		const event = (kind: string, payload: unknown) => ({ task_id: "task", session_id: "session", kind, payload })
		const transcript = compactTranscriptEvents([
			event("tool_call", { kind: "browser", toolName: "browser", status: "in_progress" }),
			event("tool_call", { kind: "execute", toolName: "run_terminal_cmd", status: "in_progress" }),
		])

		expect(transcript.map(({ kind }) => kind)).toEqual(["tool_call"])
		expect(describeRuntimeEvent(transcript[0])).toBe("browser · in_progress")
	})

	it("extracts a fragmented visible reasoning summary without leaking protocol tags", () => {
		const event = (payload: unknown) => ({
			task_id: "task",
			session_id: "session",
			kind: "text",
			payload,
		})
		const transcript = compactTranscriptEvents([
			event({ data: "<oct" }),
			event({ data: "o_thought>检查输入" }),
			event({ data: "并选择工具</octo_th" }),
			event({ data: "ought>最终答案" }),
		])

		expect(transcript.map(({ kind }) => kind)).toEqual(["thought", "text"])
		expect(describeRuntimeEvent(transcript[0])).toBe("检查输入并选择工具")
		expect(describeRuntimeEvent(transcript[1])).toBe("最终答案")
	})
})
