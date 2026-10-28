/** Runtime Host contracts shared by the extension and every task view. */
export type RuntimeTask = { sessionId: string; taskId: string }

/** Client handoff correlation. An unknown source cannot select a task view. */
export type RuntimeHandoff = { source?: RuntimeTask; target?: RuntimeTask }

export type RuntimeSession = {
	id: string
	title: string
	status: string
	workspace?: string | null
	project_id?: string | null
	model?: string | null
	created_at?: number
	updated_at: number
}

export type RuntimeEvent = {
	task_id: string
	session_id: string
	kind: string
	payload: unknown
	/** Persisted event time in milliseconds since the Unix epoch. Older undated events omit it. */
	created_at?: number
}

export type RuntimePlanEntry = { content: string; status: string }

export type RuntimeProject = {
	id: string
	name: string
	workspace: string
	directory: string
	created_at: number
}
