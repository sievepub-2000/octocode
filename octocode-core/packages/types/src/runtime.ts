/** Runtime Host contracts shared by the extension and every task view. */
export type RuntimeTask = { sessionId: string; taskId: string }

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
}

export type RuntimePlanEntry = { content: string; status: string }

export type RuntimeProject = {
	id: string
	name: string
	workspace: string
	directory: string
	created_at: number
}
