import { describe, expect, it, vi } from "vitest"

import { DAP_ACTIONS, DapBus } from "../dapBus"

function debugApi() {
	const started: Array<(session: unknown) => void> = []
	const terminated: Array<(session: unknown) => void> = []
	const events: Array<(event: unknown) => void> = []
	return {
		api: {
			activeDebugSession: undefined,
			breakpoints: [],
			onDidStartDebugSession: vi.fn((listener) => (started.push(listener), { dispose: vi.fn() })),
			onDidTerminateDebugSession: vi.fn((listener) => (terminated.push(listener), { dispose: vi.fn() })),
			onDidReceiveDebugSessionCustomEvent: vi.fn((listener) => (events.push(listener), { dispose: vi.fn() })),
			startDebugging: vi.fn().mockResolvedValue(true),
			stopDebugging: vi.fn().mockResolvedValue(undefined),
			addBreakpoints: vi.fn(),
			removeBreakpoints: vi.fn(),
		},
		started,
		terminated,
		events,
	}
}

function session(id = "session-1") {
	return {
		id,
		name: "Node test",
		type: "node",
		workspaceFolder: undefined,
		parentSession: undefined,
		configuration: { type: "node", request: "launch", name: "Node test" },
		customRequest: vi.fn().mockResolvedValue({ ok: true }),
		getDebugProtocolBreakpoint: vi.fn(),
	}
}

describe("DAP public contract", () => {
	it("publishes exactly 28 unique protocol actions", () => {
		expect(DAP_ACTIONS).toHaveLength(28)
		expect(new Set(DAP_ACTIONS).size).toBe(28)
		expect(DAP_ACTIONS).not.toContain("sessions")
	})

	it("lists tracked sessions through the same bus", async () => {
		const fake = debugApi()
		const bus = new DapBus(fake.api as never)
		const child = { ...session("child"), parentSession: session("root") }
		fake.started[0](child)

		await expect(bus.dispatch({ kind: "bus", action: "sessions" })).resolves.toMatchObject({
			action: "sessions",
			success: true,
			data: [{ id: "child", parentSessionId: "root" }],
		})
		bus.dispose()
	})

	it("installs the debugger for the launch type before starting, and reports a failed install", async () => {
		const fake = debugApi()
		const ensure = vi.fn(async (type: string | undefined) => {
			if (type === "broken") throw new Error("no debugger for broken")
		})
		const bus = new DapBus(fake.api as never, 1_000, ensure)
		await bus.dispatch({
			kind: "dap",
			action: "launch",
			configuration: { type: "python", request: "launch", name: "x", program: "a.py" },
		})
		expect(ensure).toHaveBeenCalledWith("python")
		expect(fake.api.startDebugging).toHaveBeenCalled()
		const failed = await bus.dispatch({
			kind: "dap",
			action: "launch",
			configuration: { type: "broken", request: "launch", name: "y" },
		})
		expect(failed).toMatchObject({ success: false })
		bus.dispose()
	})

	it("validates launch configuration and session identity", async () => {
		const fake = debugApi()
		const bus = new DapBus(fake.api as never)

		await expect(bus.dispatch({ kind: "dap", action: "launch" })).resolves.toMatchObject({
			success: false,
			error: "launch requires configuration",
		})
		await expect(bus.dispatch({ kind: "dap", action: "evaluate" })).resolves.toMatchObject({
			success: false,
			error: "evaluate requires sessionId",
		})
		bus.dispose()
	})

	it("dispatches protocol requests and records bounded output", async () => {
		const fake = debugApi()
		const bus = new DapBus(fake.api as never, 2)
		const active = session()
		fake.started[0](active)
		fake.events[0]({ session: active, event: "stopped", body: { threadId: 7 } })
		fake.events[0]({ session: active, event: "output", body: { output: "one" } })
		fake.events[0]({ session: active, event: "output", body: { output: "two" } })
		fake.events[0]({ session: active, event: "output", body: { output: "three" } })

		await expect(bus.dispatch({ kind: "dap", action: "continue", sessionId: active.id })).resolves.toMatchObject({
			success: true,
			data: { ok: true },
		})
		expect(active.customRequest).toHaveBeenCalledWith("continue", { threadId: 7 })
		await expect(bus.dispatch({ kind: "dap", action: "output", sessionId: active.id })).resolves.toMatchObject({
			data: [{ output: "two" }, { output: "three" }],
		})
		bus.dispose()
	})

	it("returns capability errors without losing the session", async () => {
		const fake = debugApi()
		const bus = new DapBus(fake.api as never)
		const active = session()
		active.customRequest.mockRejectedValueOnce(new Error("adapter does not support readMemory"))
		fake.started[0](active)

		await expect(
			bus.dispatch({ kind: "dap", action: "read_memory", sessionId: active.id, arguments: {} }),
		).resolves.toMatchObject({
			success: false,
			error: "adapter does not support readMemory",
		})
		await expect(bus.dispatch({ kind: "bus", action: "sessions" })).resolves.toMatchObject({
			data: [expect.objectContaining({ id: active.id })],
		})
		bus.dispose()
	})
})

