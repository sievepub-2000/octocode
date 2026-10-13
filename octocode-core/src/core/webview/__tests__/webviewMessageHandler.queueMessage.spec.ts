// npx vitest core/webview/__tests__/webviewMessageHandler.queueMessage.spec.ts

import type { Mock } from "vitest"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn() },
	window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
}))

const enqueue = vi.fn()
const editQueue = vi.fn()
const pushQueuedMessage = vi.fn()
const cancelTask = vi.fn()
const call = vi.fn().mockResolvedValue({ working_directory: "/mock/workspace/.octocode/sessions/task-1" })
vi.mock("../../../services/octocode-runtime/OctoCodeRuntime", () => ({
	getOctoCodeRuntime: () => ({ enqueue, editQueue, pushQueuedMessage, cancelTask, call }),
}))

/**
 * Typing while the agent is busy must never lose the message.
 *
 * The webview clears the composer the moment it posts this, so anything the
 * handler drops is gone from the screen as well. The original code was
 * `provider.getCurrentTask()?.messageQueueService.addMessage(...)`, and the
 * optional call did exactly that whenever the receiving instance was not the one
 * holding the task — there is one provider per webview (sidebar, editor, artifact)
 * and only one of them owns the run. Measured on a running build: the typed line
 * appeared in no queue, in no conversation, and nowhere in globalStorage.
 *
 * The queue lives in the runtime now, addressed by task id, which is what makes
 * it reachable from whichever webview happens to post. These assertions follow
 * that: the message carries the id, and the handler hands it to the runtime.
 */
describe("webviewMessageHandler - queueMessage", () => {
	const makeProvider = (overrides: Partial<Record<string, unknown>> = {}) =>
		({
			// Image resolution runs before the queue branch and reads these limits.
			getState: vi.fn().mockResolvedValue({ maxImageFileSize: 5, maxTotalImageSize: 20 }),
			getStateToPostToWebview: vi
				.fn()
				.mockResolvedValue({ apiConfiguration: { apiProvider: "openai" }, permissionProfile: "full" }),
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			startRuntimeTask: vi.fn().mockResolvedValue(undefined),
			cwd: "/mock/workspace",
			...overrides,
		}) as unknown as ClineProvider

	beforeEach(() => vi.clearAllMocks())
	it("stops through Runtime and reports cancellation errors to the composer", async () => {
		const provider = makeProvider()
		cancelTask.mockRejectedValueOnce(new Error("cancel timeout"))
		await webviewMessageHandler(provider, { type: "cancelRuntimeTask", taskId: "session", text: "active" })
		expect(cancelTask).toHaveBeenCalledWith("active")
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					kind: "agent.cancel_requested",
					payload: { error: "cancel timeout" },
				}),
			}),
		)
	})

	it("routes jump-queue clicks by stable message and session IDs", async () => {
		await webviewMessageHandler(makeProvider(), {
			type: "pushQueuedMessage",
			taskId: "session",
			text: "message-id",
		})
		expect(pushQueuedMessage).toHaveBeenCalledWith("session", "message-id", { apiProvider: "openai" }, "full")
	})

	it("queues onto the run the message names", async () => {
		const provider = makeProvider()

		await webviewMessageHandler(provider, {
			type: "queueMessage",
			taskId: "task-1",
			text: "later",
			images: ["img"],
		})

		expect(enqueue).toHaveBeenCalledWith("task-1", "later", ["img"], { apiProvider: "openai" }, "full")
		expect(call).toHaveBeenCalledWith("session.working_directory", { id: "task-1" })
		expect((provider as unknown as { startRuntimeTask: Mock }).startRuntimeTask).not.toHaveBeenCalled()
	})

	it("starts the message instead of dropping it when nothing is running", async () => {
		// No run to queue behind, so the thing the user asked for happens now.
		const provider = makeProvider()

		await webviewMessageHandler(provider, { type: "queueMessage", text: "do it", images: [] })

		expect(enqueue).not.toHaveBeenCalled()
		expect((provider as unknown as { startRuntimeTask: Mock }).startRuntimeTask).toHaveBeenCalledWith("do it", [])
	})

	it("edits and removes through the same queue", async () => {
		const provider = makeProvider()
		const queue = [
			{ id: "id-1", text: "first" },
			{ id: "id-2", text: "second" },
		]

		await webviewMessageHandler(provider, { type: "removeQueuedMessage", taskId: "task-1", text: "id-1" })
		await webviewMessageHandler(provider, {
			type: "editQueuedMessage",
			taskId: "task-1",
			payload: { id: "id-2", text: "changed", images: [] },
		})

		expect(editQueue).toHaveBeenCalledTimes(2)
		// The handler passes the change as a function, so the assertion is what
		// that function does to a queue rather than what it was called with.
		const [removeTaskId, removeChange] = editQueue.mock.calls[0]
		const [editTaskId, editChange] = editQueue.mock.calls[1]
		expect(removeTaskId).toBe("task-1")
		expect(editTaskId).toBe("task-1")
		expect(removeChange(queue)).toEqual([{ id: "id-2", text: "second" }])
		expect(editChange(queue)).toEqual([
			{ id: "id-1", text: "first" },
			{ id: "id-2", text: "changed" },
		])
	})

	it("ignores an edit that would blank the message", async () => {
		const provider = makeProvider()

		await webviewMessageHandler(provider, {
			type: "editQueuedMessage",
			taskId: "task-1",
			payload: { id: "id-2", text: "   ", images: [] },
		})

		expect(editQueue).not.toHaveBeenCalled()
	})
})
