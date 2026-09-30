import { describe, it, expect, vi, beforeEach } from "vitest"
import type * as vscode from "vscode"
import { API } from "../api"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { getOctoCodeRuntime } from "../../services/octocode-runtime/OctoCodeRuntime"

vi.mock("@roo-code/ipc", () => ({ IpcServer: class {} }))
vi.mock("../../core/webview/ClineProvider", () => ({ ClineProvider: { getActiveRuntimeTask: vi.fn(), setActiveRuntimeSession: vi.fn(), clearActiveRuntimeSession: vi.fn() } }))
vi.mock("../../core/webview/webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))
vi.mock("../../services/octocode-runtime/OctoCodeRuntime", () => ({ getOctoCodeRuntime: vi.fn() }))

describe("Runtime extension API", () => {
	beforeEach(() => vi.clearAllMocks())
	it("uses Host continuation, queue, cancellation and persisted messages without an old Task", async () => {
		const runtime = { onEvent: vi.fn(() => ({ dispose: vi.fn() })), replyUserInput: vi.fn(() => false), call: vi.fn().mockResolvedValue({ id: "session", status: "stopped", title: "task", updated_at: 1 }), prepareContinuation: vi.fn().mockResolvedValue({ sessionId: "session", taskId: "next", route: {} }), runPreparedAgentTask: vi.fn().mockResolvedValue(undefined), enqueue: vi.fn(), editQueue: vi.fn() }
		// Only the Runtime methods exercised by this boundary are needed in this test double.
		vi.mocked(getOctoCodeRuntime).mockReturnValue(runtime as unknown as ReturnType<typeof getOctoCodeRuntime>)
		vi.mocked(ClineProvider.getActiveRuntimeTask).mockReturnValue({ sessionId: "session", taskId: "round" })
		const provider = { context: { subscriptions: [] }, viewLaunched: false, getState: vi.fn().mockResolvedValue({ apiConfiguration: {}, permissionProfile: "read-only" }), postMessageToWebview: vi.fn(), reportRuntimeFailure: vi.fn() }
		// The constructor's VS Code host objects are structural in this isolated boundary test.
		const api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider as unknown as ClineProvider)
		await api.sendMessage("continue", [])
		expect(runtime.prepareContinuation).toHaveBeenCalledWith("session", "continue", {}, [])
		expect(runtime.runPreparedAgentTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "next" }), "continue", [], true, "read-only")
		runtime.call.mockResolvedValueOnce({ id: "session", status: "running" })
		await api.sendMessage("queued")
		expect(runtime.enqueue).toHaveBeenCalledWith("session", "queued", [], {}, "read-only")
		await api.cancelCurrentTask()
		expect(runtime.call).toHaveBeenCalledWith("agent.cancel", { task_id: "round" })
		await api.deleteQueuedMessage("remove")
		const change = runtime.editQueue.mock.calls[0][1] as (queue: Array<{ id: string }>) => Array<{ id: string }>
		expect(change([{ id: "remove" }, { id: "keep" }])).toEqual([{ id: "keep" }])
		runtime.call.mockResolvedValueOnce([{}, {}])
		expect(await api.getTaskApiConversationHistoryLength("session")).toBe(2)
		expect(api.getCurrentTaskStack()).toEqual(["session"])
		await api.clearCurrentTask()
		expect(ClineProvider.clearActiveRuntimeSession).toHaveBeenCalledWith("session")
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({ type: "invoke", invoke: "newChat" })
		await expect(api.abandonSubtask("legacy")).rejects.toThrow("旧委派")
	})
})
