import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { vscode } from "@src/utils/vscode"
import ChatView from "../ChatView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: {}, mode: "code", setMode: vi.fn() }),
}))
vi.mock("@roo/ProfileValidator", () => ({ ProfileValidator: { isProfileAllowed: () => true } }))
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({ useSelectedModel: () => ({ info: {} }) }))
vi.mock("@src/components/welcome/RooHero", () => ({ default: () => <div>Home</div> }))
vi.mock("@src/components/welcome/RooTips", () => ({ default: () => null }))
vi.mock("../WorktreeSelector", () => ({ WorktreeSelector: () => null }))
vi.mock("../ProfileViolationWarning", () => ({ default: () => null }))
vi.mock("../QueuedMessages", () => ({ QueuedMessages: () => <div>queued</div> }))
vi.mock("../ChatTextArea", () => ({
	ChatTextArea: ({
		topOverlay,
		inputValue,
		setInputValue,
		onSend,
		onStop,
		promptHistory,
	}: {
		topOverlay?: React.ReactNode
		inputValue: string
		setInputValue: (text: string) => void
		onSend: () => void
		onStop: () => void
		promptHistory: string[]
	}) => (
		<>
			{topOverlay}
			<input aria-label="draft" value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
			<button onClick={onSend}>send</button>
			<button onClick={onStop}>stop</button>
			<div data-testid="prompts">{promptHistory.join("|")}</div>
		</>
	),
}))
vi.mock("../RuntimeTranscript", () => ({
	default: ({
		prompt,
		events,
		running,
	}: {
		prompt: string
		events: Array<{ payload: { data?: string } }>
		running: boolean
	}) => (
		<div data-testid="transcript">
			{prompt}:{events.map((event) => event.payload.data).join("")}:{String(running)}
		</div>
	),
}))

const source = { sessionId: "owned-source-S", taskId: "owned-source-old-T" }
const target = { sessionId: "owned-target-S", taskId: "owned-target-T" }
const newer = { sessionId: source.sessionId, taskId: "owned-source-new-user-T" }
const emit = (type: string, payload: unknown, runtimeHandoff?: { source: typeof source; target?: typeof target }) =>
	act(() => window.dispatchEvent(new MessageEvent("message", { data: { type, payload, runtimeHandoff } })))
const load = (task: typeof source) => {
	emit("runtimeSessionLoading", { sessionId: task.sessionId })
	emit("runtimeSessionLoaded", { ...task, prompt: "owned conversation", events: [], status: "running" })
}
const starting = () =>
	emit(
		"agentEvent",
		{ session_id: source.sessionId, task_id: source.taskId, kind: "runtime.rollover_started", payload: {} },
		{ source },
	)
const ready = () =>
	emit(
		"agentEvent",
		{
			session_id: source.sessionId,
			task_id: source.taskId,
			kind: "runtime.rollover_ready",
			payload: { newSessionId: target.sessionId },
		},
		{ source, target },
	)
const started = () => emit("runtimeTaskStarted", { ...target, prompt: "owned handoff", images: [] }, { source, target })
const request = () => {
	fireEvent.change(screen.getByLabelText("draft"), { target: { value: "/newsession" } })
	fireEvent.click(screen.getByText("send"))
}
describe("handoff source and target task identity", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		load(source)
	})
	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})
	it("keeps the source pair until ready and matching started complete", () => {
		starting()
		ready()
		request()
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "newRuntimeSession",
			taskId: source.sessionId,
			sourceTask: source,
		})
		started()
		request()
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "newRuntimeSession",
			taskId: target.sessionId,
			sourceTask: target,
		})
	})
	it("retains the new task in the same source session", () => {
		starting()
		emit("runtimeTaskStarted", { ...newer, prompt: "owned newer" })
		ready()
		started()
		request()
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "newRuntimeSession",
			taskId: newer.sessionId,
			sourceTask: newer,
		})
	})
	it("retains a newer target task selected between ready and started", () => {
		starting()
		ready()
		const newerTarget = { sessionId: target.sessionId, taskId: "owned-target-new-user-T" }
		load(newerTarget)
		started()
		request()
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "newRuntimeSession",
			taskId: newerTarget.sessionId,
			sourceTask: newerTarget,
		})
	})
	it("does not append a second user entry on a duplicate started message", () => {
		starting()
		ready()
		started()
		const before = screen.getByTestId("prompts").textContent
		started()
		expect(screen.getByTestId("prompts").textContent).toBe(before)
	})
	it("keeps a ready target binding on duplicate rollover_started", () => {
		starting()
		ready()
		starting()
		started()
		request()
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "newRuntimeSession",
			taskId: target.sessionId,
			sourceTask: target,
		})
	})
	it("ignores an old failure after the same source session changes task", () => {
		starting()
		emit("runtimeTaskStarted", { ...newer, prompt: "owned newer" })
		emit(
			"agentEvent",
			{
				session_id: source.sessionId,
				task_id: source.taskId,
				kind: "runtime.rollover_failed",
				payload: { message: "owned stale failure" },
			},
			{ source },
		)
		expect(screen.queryByRole("alert")).toBeNull()
	})
})
