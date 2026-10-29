import * as vscode from "vscode"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as workspacePaths from "../../utils/path"
import * as shellPaths from "../../utils/shell"
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

	it("opens a native shell without a session and never supplies a pseudoterminal", () => {
		const workspace = path.resolve("owned-workspace")
		vi.spyOn(workspacePaths, "getWorkspacePath").mockReturnValue(workspace)
		const shell = path.resolve("environments", "powershell", "pwsh.exe")
		vi.spyOn(shellPaths, "getShell").mockReturnValue(shell)
		const create = vi
			.spyOn(vscode.window, "createTerminal")
			.mockReturnValue({ name: "PowerShell", dispose: vi.fn() } as unknown as vscode.Terminal)
		new SessionRuntimeEventTerminals().open(vscode.ViewColumn.Three)
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: workspace,
				shellPath: shell,
				shellArgs: ["-NoLogo"],
				location: { viewColumn: vscode.ViewColumn.Three, preserveFocus: true },
			}),
		)
		expect(create.mock.calls[0][0]).not.toHaveProperty("pty")
		expect(create.mock.calls[0][0]).toHaveProperty("isTransient", true)
	})

	it("keeps native terminals and displayed events scoped to their session", async () => {
		const created: vscode.Terminal[] = []
		const create = vi.spyOn(vscode.window, "createTerminal").mockImplementation((options) => {
			const terminal = {
				name: (options as vscode.TerminalOptions).name,
				show: vi.fn(),
				hide: vi.fn(),
				dispose: vi.fn(),
			} as unknown as vscode.Terminal
			created.push(terminal)
			return terminal
		})
		const commands = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const runtime = new SessionRuntimeEventTerminals()
		const first = path.resolve("project-a", "chat-a")
		const second = path.resolve("project-b", "chat-b")
		runtime.setSessionWorkingDirectory("a", first)
		runtime.setSessionWorkingDirectory("b", second)
		runtime.setActiveSession("a")
		await vi.waitFor(() => expect(created).toHaveLength(1))
		runtime.accept({
			...event("tool_call", { kind: "execute", toolCallId: "a", rawInput: { command: "only a" } }),
			session_id: "a",
		})
		runtime.setActiveSession("b")
		await vi.waitFor(() => expect(created).toHaveLength(2))
		expect(create.mock.calls.map(([options]) => (options as vscode.TerminalOptions).cwd)).toEqual([first, second])
		expect(commands).toHaveBeenCalledWith(
			"workbench.action.octocode.writeRuntimeTerminal",
			created[0].name,
			expect.stringContaining("only a"),
		)
		expect(commands).not.toHaveBeenCalledWith(
			"workbench.action.octocode.writeRuntimeTerminal",
			created[1].name,
			expect.stringContaining("only a"),
		)
		runtime.releaseSession("a")
		const count = create.mock.calls.length
		runtime.accept({ ...event("agent.error", { message: "late" }), session_id: "a" })
		expect(create).toHaveBeenCalledTimes(count)
		runtime.forget()
	})

	it("resolves a restored session directory before creating its native terminal", async () => {
		const directory = path.resolve("restored-chat")
		const resolve = vi.fn().mockResolvedValue(directory)
		const create = vi
			.spyOn(vscode.window, "createTerminal")
			.mockReturnValue({ name: "session", show: vi.fn(), dispose: vi.fn() } as unknown as vscode.Terminal)
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const runtime = new SessionRuntimeEventTerminals(undefined, resolve)
		runtime.setActiveSession("restored")
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
		expect(resolve).toHaveBeenCalledWith("restored")
		expect(create.mock.calls[0][0]).toMatchObject({ cwd: directory })
		runtime.forget()
	})

	it("does not open a stale session after directory lookup resolves", async () => {
		let finish!: (directory: string) => void
		const resolve = vi.fn().mockReturnValue(
			new Promise<string>((r) => {
				finish = r
			}),
		)
		const create = vi
			.spyOn(vscode.window, "createTerminal")
			.mockReturnValue({ name: "terminal", show: vi.fn(), dispose: vi.fn() } as unknown as vscode.Terminal)
		vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const runtime = new SessionRuntimeEventTerminals(undefined, resolve)
		runtime.setActiveSession("old")
		runtime.setSessionWorkingDirectory("new", path.resolve("new-chat"))
		runtime.setActiveSession("new")
		finish(path.resolve("old-chat"))
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
		expect(create.mock.calls[0][0]).toMatchObject({ cwd: path.resolve("new-chat") })
		runtime.forget()
	})

	it("does not create an unusable session terminal when its directory is missing", () => {
		const create = vi.spyOn(vscode.window, "createTerminal")
		const terminal = new RuntimeEventTerminal("session", true)
		expect(() => terminal.open(vscode.ViewColumn.Three)).toThrow("Session working directory unavailable")
		expect(create).not.toHaveBeenCalled()
	})

	it("flushes early output to the display bridge without executing it in PowerShell", () => {
		const terminal = {
			name: "native",
			show: vi.fn(),
			dispose: vi.fn(),
			sendText: vi.fn(),
		} as unknown as vscode.Terminal
		vi.spyOn(vscode.window, "createTerminal").mockReturnValue(terminal)
		const commands = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		const runtime = new RuntimeEventTerminal()
		runtime.accept(
			event("tool_call", { kind: "execute", toolCallId: "early", rawInput: { command: "echo early" } }),
		)
		runtime.open(vscode.ViewColumn.Three)
		expect(commands).toHaveBeenCalledWith(
			"workbench.action.octocode.writeRuntimeTerminal",
			"native",
			expect.stringContaining("echo early"),
		)
		expect(terminal.sendText).not.toHaveBeenCalled()
	})

	it("scopes native close callbacks and suppresses intentional relocation", () => {
		let closed!: (terminal: vscode.Terminal) => void
		vi.spyOn(vscode.window, "onDidCloseTerminal").mockImplementation((callback) => {
			closed = callback
			return { dispose: vi.fn() }
		})
		const first = { name: "first", dispose: vi.fn() } as unknown as vscode.Terminal
		const second = { name: "second", dispose: vi.fn() } as unknown as vscode.Terminal
		vi.spyOn(vscode.window, "createTerminal").mockReturnValueOnce(first).mockReturnValueOnce(second)
		const onClose = vi.fn()
		const runtime = new RuntimeEventTerminal()
		runtime.setOnDidClose(onClose)
		runtime.open(vscode.ViewColumn.Three)
		runtime.reopen(vscode.ViewColumn.Three)
		closed(first)
		expect(onClose).not.toHaveBeenCalled()
		closed(second)
		expect(onClose).toHaveBeenCalledOnce()
	})

	it("keeps runtime errors out of the command terminal", () => {
		expect(
			terminalEventText(event("agent.error", { message: "Provider unavailable\nRetry later" }), new Map()),
		).toBeUndefined()
		expect(terminalEventText(event("agent.error", { error: "Authentication failed" }), new Map())).toBeUndefined()
	})

	it("keeps supervisor status out of the command terminal", () => {
		const executions = new Map()
		expect(
			terminalEventText(event("agent.supervisor", { action: "fallback", detail: "a -> b" }), executions),
		).toBeUndefined()
		expect(terminalEventText(event("agent.supervisor", { action: "review_ok" }), executions)).toBeUndefined()
		expect(
			terminalEventText(event("agent.supervisor", { action: "attempt_started", pid: 1 }), executions),
		).toBeUndefined()
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
