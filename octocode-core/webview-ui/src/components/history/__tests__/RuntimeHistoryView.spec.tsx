import { act, fireEvent, render, screen, waitFor, within } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import i18next from "i18next"

import { loadLocale } from "@src/i18n/setup"

import RuntimeHistoryView from "../RuntimeHistoryView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

type Payload = { method?: string; requestId?: string; params?: unknown }

describe("RuntimeHistoryView", () => {
	/*
	 * Wait for the language before rendering anything.
	 *
	 * The names queried below are Chinese, and only English is bundled eagerly —
	 * every other locale is fetched on demand. Without this the component renders
	 * against an uninitialised i18next, every label comes out as its raw key, and
	 * the failures read as "no element with that accessible name" rather than as
	 * "the translations had not arrived".
	 */
	beforeAll(async () => {
		await loadLocale("zh-CN")
		await i18next.changeLanguage("zh-CN")
	})

	beforeEach(() => vi.clearAllMocks())

	it("switches a row to the spinning hourglass as soon as its agent starts", async () => {
		render(<RuntimeHistoryView />)
		const lastList = () =>
			vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message as { payload?: Payload })
				.filter((message) => message.payload?.method === "session.list")
				.at(-1)?.payload
		const send = (data: unknown) => act(() => void window.dispatchEvent(new MessageEvent("message", { data })))
		const replyList = (status: string) =>
			send({
				type: "runtimeResponse",
				payload: { requestId: lastList()?.requestId, result: [{ id: "s", title: "Task", status, updated_at: 1 }] },
			})
		replyList("completed")
		expect(screen.getByTestId("runtime-session-status-s").className).not.toContain("octo-hourglass-flip")
		const before = lastList()?.requestId
		// Agent events reach every webview; the history view may not be the one that started the task.
		send({ type: "agentEvent", payload: { kind: "agent.started", session_id: "s", task_id: "t" } })
		expect(lastList()?.requestId).not.toBe(before)
		replyList("running")
		expect(screen.getByTestId("runtime-session-status-s").className).toContain("octo-hourglass-flip")
	})

	it("groups selected sessions only after server confirmation and keeps failed dialogs retryable", async () => {
		render(<RuntimeHistoryView />)
		const last = (method: string) => {
			const messages = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(
					([message]) => message as { payload?: { method?: string; requestId?: string; params?: unknown } },
				)
			return messages.filter((message) => message.payload?.method === method).at(-1)?.payload
		}
		const reply = (method: string, result: unknown, error?: string) =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "runtimeResponse",
							payload: { requestId: last(method)?.requestId, result, error },
						},
					}),
				)
			})
		const sessions = [
			{ id: "a", title: "Alpha", status: "completed", updated_at: 1 },
			{ id: "b", title: "Beta", status: "completed", updated_at: 2 },
		]
		reply("session.list", sessions)
		reply("project.list", [])
		// Rows carry no selection checkbox; a conversation is filed through its own button.
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
		fireEvent.click(
			within(screen.getByTestId("runtime-session-row-a")).getByRole("button", { name: "加入项目" }),
		)
		fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), { target: { value: "Reports" } })
		fireEvent.click(screen.getByRole("button", { name: "确认" }))
		expect(last("project.create")?.params).toEqual({ name: "Reports", session_ids: ["a"] })
		reply("project.create", undefined, "磁盘不可写")
		expect(screen.getByRole("alert")).toHaveTextContent("磁盘不可写")
		expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("Reports")
		fireEvent.click(screen.getByRole("button", { name: "确认" }))
		reply("project.create", { indexes: { warnings: [] } })
		reply(
			"session.list",
			sessions.map((s) => ({ ...s, project_id: "p" })),
		)
		reply("project.list", [
			{
				id: "p",
				name: "Reports",
				directory: "C:/workspace/.octocode/projects/p",
				workspace: "C:/workspace",
				created_at: 1,
			},
		])
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		const project = screen.getByTestId("runtime-project-p")
		expect(within(project).getByRole("button", { name: "Alpha" })).toBeInTheDocument()
		fireEvent.click(within(project).getAllByRole("button", { name: "退回历史" })[0])
		expect(last("project.assign")?.params).toEqual({ project_id: null, session_ids: ["a"] })
		reply("project.assign", { indexes: { warnings: [] } })
		reply("session.list", [sessions[0], { ...sessions[1], project_id: "p" }])
		expect(within(project).queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument()
		fireEvent.click(within(project).getByRole("button", { name: "删除项目" }))
		expect(screen.getByRole("dialog")).toHaveTextContent("原始产物保持原位")
		fireEvent.click(screen.getByRole("button", { name: "确认" }))
		expect(last("project.delete")?.params).toEqual({ id: "p" })
	})

	it("makes, renames and deletes a project from the controls on its row", () => {
		render(<RuntimeHistoryView workspace="C:/workspace" />)
		const payloads = () =>
			vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => (message as { payload?: Payload }).payload)
				.filter(Boolean) as Payload[]
		const last = (method: string) =>
			payloads()
				.filter((payload) => payload.method === method)
				.at(-1)
		const reply = (method: string, result: unknown) =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "runtimeResponse", payload: { requestId: last(method)?.requestId, result } },
					}),
				)
			})
		reply("session.list", [])
		reply("project.list", [])

		/*
		 * A project made before it holds anything.
		 *
		 * No session can say which folder it belongs to, so the column's own
		 * workspace does — that is what the empty `session_ids` here is checking.
		 */
		fireEvent.click(screen.getByRole("button", { name: "新建项目…" }))
		fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), { target: { value: "Reports" } })
		fireEvent.click(screen.getByRole("button", { name: "确认" }))
		expect(last("project.create")?.params).toEqual({
			name: "Reports",
			session_ids: [],
			workspace: "C:/workspace",
		})
		reply("project.create", { indexes: { warnings: [] } })
		reply("session.list", [])
		reply("project.list", [
			{
				id: "p",
				name: "Reports",
				directory: "C:/workspace/.octocode/projects/p",
				workspace: "C:/workspace",
				created_at: 1,
			},
		])

		const row = screen.getByTestId("runtime-project-p")
		const rename = within(row).getByRole("button", { name: "项目改名" })
		const remove = within(row).getByRole("button", { name: "删除项目" })
		expect(rename).toHaveTextContent("E")
		expect(remove).toHaveTextContent("−")

		// The controls sit inside the disclosure's summary, so acting on one must
		// not also fold the project away under the dialog it opens.
		fireEvent.click(rename)
		expect(row).toHaveAttribute("open")
		fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), { target: { value: "Quarterly" } })
		fireEvent.click(screen.getByRole("button", { name: "确认" }))
		expect(last("project.rename")?.params).toEqual({ id: "p", name: "Quarterly" })
		reply("project.rename", { indexes: { warnings: [] } })

		fireEvent.click(within(screen.getByTestId("runtime-project-p")).getByRole("button", { name: "删除项目" }))
		expect(screen.getByTestId("runtime-project-p")).toHaveAttribute("open")
		fireEvent.click(screen.getByRole("button", { name: "确认" }))
		expect(last("project.delete")?.params).toEqual({ id: "p" })
	})

	it("opens a selected session in the central conversation", async () => {
		render(<RuntimeHistoryView />)
		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "runtimeRequest",
					payload: expect.objectContaining({ method: "session.list" }),
				}),
			),
		)
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.map(
				([message]) => message as { type: string; payload?: { method?: string; requestId?: string } },
			)
			.find((message) => message.type === "runtimeRequest" && message.payload?.method === "session.list")
		expect(request?.payload?.requestId).toBeTruthy()

		act(() => {
			window.postMessage(
				{
					type: "runtimeResponse",
					payload: {
						requestId: request?.payload?.requestId,
						result: [{ id: "session-1", title: "History task", status: "needs_review", updated_at: 1 }],
					},
				},
				"*",
			)
		})

		fireEvent.click(await screen.findByRole("button", { name: "History task" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "openRuntimeSession", text: "session-1" })
		expect(screen.getByRole("status")).toHaveTextContent("正在加载历史对话")
		expect(screen.getByRole("button", { name: "History task" })).toHaveClass("before:absolute", "before:inset-0")

		const rename = screen.getByRole("button", { name: "重命名任务" })
		const actions = rename.parentElement
		expect(actions).toHaveClass("ml-auto", "flex", "shrink-0", "gap-0")
		expect(actions).not.toHaveClass("mr-4")
		expect(rename).toHaveClass("size-8")
		expect(within(actions!).getByRole("button", { name: "删除任务" })).toBeInTheDocument()
		expect(screen.getByTestId("runtime-session-status-session-1")).toHaveAttribute("data-status", "needs_review")
		expect(screen.getByTestId("runtime-session-row-session-1")).toHaveClass("pl-2")
		expect(screen.getByTestId("runtime-session-row-session-1")).not.toHaveClass("pr-2", "p-2")
	})

	it("shows the same animated hourglass for live sessions and a checked square for completed sessions", async () => {
		render(<RuntimeHistoryView />)
		const request = await waitFor(() => {
			const value = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(
					([message]) => message as { type: string; payload?: { method?: string; requestId?: string } },
				)
				.find((message) => message.type === "runtimeRequest" && message.payload?.method === "session.list")
			expect(value?.payload?.requestId).toBeTruthy()
			return value
		})

		act(() => {
			window.postMessage(
				{
					type: "runtimeResponse",
					payload: {
						requestId: request?.payload?.requestId,
						result: [
							{ id: "running", title: "Running", status: "running", updated_at: 1 },
							{ id: "done", title: "Done", status: "completed", updated_at: 1 },
						],
					},
				},
				"*",
			)
		})

		expect(await screen.findByTestId("runtime-session-status-running")).toHaveClass("octo-hourglass-flip")
		expect(screen.getByTestId("runtime-session-status-done")).not.toHaveClass("octo-hourglass-flip")
		// A finished run shows a bold ring instead of the hourglass.
		expect(screen.getByTestId("runtime-session-status-done").querySelector("svg")).toHaveAttribute("stroke-width", "3")
	})
})
