type RuntimeReader = { call<T>(method: string, params: unknown): Promise<T> }

/** Failure to prove absence must leave handoff cleanup to its conservative error path. */
export async function hasRuntimeEvent(
	runtime: RuntimeReader,
	sessionId: string,
	kind: string,
	maxPages = 10_000,
): Promise<boolean> {
	if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("Invalid event existence page budget")
	let after = 0
	for (let count = 0; count < maxPages; count++) {
		const page = await runtime.call<unknown>("event.page", {
			session_id: sessionId,
			after,
			limit: 2000,
			presentation: false,
		})
		const invalid = () => new Error("Invalid event existence page")
		if (!page || typeof page !== "object" || Array.isArray(page)) throw invalid()
		const { rows, next, has_more: hasMore } = page as Record<string, unknown>
		if (
			!Array.isArray(rows) ||
			rows.length > 2000 ||
			typeof hasMore !== "boolean" ||
			typeof next !== "number" ||
			!Number.isSafeInteger(next) ||
			next < after ||
			(hasMore && (rows.length === 0 || next === after))
		)
			throw invalid()
		let previous = after
		let found = false
		for (const row of rows) {
			if (
				!Array.isArray(row) ||
				row.length !== 3 ||
				typeof row[0] !== "number" ||
				!Number.isSafeInteger(row[0]) ||
				row[0] <= previous ||
				row[0] > next ||
				typeof row[1] !== "string"
			)
				throw invalid()
			previous = row[0]
			if (row[1] === kind) found = true
		}
		if (previous !== next) throw invalid()
		if (found) return true
		if (!hasMore) return false
		after = next
	}
	throw new Error("Event existence page budget exhausted")
}
