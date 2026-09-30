type EventRow = [number, string, unknown]
type EventPage = { rows: EventRow[]; next: number; has_more: boolean }
type RuntimeReader = { call<T>(method: string, params: unknown): Promise<T> }

export async function* readEventPages(
	runtime: RuntimeReader,
	sessionId: string,
	after = 0,
	presentation = false,
): AsyncGenerator<EventRow[]> {
	for (;;) {
		const page = await runtime.call<EventPage>("event.page", {
			session_id: sessionId,
			after,
			limit: 2000,
			presentation,
		})
		if (
			!Array.isArray(page.rows) ||
			!Number.isSafeInteger(page.next) ||
			page.next < after ||
			(page.has_more && page.next === after)
		)
			throw new Error("Invalid history cursor")
		yield page.rows
		if (!page.has_more) return
		after = page.next
	}
}
