import { describe, expect, it, vi } from "vitest"
import { OctoCodeRuntime } from "../OctoCodeRuntime"
import { EventEmitter } from "node:events"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("runtime queue", () => {
	it("copies queued attachments before steering an active task", async () => {
		const directory = await mkdtemp(join(tmpdir(), "octocode-steer-attachments-"))
		try {
			const source = join(directory, "document.pdf")
			const workingDirectory = join(directory, "session")
			await writeFile(source, Buffer.from([0, 255, 42]))
			const stored = new Map<string, unknown>()
			const steer = vi.fn().mockResolvedValue(undefined)
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				runningSessions: new Map([["session", "task"]]),
				drainingSessions: new Map(),
				queueSettings: new Map(),
				queueWrite: Promise.resolve(),
				eventEmitter: { fire: vi.fn() },
				steer,
				call: vi.fn(async (method: string, params: { key: string; value?: unknown }) => {
					if (method === "session.working_directory") return { working_directory: workingDirectory }
					if (method === "setting.set") stored.set(params.key, params.value)
					return stored.get(params.key) ?? null
				}),
			}) as OctoCodeRuntime
			await runtime.enqueue("session", "inspect", [], {}, "full", [source])
			const [entry] = await runtime.getQueue("session")
			await runtime.pushQueuedMessage("session", entry.id, {}, "full")
			expect(steer).toHaveBeenCalledWith(
				"task",
				expect.objectContaining({
					text: expect.stringContaining(join(workingDirectory, "attachments", "document.pdf")),
				}),
			)
			expect(await readFile(join(workingDirectory, "attachments", "document.pdf"))).toEqual(
				Buffer.from([0, 255, 42]),
			)
			expect(await runtime.getQueue("session")).toEqual([])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
	it("reconciles a late acknowledgement after a delivery timeout", async () => {
		vi.useFakeTimers()
		try {
			const events = new EventEmitter()
			const stored = new Map<string, unknown>()
			const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
				runningSessions: new Map([["session", "task"]]),
				drainingSessions: new Map(),
				queueSettings: new Map(),
				queueWrite: Promise.resolve(),
				output: { appendLine: vi.fn() },
				eventEmitter: {
					fire: (event: unknown) => events.emit("event", event),
					event: (listener: (event: unknown) => void) => {
						events.on("event", listener)
						return { dispose: () => events.off("event", listener) }
					},
				},
				call: vi.fn(async (method: string, params: { key: string; value?: unknown }) => {
					if (method === "setting.set") stored.set(params.key, params.value)
					return stored.get(params.key) ?? null
				}),
			}) as OctoCodeRuntime
			await runtime.enqueue("session", "late message", [], {}, "full")
			const [message] = await runtime.getQueue("session")
			const pending = expect(runtime.pushQueuedMessage("session", message.id, {}, "full")).rejects.toThrow(
				"插队确认超时",
			)
			await vi.advanceTimersByTimeAsync(30_000)
			await pending
			expect(await runtime.getQueue("session")).toHaveLength(1)
			runtime["acceptLine"](
				JSON.stringify({
					task_id: "task",
					session_id: "session",
					kind: "user.message",
					payload: { id: message.id, text: message.text },
				}),
			)
			await runtime["queueWrite"]
			expect(await runtime.getQueue("session")).toEqual([])
		} finally {
			vi.useRealTimers()
		}
	})
	it("does not auto-run an unacknowledged message when completion races its push", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		const stored = new Map<string, unknown>()
		const prepareContinuation = vi.fn()
		Object.assign(runtime, {
			runningSessions: new Map([["session", "task"]]),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			eventEmitter: { fire: vi.fn() },
			output: { appendLine: vi.fn() },
			workbenchMcp: { releaseTask: vi.fn() },
			modelsApi: { release: vi.fn() },
			rejectUserInput: vi.fn(),
			prepareContinuation,
			call: vi.fn(async (method: string, params: { key: string; value?: unknown }) => {
				if (method === "project.refresh") return { indexes: { warnings: [] } }
				if (method === "setting.set") stored.set(params.key, params.value)
				return stored.get(params.key) ?? null
			}),
			steer: async () => {
				runtime["acceptLine"](
					JSON.stringify({
						task_id: "task",
						session_id: "session",
						kind: "agent.finished",
						payload: { success: true },
					}),
				)
				throw new Error("no acknowledgement")
			},
		})
		await runtime.enqueue("session", "keep this", [], {}, "full")
		const [message] = await runtime.getQueue("session")
		await expect(runtime.pushQueuedMessage("session", message.id, {}, "full")).rejects.toThrow("no acknowledgement")
		await vi.waitFor(() => expect(runtime["drainingSessions"].size).toBe(0))
		expect(prepareContinuation).not.toHaveBeenCalled()
		expect((await runtime.getQueue("session"))[0].id).toBe(message.id)
	})
	it("delivers a single message, promotes then delivers among many, and retains failures", async () => {
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		const stored = new Map<string, unknown>()
		const steer = vi.fn().mockResolvedValue(undefined)
		Object.assign(runtime, {
			runningSessions: new Map([["session", "active-task"]]),
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			eventEmitter: { fire: vi.fn() },
			steer,
			call: vi.fn(async (method: string, params: { key: string; value?: unknown }) => {
				if (method === "setting.set") stored.set(params.key, params.value)
				return stored.get(params.key) ?? null
			}),
		})
		await runtime.enqueue("session", "one", ["image"], {}, "full")
		const [one] = await runtime.getQueue("session")
		await runtime.pushQueuedMessage("session", one.id, {}, "full")
		expect(steer).toHaveBeenCalledWith("active-task", expect.objectContaining({ text: "one", images: ["image"] }))
		expect(await runtime.getQueue("session")).toEqual([])
		await runtime.enqueue("session", "two", [], {}, "full")
		await runtime.enqueue("session", "three", [], {}, "full")
		const [two, three] = await runtime.getQueue("session")
		await runtime.pushQueuedMessage("session", three.id, {}, "full")
		expect((await runtime.getQueue("session")).map((item) => item.text)).toEqual(["three", "two"])
		expect(steer).toHaveBeenCalledTimes(1)
		await runtime.pushQueuedMessage("session", three.id, {}, "full")
		expect(steer).toHaveBeenCalledTimes(2)
		expect((await runtime.getQueue("session")).map((item) => item.id)).toEqual([two.id])
		steer.mockRejectedValueOnce(new Error("not acknowledged"))
		await expect(runtime.pushQueuedMessage("session", two.id, {}, "full")).rejects.toThrow("not acknowledged")
		expect((await runtime.getQueue("session"))[0].id).toBe(two.id)
		expect(runtime["queueSettings"].has("session")).toBe(false)
		await runtime.enqueue("session", "four", [], {}, "full")
		await runtime.pushQueuedMessage("session", two.id, {}, "full")
		expect(steer).toHaveBeenCalledTimes(3) // Even the first row requires promotion when several exist.
		await runtime.pushQueuedMessage("session", two.id, {}, "full")
		expect(steer).toHaveBeenCalledTimes(4)
	})

	it("persists concurrent messages and drains the same session without a mounted webview", async () => {
		const stored = new Map<string, unknown>()
		const runtime = Object.assign(Object.create(OctoCodeRuntime.prototype), {
			cancelledTasks: new Set(),
		}) as OctoCodeRuntime
		const running = new Map([["session", "old-task"]])
		const started = vi.fn(async (task: { sessionId: string; taskId: string }) => {
			running.set(task.sessionId, task.taskId)
		})
		Object.assign(runtime, {
			modelsApi: { release: vi.fn() },
			transferringSessions: new Set(),
			runningSessions: running,
			drainingSessions: new Map(),
			queueSettings: new Map(),
			queueWrite: Promise.resolve(),
			eventEmitter: { fire: vi.fn() },
			output: { appendLine: vi.fn() },
			workbenchMcp: { releaseTask: vi.fn() },
			rejectUserInput: vi.fn(),
			call: vi.fn(async (method: string, params: { key: string; value?: unknown }) => {
				if (method === "setting.set") {
					stored.set(params.key, params.value)
					return {}
				}
				return stored.get(params.key) ?? null
			}),
			prepareContinuation: vi.fn(async (sessionId: string) => ({ sessionId, taskId: "next-task", route: {} })),
			runPreparedAgentTask: started,
		})
		await Promise.all([
			runtime.enqueue("session", "one", [], {}, "full"),
			runtime.enqueue("session", "two", [], {}, "full"),
		])
		expect((await runtime.getQueue("session")).map((item) => item.text)).toEqual(["one", "two"])
		expect(started).not.toHaveBeenCalled()
		runtime["acceptLine"](
			JSON.stringify({
				task_id: "old-task",
				session_id: "session",
				kind: "agent.finished",
				payload: { success: true },
			}),
		)
		await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
		await vi.waitFor(async () =>
			expect((await runtime.getQueue("session")).map((item) => item.text)).toEqual(["two"]),
		)
		expect(started).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session" }), "one", [], true, "full")
		// Cancellation must retain the next message rather than silently starting it.
		runtime["acceptLine"](
			JSON.stringify({
				task_id: "next-task",
				session_id: "session",
				kind: "agent.finished",
				payload: { success: false, cancelled: true },
			}),
		)
		expect((await runtime.getQueue("session")).map((item) => item.text)).toEqual(["two"])
		expect(started).toHaveBeenCalledOnce()
		started.mockRejectedValueOnce(new Error("launch rejected"))
		await runtime.resumeQueue("session", {}, "full")
		expect((await runtime.getQueue("session")).map((item) => item.text)).toEqual(["two"])
		expect(runtime["eventEmitter"].fire).toHaveBeenCalledWith(
			expect.objectContaining({ task_id: "next-task", kind: "agent.error" }),
		)
		started.mockRejectedValueOnce(new Error("OctoCode host request timed out: agent.run"))
		await runtime.resumeQueue("session", {}, "full")
		expect(runtime["queueSettings"].has("session")).toBe(false)
		expect(runtime["eventEmitter"].fire).toHaveBeenCalledWith(
			expect.objectContaining({ task_id: "next-task", kind: "error" }),
		)
	})
})
