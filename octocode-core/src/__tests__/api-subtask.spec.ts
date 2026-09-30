// npx vitest run __tests__/api-subtask.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "events"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: [] },
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	env: { language: "en" },
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p })),
		parse: vi.fn((s: string) => ({ toString: () => s })),
	},
	commands: { registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }) },
}))

vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {
		listen() {}
		on() {}
		close() {}
	},
}))

vi.mock("../services/command/commands", () => ({ getCommands: vi.fn().mockResolvedValue([]) }))

// The API reaches the runtime singleton, which throws unless the extension
// has started one. A unit test has not, so it gets a stand-in.
vi.mock("../services/octocode-runtime/OctoCodeRuntime", () => ({
	getOctoCodeRuntime: () => ({
		call: vi.fn().mockResolvedValue(null),
		onEvent: vi.fn(),
		enqueue: vi.fn(),
		editQueue: vi.fn(),
		replyUserInput: vi.fn().mockReturnValue(false),
		prepareContinuation: vi.fn(),
	}),
}))

import { API } from "../extension/api"

function makeProviderMock() {
	const emitter = new EventEmitter()
	return {
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		emit: emitter.emit.bind(emitter),
		context: {
			extensionPath: "/test",
			globalStorageUri: { fsPath: "/test/storage" },
			subscriptions: [],
		},
		cwd: "/test/cwd",
		evictCurrentTask: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		abandonSubtask: vi.fn().mockResolvedValue(true),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		viewLaunched: false,
		cancelTask: vi.fn().mockResolvedValue(undefined),
		getTaskWithId: vi.fn().mockRejectedValue(new Error("not found")),
		taskHistoryStore: { get: vi.fn().mockReturnValue(undefined), getAll: vi.fn().mockReturnValue([]) },
		getCurrentTaskStack: vi.fn().mockReturnValue([]),
		getModes: vi.fn().mockResolvedValue([]),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
	}
}

describe("API.clearCurrentTask()", () => {
	let provider: ReturnType<typeof makeProviderMock>
	let api: API

	beforeEach(() => {
		vi.clearAllMocks()
		provider = makeProviderMock()
		api = new API({} as any, provider as any)
	})

	it("asks the webview for a fresh conversation", async () => {
		await api.clearCurrentTask()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "invoke", invoke: "newChat" })
	})
})

describe("API.abandonSubtask()", () => {
	let provider: ReturnType<typeof makeProviderMock>
	let api: API

	beforeEach(() => {
		vi.clearAllMocks()
		provider = makeProviderMock()
		api = new API({} as any, provider as any)
	})

	// The legacy delegation protocol this belonged to is retired; the method
	// survives so a caller still on it fails loudly instead of silently doing
	// nothing. That refusal is the contract worth holding.
	it("refuses: the legacy delegation protocol it belonged to is retired", async () => {
		await expect(api.abandonSubtask("child-task-1")).rejects.toThrow(/停用/)
		expect(provider.abandonSubtask).not.toHaveBeenCalled()
	})
})
