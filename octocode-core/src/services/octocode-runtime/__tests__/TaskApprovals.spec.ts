import { TaskApprovals } from "../TaskApprovals"

describe("task approval lifecycle", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("binds a one-time decision to the active task and denies cancelled or expired requests", async () => {
		const answers: Array<(allowed: boolean) => void> = []
		const active = new Set(["one", "two"])
		const approvals = new TaskApprovals(
			() => new Promise<boolean>((resolve) => answers.push(resolve)),
			(task) => active.has(task.taskId),
		)
		const one = { taskId: "one", sessionId: "session-one" }
		const two = { taskId: "two", sessionId: "session-two" }
		const first = approvals.request(one, "write a.txt", { path: "a.txt" })
		const second = approvals.request(two, "write b.txt", { path: "b.txt" })
		approvals.cancel("one")
		answers[0](true)
		answers[1](true)
		expect(await first).toBe(false)
		expect(await second).toBe(true)

		const expired = approvals.request(two, "write c.txt", {})
		await vi.advanceTimersByTimeAsync(300_000)
		expect(await expired).toBe(false)
		answers[2](true)
		const stale = approvals.request(two, "write d.txt", {})
		active.delete("two")
		answers[3](true)
		expect(await stale).toBe(false)
		expect(await approvals.request(two, "inactive task", {})).toBe(false)
		expect(answers).toHaveLength(4)
	})

	it("denies a closed or failed UI and cancels all pending requests on disposal", async () => {
		const closed = new TaskApprovals(
			async () => false,
			() => true,
		)
		expect(await closed.request({ taskId: "one", sessionId: "s" }, "execute", {})).toBe(false)
		const failed = new TaskApprovals(
			async () => {
				throw new Error("UI closed")
			},
			() => true,
		)
		expect(await failed.request({ taskId: "one", sessionId: "s" }, "execute", {})).toBe(false)
		const pending = new TaskApprovals(
			() => new Promise(() => {}),
			() => true,
		)
		const result = pending.request({ taskId: "one", sessionId: "s" }, "execute", {})
		pending.dispose()
		expect(await result).toBe(false)
		expect(await pending.request({ taskId: "one", sessionId: "s" }, "execute", {})).toBe(false)
	})
})
