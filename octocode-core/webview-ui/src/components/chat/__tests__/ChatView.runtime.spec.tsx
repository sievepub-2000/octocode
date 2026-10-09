import { act, fireEvent, render, screen } from "@testing-library/react"
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

const emit = (type: string, payload?: unknown, extra = {}) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type, payload, ...extra } }))
	})
const load = (id: string) => {
	emit("runtimeSessionLoading", { sessionId: id })
	emit("runtimeSessionLoaded", { sessionId: id, taskId: `${id}-task`, prompt: id, events: [], status: "running" })
}

describe("single Runtime conversation model", () => {
	it("shows stopping, suppresses duplicate clicks, and permits retry after cancellation failure", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		load("A")
		fireEvent.click(screen.getByText("stop"))
		fireEvent.click(screen.getByText("stop"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("status")).toHaveTextContent("common:ui.stoppingTask")
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "keep queued" } })
		fireEvent.click(screen.getByText("send"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "queueMessage",
			taskId: "A",
			text: "keep queued",
			images: [],
		})
		emit("agentEvent", {
			session_id: "A",
			task_id: "A-task",
			kind: "agent.cancel_requested",
			payload: { error: "timeout" },
		})
		expect(screen.getByText("timeout")).toBeVisible()
		fireEvent.click(screen.getByText("stop"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(3)
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "agent.finished", payload: { cancelled: true } })
		expect(screen.queryByRole("status")).toBeNull()
		expect(screen.getByTestId("transcript")).toHaveTextContent("false")
	})
	it("retains a stop click while a new task identity is being prepared", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "new task" } })
		fireEvent.click(screen.getByText("send"))
		fireEvent.click(screen.getByText("stop"))
		emit("runtimeTaskStarted", { sessionId: "A", taskId: "A-task", prompt: "new task" })
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "cancelRuntimeTask", text: "A-task", taskId: "A" })
	})
	it("cancels the new continuation when stopped during preparation, never the previous task", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		load("A")
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "agent.finished", payload: {} })
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "continue" } })
		fireEvent.click(screen.getByText("send"))
		fireEvent.click(screen.getByText("stop"))
		expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === "cancelRuntimeTask")).toHaveLength(0)
		emit("runtimeTaskStarted", { sessionId: "A", taskId: "A-next", prompt: "continue" })
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "cancelRuntimeTask", text: "A-next", taskId: "A" })
	})
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})
	afterEach(() => vi.useRealTimers())
	it("collapses overlays independently, keeps live updates collapsed, and hides empty overlays", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		load("A")
		const update = (content: string) => {
			emit("agentEvent", {
				session_id: "A",
				task_id: "A-task",
				kind: "plan",
				payload: { entries: content ? [{ content, status: "pending" }] : [] },
			})
			emit("agentEvent", {
				session_id: "A",
				task_id: "A-task",
				kind: "runtime.queue",
				payload: { queue: content ? [{ id: "q", text: content, images: [] }] : [] },
			})
			act(() => vi.advanceTimersByTime(50))
		}
		update("first todo")
		const todos = screen.getByLabelText("todos-list")
		const queue = screen.getByLabelText("message-queue")
		fireEvent.click(screen.getByLabelText("common:ui.toggleTodos"))
		expect(todos).not.toHaveAttribute("open")
		expect(screen.getByText("first todo")).not.toBeVisible()
		expect(queue).toHaveAttribute("open")
		fireEvent.click(screen.getByLabelText("common:ui.toggleQueue"))
		expect(queue).not.toHaveAttribute("open")
		expect(screen.getByText("queued")).not.toBeVisible()
		expect(screen.getByLabelText("common:ui.toggleTodos")).toBeVisible()
		expect(screen.getByLabelText("common:ui.toggleQueue")).toBeVisible()
		update("updated todo")
		expect(todos).not.toHaveAttribute("open")
		expect(queue).not.toHaveAttribute("open")
		fireEvent.click(screen.getByLabelText("common:ui.toggleTodos"))
		expect(screen.getByText("updated todo")).toBeVisible()
		expect(queue).not.toHaveAttribute("open")
		fireEvent.click(screen.getByLabelText("common:ui.toggleQueue"))
		expect(screen.getByText("queued")).toBeVisible()
		update("")
		expect(screen.queryByTestId("runtime-overlays")).toBeNull()
		update("new todo")
		expect(screen.getByText("new todo")).toBeVisible()
		expect(screen.getByLabelText("message-queue")).toHaveAttribute("open")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
	it("ignores late loads/events, batches output, preserves session selection", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		expect(screen.queryByLabelText("todos-list")).toBeNull()
		expect(screen.queryByLabelText("message-queue")).toBeNull()
		load("A")
		emit("runtimeSessionLoading", { sessionId: "B" })
		emit("runtimeSessionLoaded", { sessionId: "A", taskId: "old", prompt: "stale", events: [] })
		emit("runtimeSessionLoaded", { sessionId: "B", taskId: "B-task", prompt: "B", events: [], status: "running" })
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "agent.finished", payload: {} })
		emit("agentEvent", { session_id: "B", task_id: "B-task", kind: "text", payload: { data: "answer" } })
		act(() => vi.advanceTimersByTime(50))
		expect(screen.getByTestId("transcript")).toHaveTextContent("B:answer:true")
		emit("agentEvent", {
			session_id: "B",
			task_id: "B-task",
			kind: "plan",
			payload: { entries: [{ content: "todo", status: "pending" }] },
		})
		emit("agentEvent", {
			session_id: "B",
			task_id: "B-task",
			kind: "runtime.queue",
			payload: { queue: [{ id: "q", text: "queued", images: [] }] },
		})
		act(() => vi.advanceTimersByTime(50))
		expect(screen.getByLabelText("todos-list")).toHaveTextContent("todo")
		expect(screen.getByLabelText("message-queue")).toBeVisible()
		expect(screen.queryByText("common:ui.continueNewChat")).not.toBeInTheDocument()
		// Another session starting elsewhere does not steal this conversation.
		emit("runtimeTaskStarted", { sessionId: "C", taskId: "C-task", prompt: "continued" })
		expect(screen.getByTestId("transcript")).toHaveTextContent("B:answer:true")
		expect(vi.mocked(vscode.postMessage).mock.calls.some(([message]) => message.type === "cancelRuntimeTask")).toBe(
			false,
		)
	})
	it("submits new tasks, queues active tasks, and continues stopped tasks through Runtime only", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "new prompt" } })
		fireEvent.click(screen.getByText("send"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "newTask", text: "new prompt", images: [] })
		emit("runtimeTaskStarted", { sessionId: "A", taskId: "A-task", prompt: "new prompt" })
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "queued" } })
		fireEvent.click(screen.getByText("send"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "queueMessage",
			taskId: "A",
			text: "queued",
			images: [],
		})
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "agent.finished", payload: {} })
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "continue" } })
		fireEvent.click(screen.getByText("send"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "continueRuntimeTask",
			taskId: "A",
			text: "continue",
			images: [],
		})
	})
	it("rolls over only the selected running task and keeps its conversation visible", () => {
		render(<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => undefined} />)
		load("A")
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "text", payload: { data: "before" } })
		act(() => vi.advanceTimersByTime(50))
		emit("agentEvent", {
			session_id: "B",
			task_id: "B-task",
			kind: "runtime.rollover_ready",
			payload: { newSessionId: "B2" },
		})
		expect(screen.getByTestId("transcript")).toHaveTextContent("A:before:true")
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "runtime.rollover_started", payload: {} }, { runtimeHandoff: { source: { sessionId: "A", taskId: "A-task" } } })
		emit("agentEvent", { session_id: "A", task_id: "A-task", kind: "agent.finished", payload: { cancelled: true } })
		expect(screen.getByTestId("transcript")).toHaveTextContent("A:before:true")
		emit("agentEvent", {
			session_id: "A",
			task_id: "A-task",
			kind: "runtime.rollover_ready",
			payload: { newSessionId: "A2" },
		}, { runtimeHandoff: { source: { sessionId: "A", taskId: "A-task" }, target: { sessionId: "A2", taskId: "A2-task" } } })
		emit("runtimeTaskStarted", { sessionId: "A2", taskId: "A2-task", prompt: "continue A" }, { runtimeHandoff: { source: { sessionId: "A", taskId: "A-task" }, target: { sessionId: "A2", taskId: "A2-task" } } })
		emit("agentEvent", { session_id: "A2", task_id: "A2-task", kind: "text", payload: { data: "after" } })
		act(() => vi.advanceTimersByTime(50))
		expect(screen.getByTestId("transcript")).toHaveTextContent("A:beforeafter:true")
		fireEvent.change(screen.getByLabelText("draft"), { target: { value: "/newsession" } })
		fireEvent.click(screen.getByText("send"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "newRuntimeSession", taskId: "A2", sourceTask: { sessionId: "A2", taskId: "A2-task" } })
	})
})
