import type { RuntimeEvent } from "@roo-code/types"
export type { RuntimeEvent } from "@roo-code/types"

const eventText = (payload: unknown): string => {
	if (typeof payload === "string") return payload
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return ""
	const value = payload as Record<string, unknown>
	for (const key of ["text", "data", "message", "title", "question"] as const) {
		if (typeof value[key] === "string") return value[key]
	}
	return ""
}

const stripThoughtProtocolTags = (text: string): string =>
	text.replace(/<\/?(?:think|thought|analysis|reasoning)\b[^>]*>/gi, "")

const CHAT_EVENT_KINDS = new Set([
	"user.message",
	"thought",
	"text",
	"agent.needs_input",
	"agent.finished",
	"agent.error",
	"error",
	"auto_compact_started",
	"auto_compact_completed",
	"auto_compact_failed",
	"auto_compact_cancelled",
])
export const isTranscriptEvent = ({ kind, payload }: Pick<RuntimeEvent, "kind" | "payload">): boolean => {
	if (CHAT_EVENT_KINDS.has(kind)) return true
	if (kind !== "tool_call" || !payload || typeof payload !== "object" || Array.isArray(payload)) return false
	return (payload as Record<string, unknown>).kind !== "execute"
}

type TextPart = { end: number; created_at?: number }

const splitVisibleThought = (event: RuntimeEvent, parts: TextPart[]): RuntimeEvent[] => {
	if (event.kind !== "text") return [event]
	const text = eventText(event.payload)
	const lower = text.toLowerCase()
	const opening = "<octo_thought>"
	const closing = "</octo_thought>"
	const result: RuntimeEvent[] = []
	const visible = (kind: string, start: number, data: string): void => {
		const first = data.search(/\S/)
		if (first < 0) return
		const created_at = parts.find((part) => part.end > start + first)?.created_at
		result.push({ ...event, kind, created_at, payload: { data: kind === "thought" ? data.trim() : data } })
	}
	let cursor = 0
	while (cursor < text.length) {
		const start = lower.indexOf(opening, cursor)
		if (start < 0) {
			visible("text", cursor, text.slice(cursor))
			break
		}
		if (start > cursor) visible("text", cursor, text.slice(cursor, start))
		const contentStart = start + opening.length
		const end = lower.indexOf(closing, contentStart)
		visible("thought", contentStart, text.slice(contentStart, end < 0 ? text.length : end))
		if (end < 0) break
		cursor = end + closing.length
	}
	return result
}

export const appendRuntimeEvents = (previousEvents: RuntimeEvent[], events: RuntimeEvent[]): RuntimeEvent[] => {
	const compacted = [...previousEvents]
	for (const event of events) {
		const previous = compacted.at(-1)
		const oldText = previous ? eventText(previous.payload) : ""
		const newText = eventText(event.payload)
		if (
			previous?.kind === event.kind &&
			previous.task_id === event.task_id &&
			previous.session_id === event.session_id &&
			(event.kind === "text" || event.kind === "thought") &&
			// Keep only tag-adjacent chunk boundaries; ordinary streamed tokens still coalesce.
			(event.kind !== "text" ||
				(!oldText.includes("<") &&
					!newText.includes("<") &&
					!oldText.endsWith(">") &&
					(oldText.trim().length > 0 || newText.trim().length === 0)))
		) {
			compacted[compacted.length - 1] = {
				...event,
				created_at: previous.created_at,
				payload: { data: oldText + newText },
			}
		} else {
			compacted.push(event)
		}
	}
	return compacted
}

export const compactTranscriptEvents = (events: RuntimeEvent[]): RuntimeEvent[] => {
	const source = appendRuntimeEvents([], events)
	const result: RuntimeEvent[] = []
	for (let index = 0; index < source.length; index++) {
		const event = source[index]
		if (event.kind !== "text") {
			if (isTranscriptEvent(event)) result.push(event)
			continue
		}
		const chunks: string[] = []
		const parts: TextPart[] = []
		let length = 0
		let next = event
		for (;;) {
			const data = eventText(next.payload)
			chunks.push(data)
			length += data.length
			parts.push({ end: length, created_at: next.created_at })
			const following = source[index + 1]
			if (
				following?.kind !== "text" ||
				following.task_id !== event.task_id ||
				following.session_id !== event.session_id
			)
				break
			next = following
			index++
		}
		result.push(...splitVisibleThought({ ...event, payload: { data: chunks.join("") } }, parts))
	}
	return result
}

export const describeRuntimeEvent = (
	{ kind, payload }: Pick<RuntimeEvent, "kind" | "payload">,
	labels: { completed?: string; stopped?: string; unknown?: string; prefillMemory?: string } = {},
): string => {
	if (kind === "thought") return stripThoughtProtocolTags(eventText(payload))
	if (!payload || typeof payload !== "object") return String(payload ?? "")
	const value = payload as Record<string, unknown>
	if ((kind === "error" || kind === "agent.error") && value.error_code === "prefill_memory_exceeded") {
		const cause = describeRuntimeEvent({ kind, payload: { message: value.message } }, labels)
		return `[prefill_memory_exceeded] ${cause}\n${labels.prefillMemory ?? "The model server has insufficient prefill memory. This conversation is preserved; retry here after server memory is available."}`
	}
	if (kind === "auto_compact_started") return `正在压缩上下文（${value.percentage ?? "—"}%）`
	if (kind === "auto_compact_completed") return "上下文压缩完成，继续执行当前任务。"
	if (kind === "auto_compact_failed") return `上下文压缩失败：${String(value.error ?? "未知错误")}`
	if (kind === "auto_compact_cancelled") return "上下文压缩已取消。"
	if (typeof value.text === "string") return value.text
	if (typeof value.data === "string") return value.data
	if (typeof value.message === "string") {
		if ((kind === "error" || kind === "agent.error") && value.message.startsWith("Internal error: ")) {
			try {
				const detail: unknown = JSON.parse(value.message.slice("Internal error: ".length))
				if (typeof detail === "string" && detail.trim()) return detail
				if (
					detail &&
					typeof detail === "object" &&
					"message" in detail &&
					typeof detail.message === "string" &&
					detail.message.trim()
				)
					return detail.message
			} catch {
				// Keep unrecognized errors intact; usage remains in the original event payload.
			}
		}
		return value.message
	}
	if (typeof value.question === "string") return value.question
	if (typeof value.title === "string") return value.title
	if (typeof value.toolName === "string") return `${value.toolName}${value.status ? ` · ${value.status}` : ""}`
	if (kind === "agent.finished") {
		return value.success
			? (labels.completed ?? "Completed")
			: `${labels.stopped ?? "Stopped"} · ${value.exit_code ?? labels.unknown ?? "unknown"}`
	}
	return JSON.stringify(payload, null, 2)
}