describe("DAP session lifecycle", () => {
	function withTracker() {
		const fake = debugApi()
		const trackers: Array<(session: unknown) => { onDidSendMessage(message: unknown): void }> = []
		const api = {
			...fake.api,
			registerDebugAdapterTrackerFactory: vi.fn(
				(
					_type: string,
					factory: {
						createDebugAdapterTracker(session: unknown): { onDidSendMessage(message: unknown): void }
					},
				) => {
					trackers.push((session) => factory.createDebugAdapterTracker(session))
					return { dispose: vi.fn() }
				},
			),
			addBreakpoints: vi.fn(),
		}
		return { fake, api, adapter: (session: unknown) => trackers[0](session) }
	}

	it("sets breakpoints first, returns the session id and waits for the first stop", async () => {
		const { fake, api, adapter } = withTracker()
		const active = session("py-1")
		api.startDebugging = vi.fn(async () => {
			fake.started[0](active)
			setTimeout(
				() =>
					adapter(active).onDidSendMessage({
						type: "event",
						event: "stopped",
						body: { threadId: 3, reason: "breakpoint" },
					}),
				5,
			)
			return true
		})
		const bus = new DapBus(api as never, 1_000, async () => undefined, 200)
		const result = await bus.dispatch({
			kind: "dap",
			action: "launch",
			configuration: { type: "python", request: "launch", name: "calc", program: "calc.py" },
			arguments: { breakpoints: [{ path: "C:/work/calc.py", line: 5 }] },
		})
		expect(api.addBreakpoints).toHaveBeenCalledTimes(1)
		expect(api.addBreakpoints.mock.invocationCallOrder[0]).toBeLessThan(
			api.startDebugging.mock.invocationCallOrder[0],
		)
		expect(result).toMatchObject({
			success: true,
			data: { sessionId: "py-1", state: "stopped", threadId: 3, reason: "breakpoint" },
		})
		bus.dispose()
	})

	it("explains a refused start and keeps a finished session's output readable", async () => {
		const { fake, api, adapter } = withTracker()
		api.startDebugging = vi.fn(async () => false)
		const bus = new DapBus(api as never, 1_000, async () => undefined, 50)
		await expect(
			bus.dispatch({
				kind: "dap",
				action: "launch",
				configuration: { type: "python", request: "launch", name: "x" },
			}),
		).resolves.toMatchObject({ success: false, error: expect.stringContaining("did not start") })

		const active = session("py-2")
		fake.started[0](active)
		adapter(active).onDidSendMessage({ type: "event", event: "output", body: { output: "total 15" } })
		fake.terminated[0](active)
		await expect(bus.dispatch({ kind: "dap", action: "wait_for_stop", sessionId: "py-2" })).resolves.toMatchObject({
			data: { state: "terminated" },
		})
		await expect(bus.dispatch({ kind: "dap", action: "output", sessionId: "py-2" })).resolves.toMatchObject({
			data: [{ output: "total 15" }],
		})
		bus.dispose()
	})
})

describe("DAP guidance for guessed calls", () => {
	it("refuses an attach with nothing to attach to and lists valid actions for unknown ones", async () => {
		const fake = debugApi()
		const bus = new DapBus(fake.api as never, 1_000, async () => undefined, 50)
		await expect(
			bus.dispatch({
				kind: "dap",
				action: "attach",
				configuration: { type: "debugpy", request: "attach", name: "x" },
			}),
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('use action "launch"') })
		expect(fake.api.startDebugging).not.toHaveBeenCalled()
		await expect(bus.dispatch({ kind: "dap", action: "start" as never })).resolves.toMatchObject({
			error: expect.stringContaining("launch, attach, set_breakpoint"),
		})
		bus.dispose()
	})
})
