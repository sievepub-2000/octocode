import { describe, expect, it } from "vitest"
import { appendRuntimeEvents, compactTranscriptEvents, describeRuntimeEvent } from "../runtimeEvent"

const text = (data: string, created_at: number) => ({
	task_id: "task",
	session_id: "session",
	kind: "text",
	payload: { data },
	created_at,
})

describe("visible text stage timestamps", () => {
	it("uses each visible stage's first source chunk across fragmented tags", () => {
		const events = [
			text("<oc", 1000),
			text("to_thought>thinking", 2000),
			text("</octo_th", 3000),
			text("ought>", 4000),
			text("answer", 5000),
		]
		const blocks = compactTranscriptEvents(appendRuntimeEvents([], events))
		expect(blocks.map((event) => [event.kind, describeRuntimeEvent(event), event.created_at])).toEqual([
			["thought", "thinking", 2000],
			["text", "answer", 5000],
		])
	})

	it("keeps offsets in JavaScript characters across emoji and repeated stages", () => {
		const events = [
			text("🙂 introduction", 1000),
			text("<octo_thought>", 2000),
			text("reason", 3000),
			text("</octo_thought>😊 answer", 4000),
			text(" continued", 5000),
			text("<octo_thought>next</octo_thought>revision", 6000),
		]
		const blocks = compactTranscriptEvents(appendRuntimeEvents([], events))
		expect(blocks.map((event) => [event.kind, describeRuntimeEvent(event), event.created_at])).toEqual([
			["text", "🙂 introduction", 1000],
			["thought", "reason", 3000],
			["text", "😊 answer continued", 4000],
			["thought", "next", 6000],
			["text", "revision", 6000],
		])
	})

	it("shares a source time only when both stages actually arrive in the same chunk", () => {
		expect(
			compactTranscriptEvents([text("<octo_thought>reason</octo_thought>answer", 7000)]).map(
				(event) => event.created_at,
			),
		).toEqual([7000, 7000])
	})

	it("waits for visible answer content after a standalone closing delimiter", () => {
		const prefix = [text("<octo_thought>reason", 1000), text("</octo_thought>", 2000), text("\n\n", 3000)]
		expect(compactTranscriptEvents(prefix).map((event) => [event.kind, event.created_at])).toEqual([
			["thought", 1000],
		])
		const blocks = compactTranscriptEvents([...prefix, text("answer", 4000), text(" continues", 5000)])
		expect(blocks.map((event) => [event.kind, event.created_at])).toEqual([
			["thought", 1000],
			["text", 4000],
		])
	})

	it("still combines ordinary tokens into one event with a stable first time", () => {
		const combined = appendRuntimeEvents(
			[],
			Array.from({ length: 10_000 }, (_, index) => text("a", index + 1)),
		)
		expect(combined).toHaveLength(1)
		expect(combined[0].created_at).toBe(1)
		expect(describeRuntimeEvent(combined[0])).toHaveLength(10_000)
	})

	it("does not combine text across hidden execution updates", () => {
		const events = [
			text("before", 1000),
			{ ...text("", 2000), kind: "tool_call_update", payload: null },
			text("after", 3000),
		]
		expect(compactTranscriptEvents(events).map((event) => [describeRuntimeEvent(event), event.created_at])).toEqual(
			[
				["before", 1000],
				["after", 3000],
			],
		)
	})
})
