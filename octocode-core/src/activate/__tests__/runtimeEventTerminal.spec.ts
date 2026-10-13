import * as vscode from "vscode"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
	RuntimeEventTerminal,
	SessionRuntimeEventTerminals,
	runtimeEventArtifactPath,
	terminalEventText,
	type RuntimeAgentEvent,
} from "../runtimeEventTerminal"

const event = (kind: string, payload: unknown): RuntimeAgentEvent => ({
	kind,
	payload,
	session_id: "session",
	task_id: "task",
})

describe("runtime event terminal", () => {
	beforeEach(() => vi.restoreAllMocks())

	it("keeps each session's shell and event output in its own terminal", async () => {
		const terminals: Array<{
			hide: ReturnType<typeof vi.fn>
			show: ReturnType<typeof vi.fn>
			dispose: ReturnType<typeof vi.fn>
		}> = []
		const ptys: vscode.Pseudoterminal[] = []
		const emitted: string[][] = []
		const shellDirectories: (string | undefined)[] = []
		const firstDirectory = path.resolve("private-project-a", "chat-a")
		const secondDirectory = path.resolve("private-project-b", "chat-b")
		vi.spyOn(vscode.window, "createTerminal").mockImplementation((options) => {
			ptys.push((options as vscode.ExtensionTerminalOptions).pty)
			const terminal = { hide: vi.fn(), show: vi.fn(), dispose: vi.fn() }
			terminals.push(terminal)
			return terminal as unknown as vscode.Terminal
		})
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const createTerminal = (sessionId?: string) =>
			new RuntimeEventTerminal(
				() => {
					const writes: string[] = []
					emitted.push(writes)
					return {
						event: vi.fn(),
						fire: (text: string) => writes.push(text),
						dispose: vi.fn(),
					} as unknown as vscode.EventEmitter<string>
				},
				(_dimensions, cwd) => {
					shellDirectories.push(cwd)
					return {
						kill: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
						onExit: vi.fn(),
						onData: (callback: (data: string) => void) => callback("PS> "),
					}
				},
				sessionId,
				true,
			)
		const runtimeTerminal = new SessionRuntimeEventTerminals(createTerminal)
		runtimeTerminal.setSessionWorkingDirectory("first", firstDirectory)
		runtimeTerminal.setSessionWorkingDirectory("second", secondDirectory)
		runtimeTerminal.setActiveSession("first")
		await vi.waitFor(() => expect(terminals).toHaveLength(1))
		ptys[0].open(undefined)
		runtimeTerminal.accept({ ...event("agent.error", { message: "first only" }), session_id: "first" })
		runtimeTerminal.setActiveSession("second")
		await vi.waitFor(() => expect(terminals).toHaveLength(2))
		ptys[1].open(undefined)
		expect(shellDirectories).toEqual([firstDirectory, secondDirectory])
		runtimeTerminal.accept({ ...event("agent.error", { message: "second only" }), session_id: "second" })
		await new Promise((resolve) => setTimeout(resolve, 70))
		expect(terminals[0].hide).toHaveBeenCalledOnce()
		expect(emitted[0].join("")).toContain("first only")
		expect(emitted[0].join("")).not.toContain("second only")
		expect(emitted[1].join("")).toContain("second only")
		expect(emitted[1].join("")).not.toContain("first only")
		await runtimeTerminal.reportArtifactFailure("first-file", "first")
		expect(emitted[0].join("")).toContain("first-file")
		expect(emitted[1].join("")).not.toContain("first-file")
		runtimeTerminal.setActiveSession("first")
		expect(terminals).toHaveLength(2)
		await vi.waitFor(() => expect(terminals[0].show).toHaveBeenCalledOnce())
		runtimeTerminal.releaseSession("second")
		expect(terminals[1].dispose).toHaveBeenCalledOnce()
		expect(terminals[0].dispose).not.toHaveBeenCalled()
		runtimeTerminal.forget()
	})

	it("does not recreate a released session terminal for late events", async () => {
		const created: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
		vi.spyOn(vscode.window, "createTerminal").mockImplementation(() => {
			const terminal = { hide: vi.fn(), show: vi.fn(), dispose: vi.fn() }
			created.push(terminal)
			return terminal as unknown as vscode.Terminal
		})
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const runtimeTerminal = new SessionRuntimeEventTerminals(
			(sessionId) =>
				new RuntimeEventTerminal(
					() =>
						({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() }) as unknown as vscode.EventEmitter<string>,
					vi.fn(),
					sessionId,
					true,
				),
		)
		runtimeTerminal.setActiveSession("deleted")
		await vi.waitFor(() => expect(created).toHaveLength(1))
		runtimeTerminal.releaseSession("deleted")
		await vi.waitFor(() => expect(created).toHaveLength(2))
		expect(created[0].dispose).toHaveBeenCalledOnce()
		runtimeTerminal.accept({ ...event("agent.error", { message: "late" }), session_id: "deleted" })
		await runtimeTerminal.reportArtifactFailure("late.txt", "deleted")
		runtimeTerminal.setActiveSession("deleted")
		expect(created).toHaveLength(2)
		runtimeTerminal.forget()
	})

	it("refuses a session shell without a private working directory", () => {
		const fire = vi.fn()
		const spawn = vi.fn()
		let pty: vscode.Pseudoterminal | undefined
		vi.spyOn(vscode.window, "createTerminal").mockImplementation((options) => {
			pty = (options as vscode.ExtensionTerminalOptions).pty
			return { dispose: vi.fn() } as unknown as vscode.Terminal
		})
		new RuntimeEventTerminal(
			() => ({ event: vi.fn(), fire, dispose: vi.fn() }) as unknown as vscode.EventEmitter<string>,
			spawn,
			"Session",
			true,
		).open(vscode.ViewColumn.Three)
		pty!.open(undefined)
		expect(spawn).not.toHaveBeenCalled()
		expect(fire).toHaveBeenCalledWith(expect.stringContaining("Session working directory unavailable"))
	})

	it("places artifact failures in the third editor terminal without opening a document", async () => {
		const terminal = { show: vi.fn(), dispose: vi.fn() } as unknown as vscode.Terminal
		const create = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(terminal)
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const commands = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const runtimeTerminal = new RuntimeEventTerminal(() => emitter)
		await runtimeTerminal.reportArtifactFailure("missing.log")
		expect(emitter.fire).not.toHaveBeenCalled()
		const options = create.mock.calls[0][0] as vscode.ExtensionTerminalOptions
		options.pty.open(undefined)
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ location: { viewColumn: vscode.ViewColumn.Three, preserveFocus: true } }),
		)
		expect(commands).toHaveBeenCalledWith("workbench.action.octocode.placeRuntimeTerminal", terminal.name)
		expect(terminal.show).toHaveBeenCalledWith(true)
		expect(emitter.fire).toHaveBeenCalledWith(expect.stringContaining("missing.log"))
	})

	it("renders runtime errors in the fixed execution terminal", () => {
		expect(
			terminalEventText(event("agent.error", { message: "Provider unavailable\nRetry later" }), new Map()),
		).toBe("\x1b[31m[OctoCode error] Provider unavailable\r\nRetry later\x1b[0m\r\n")
		expect(terminalEventText(event("agent.error", { error: "Authentication failed" }), new Map())).toContain(
			"Authentication failed",
		)
	})

	it("retains an early task error until first PTY open and after reopen", () => {
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const options: vscode.ExtensionTerminalOptions[] = []
		vi.spyOn(vscode.window, "createTerminal").mockImplementation((value) => {
			options.push(value as vscode.ExtensionTerminalOptions)
			return { dispose: vi.fn(), show: vi.fn() } as unknown as vscode.Terminal
		})
		const runtimeTerminal = new RuntimeEventTerminal(() => emitter)
		runtimeTerminal.accept(event("agent.error", { message: "early task failure" }))
		runtimeTerminal.open(vscode.ViewColumn.Three)
		expect(emitter.fire).not.toHaveBeenCalled()
		options[0].pty.open(undefined)
		expect(emitter.fire).toHaveBeenCalledWith(expect.stringContaining("early task failure"))
		vi.mocked(emitter.fire).mockClear()
		runtimeTerminal.reopen(vscode.ViewColumn.Three)
		runtimeTerminal.accept(event("agent.error", { message: "reopened task failure" }))
		expect(emitter.fire).not.toHaveBeenCalled()
		options[1].pty.open(undefined)
		expect(emitter.fire).toHaveBeenCalledWith(expect.stringContaining("reopened task failure"))
	})

	it("keeps pending errors through shell startup redraw until output settles", async () => {
		vi.useFakeTimers()
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		let data: (text: string) => void = () => undefined
		const shell = {
			kill: vi.fn(),
			write: vi.fn(),
			resize: vi.fn(),
			onExit: vi.fn(),
			onData: (callback: typeof data) => {
				data = callback
			},
		}
		const create = vi
			.spyOn(vscode.window, "createTerminal")
			.mockReturnValue({ dispose: vi.fn(), show: vi.fn() } as unknown as vscode.Terminal)
		const terminal = new RuntimeEventTerminal(
			() => emitter,
			() => shell,
		)
		terminal.accept(event("agent.error", { message: "startup failure" }))
		terminal.open(vscode.ViewColumn.Three)
		;(create.mock.calls[0][0] as vscode.ExtensionTerminalOptions).pty.open(undefined)
		for (const frame of ["\x1b[?9001h", "\x1b]0;PowerShell\x07", "\x1b[2J\x1b[H"]) data(frame)
		expect(vi.mocked(emitter.fire).mock.calls.some(([text]) => text.includes("startup failure"))).toBe(false)
		data("PS D:/owned> ")
		data("\x1b[8;23;98t\x1b[K\x1b[H")
		data("PS D:/owned> ")
		expect(vi.mocked(emitter.fire).mock.calls.some(([text]) => text.includes("startup failure"))).toBe(false)
		await vi.advanceTimersByTimeAsync(50)
		expect(emitter.fire).toHaveBeenLastCalledWith(expect.stringContaining("startup failure"))
		vi.useRealTimers()
	})

	it("shows supervisor interventions and hides attempt bookkeeping", () => {
		const executions = new Map()
		expect(terminalEventText(event("agent.supervisor", { action: "fallback", detail: "a -> b" }), executions)).toBe(
			"\x1b[33m[OctoCode 模型回退]: a -> b\x1b[0m\r\n",
		)
		expect(terminalEventText(event("agent.supervisor", { action: "review_ok" }), executions)).toContain("复核通过")
		expect(
			terminalEventText(event("agent.supervisor", { action: "attempt_started", pid: 1 }), executions),
		).toBeUndefined()
	})

	it("reuses the existing terminal instead of disposing and recreating it", () => {
		const terminal = { dispose: vi.fn() } as unknown as vscode.Terminal
		const createTerminal = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(terminal)
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const runtimeTerminal = new RuntimeEventTerminal(() => emitter)

		expect(runtimeTerminal.open(3 as vscode.ViewColumn)).toBe(terminal)
		expect(runtimeTerminal.open(3 as vscode.ViewColumn)).toBe(terminal)
		expect(createTerminal).toHaveBeenCalledTimes(1)
		expect(terminal.dispose).not.toHaveBeenCalled()
	})

	it("replaces an exited terminal and keeps a late close scoped to its original shell", () => {
		const ptys: vscode.Pseudoterminal[] = []
		const first = { dispose: vi.fn(), exitStatus: undefined as unknown } as unknown as vscode.Terminal
		const second = { dispose: vi.fn() } as unknown as vscode.Terminal
		vi.spyOn(vscode.window, "createTerminal").mockImplementation((options) => {
			ptys.push((options as vscode.ExtensionTerminalOptions).pty)
			return ptys.length === 1 ? first : second
		})
		const shells = [0, 1].map(() => ({
			kill: vi.fn(),
			onData: vi.fn(),
			onExit: vi.fn(),
			resize: vi.fn(),
			write: vi.fn(),
		}))
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		let shellIndex = 0
		const runtimeTerminal = new RuntimeEventTerminal(
			() => emitter,
			() => shells[shellIndex++],
		)
		runtimeTerminal.open(vscode.ViewColumn.Three)
		ptys[0].open(undefined)
		Object.assign(first, { exitStatus: { code: 0 } })
		expect(runtimeTerminal.open(vscode.ViewColumn.Three)).toBe(second)
		ptys[1].open(undefined)
		ptys[0].close()
		expect(shells[0].kill).toHaveBeenCalledOnce()
		expect(shells[1].kill).not.toHaveBeenCalled()
		expect(runtimeTerminal.open(vscode.ViewColumn.Three)).toBe(second)
	})

	it("forwards user input and shell output through the interactive PowerShell terminal", () => {
		let pty: vscode.Pseudoterminal | undefined
		vi.spyOn(vscode.window, "createTerminal").mockImplementation((options) => {
			pty = (options as vscode.ExtensionTerminalOptions).pty
			return { dispose: vi.fn() } as unknown as vscode.Terminal
		})
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const shell = {
			kill: vi.fn(),
			onData: vi.fn((callback: (data: string) => void) => callback("PS> ")),
			onExit: vi.fn(),
			resize: vi.fn(),
			write: vi.fn(),
		}
		const runtimeTerminal = new RuntimeEventTerminal(
			() => emitter,
			() => shell,
		)

		runtimeTerminal.open(3 as vscode.ViewColumn)
		pty!.open?.({ columns: 100, rows: 30 })
		pty!.handleInput?.("Get-Date\r")
		pty!.setDimensions?.({ columns: 120, rows: 40 })

		expect(shell.write).toHaveBeenCalledWith("Get-Date\r")
		expect(shell.resize).toHaveBeenCalledWith(120, 40)
		expect(emitter.fire).toHaveBeenCalledWith("PS> ")
	})

	it("recreates the terminal when restoring its fixed editor group", () => {
		const first = { dispose: vi.fn() } as unknown as vscode.Terminal
		const second = { dispose: vi.fn() } as unknown as vscode.Terminal
		const createTerminal = vi
			.spyOn(vscode.window, "createTerminal")
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second)
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const runtimeTerminal = new RuntimeEventTerminal(() => emitter)

		expect(runtimeTerminal.open(3 as vscode.ViewColumn)).toBe(first)
		expect(runtimeTerminal.reopen(3 as vscode.ViewColumn)).toBe(second)
		expect(first.dispose).toHaveBeenCalledOnce()
		expect(createTerminal).toHaveBeenCalledTimes(2)
	})

	it("notifies the workbench when the user closes the terminal", () => {
		let pty: vscode.Pseudoterminal | undefined
		vi.spyOn(vscode.window, "createTerminal").mockImplementation((options) => {
			pty = (options as vscode.ExtensionTerminalOptions).pty
			return { dispose: vi.fn() } as unknown as vscode.Terminal
		})
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const onDidClose = vi.fn()
		const runtimeTerminal = new RuntimeEventTerminal(() => emitter)
		runtimeTerminal.setOnDidClose(onDidClose)

		runtimeTerminal.open(3 as vscode.ViewColumn)
		pty!.close!()

		expect(onDidClose).toHaveBeenCalledOnce()
	})

	it("does not report an intentional terminal relocation as a user close", () => {
		let close: (() => void) | undefined
		const first = { dispose: vi.fn(() => close?.()) } as unknown as vscode.Terminal
		const second = { dispose: vi.fn() } as unknown as vscode.Terminal
		vi.spyOn(vscode.window, "createTerminal")
			.mockImplementationOnce((options) => {
				close = (options as vscode.ExtensionTerminalOptions).pty.close
				return first
			})
			.mockReturnValueOnce(second)
		const emitter = { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() } as unknown as vscode.EventEmitter<string>
		const onDidClose = vi.fn()
		const runtimeTerminal = new RuntimeEventTerminal(() => emitter)
		runtimeTerminal.setOnDidClose(onDidClose)

		runtimeTerminal.open(3 as vscode.ViewColumn)
		runtimeTerminal.reopen(3 as vscode.ViewColumn)

		expect(onDidClose).not.toHaveBeenCalled()
	})

	it("shows only execute tool commands and their readable output", () => {
		const executions = new Map()
		expect(
			terminalEventText(
				event("tool_call", {
					kind: "execute",
					rawInput: { command: "Write-Output ok" },
					status: "in_progress",
					toolCallId: "terminal-1",
					toolName: "run_terminal_cmd",
				}),
				executions,
			),
		).toBe("> Write-Output ok\r\n")
		expect(
			terminalEventText(
				event("tool_call_update", {
					rawOutput: { output: "ok" },
					status: "completed",
					toolCallId: "terminal-1",
				}),
				executions,
			),
		).toBe("ok\r\n[completed]\r\n")
		expect(terminalEventText(event("thought", { data: "hidden" }), executions)).toBeUndefined()
		expect(
			terminalEventText(event("tool_call", { kind: "edit", toolCallId: "edit-1" }), executions),
		).toBeUndefined()
	})

	it("decodes byte output and emits only the new part of cumulative terminal updates", () => {
		const executions = new Map()
		terminalEventText(
			event("tool_call", {
				kind: "execute",
				rawInput: { command: "printf ok" },
				toolCallId: "terminal-2",
			}),
			executions,
		)

		expect(
			terminalEventText(
				event("tool_call_update", {
					rawOutput: { output: [111, 107, 10] },
					status: "in_progress",
					toolCallId: "terminal-2",
				}),
				executions,
			),
		).toBe("ok\r\n[in_progress]\r\n")
		expect(
			terminalEventText(
				event("tool_call_update", {
					rawOutput: { output: [111, 107, 10, 100, 111, 110, 101, 10] },
					status: "completed",
					toolCallId: "terminal-2",
				}),
				executions,
			),
		).toBe("done\r\n[completed]\r\n")
	})

	it("decodes split UTF-8 deltas and emits status only when it changes", () => {
		const executions = new Map()
		terminalEventText(event("tool_call", { kind: "execute", toolCallId: "terminal-3" }), executions)
		expect(
			terminalEventText(
				event("tool_call_update", {
					rawOutput: { output_delta: [228, 184] },
					status: "in_progress",
					toolCallId: "terminal-3",
				}),
				executions,
			),
		).toBe("[in_progress]\r\n")
		expect(
			terminalEventText(
				event("tool_call_update", {
					rawOutput: { output_delta: [173] },
					status: "in_progress",
					toolCallId: "terminal-3",
				}),
				executions,
			),
		).toBe("中\r\n")
	})

	it("does not repeat cumulative output after an empty delta reset", () => {
		const executions = new Map()
		terminalEventText(event("tool_call", { kind: "execute", toolCallId: "terminal-4" }), executions)
		terminalEventText(
			event("tool_call_update", { rawOutput: { output_delta: [97, 98, 99] }, toolCallId: "terminal-4" }),
			executions,
		)
		terminalEventText(
			event("tool_call_update", { rawOutput: { output_delta: [] }, toolCallId: "terminal-4" }),
			executions,
		)
		terminalEventText(
			event("tool_call_update", { rawOutput: { output_delta: [100] }, toolCallId: "terminal-4" }),
			executions,
		)
		expect(
			terminalEventText(
				event("tool_call_update", { rawOutput: { output: "d" }, toolCallId: "terminal-4" }),
				executions,
			),
		).toBeUndefined()
	})

	it("routes a live read_file call to the artifact view", () => {
		expect(
			runtimeEventArtifactPath(
				event("tool_call", {
					kind: "read",
					rawInput: { target_file: "D:\\Program Files\\OctoCode\\test\\ui-live\\hello.py" },
					toolCallId: "call_733863a034fb4f3ab06f124a",
					toolName: "read_file",
				}),
			),
		).toBe("D:\\Program Files\\OctoCode\\test\\ui-live\\hello.py")
		expect(
			runtimeEventArtifactPath(
				event("tool_call", {
					kind: "execute",
					rawInput: { command: "python hello.py" },
					toolName: "run_terminal_command",
				}),
			),
		).toBeUndefined()
	})
})
