export type ApprovalTask = { taskId: string; sessionId: string }
type AskApproval = (task: ApprovalTask, title: string, details: unknown) => Promise<boolean>

/** One decision authorizes one pending invocation; it never changes a saved permission profile. */
export class TaskApprovals {
	private readonly pending = new Map<symbol, { taskId: string; finish: (allowed: boolean) => void }>()
	private disposed = false

	constructor(
		private readonly ask: AskApproval,
		private readonly isActive: (task: ApprovalTask) => boolean,
	) {}

	request(task: ApprovalTask, title: string, details: unknown): Promise<boolean> {
		if (this.disposed || !this.isActive(task)) return Promise.resolve(false)
		const identity = { taskId: task.taskId, sessionId: task.sessionId }
		return new Promise((resolve) => {
			const id = Symbol()
			const finish = (allowed: boolean) => {
				if (!this.pending.delete(id)) return
				clearTimeout(timer)
				resolve(allowed === true && !this.disposed && this.isActive(identity))
			}
			const timer = setTimeout(() => finish(false), 300_000)
			timer.unref?.()
			this.pending.set(id, { taskId: identity.taskId, finish })
			try {
				void this.ask(identity, title, details).then(finish, () => finish(false))
			} catch {
				finish(false)
			}
		})
	}

	cancel(taskId: string): void {
		for (const pending of this.pending.values()) if (pending.taskId === taskId) pending.finish(false)
	}

	dispose(): void {
		this.disposed = true
		for (const pending of this.pending.values()) pending.finish(false)
	}
}
