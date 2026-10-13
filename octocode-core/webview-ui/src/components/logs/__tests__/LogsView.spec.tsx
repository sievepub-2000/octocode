import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"
import LogsView from "../LogsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}))

type RuntimeRequest = { requestId: string; method: string; params: unknown }
const requests = (method: string): RuntimeRequest[] =>
	vi.mocked(vscode.postMessage).mock.calls.flatMap(([message]) => {
		const payload = message.payload
		if (
			message.type !== "runtimeRequest" ||
			!payload ||
			!("method" in payload) ||
			payload.method !== method ||
			!("params" in payload)
		) {
			return []
		}
		return [{ requestId: payload.requestId, method: payload.method, params: payload.params }]
	})
const reply = (request: RuntimeRequest, result?: unknown, error?: string) => {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "runtimeResponse", payload: { requestId: request.requestId, result, error } },
			}),
		)
	})
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "octocode.save" }))
const acceptSetting = () => reply(requests("setting.set")[0], { updated: true })

describe("LogsView date filters and deletion failures", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["0001-01-01", "0099-01-01", "2026-10-01"])("preserves the selected year for %s", (value) => {
		render(<LogsView />)
		fireEvent.change(screen.getByLabelText("settings:logs.startDate"), { target: { value } })
		fireEvent.change(screen.getByLabelText("settings:logs.endDate"), { target: { value } })
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.deleteFiltered" }))
		const params = requests("log.delete_matching")[0].params as { from: number; to: number }
		const from = new Date(params.from)
		const to = new Date(params.to)
		expect(from.getFullYear()).toBe(Number(value.split("-")[0]))
		expect(to.getFullYear()).toBe(from.getFullYear())
		expect(from.getDate()).toBe(1)
		expect(to.getDate()).toBe(2)
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("blocks an overflowing end date for queries, category switches and deletion without dropping the bound", () => {
		render(<LogsView />)
		fireEvent.change(screen.getByLabelText("settings:logs.keyword"), { target: { value: "owned-marker" } })
		const end = screen.getByLabelText("settings:logs.endDate")
		fireEvent.change(end, { target: { value: "275760-09-13" } })
		expect(end).toHaveValue("275760-09-13")
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.query" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.developer" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.deleteFiltered" }))
		expect(requests("log.list")).toHaveLength(0)
		expect(requests("log.delete_matching")).toHaveLength(0)
		expect(screen.getByRole("button", { name: "settings:logs.system" })).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByRole("alert")).toHaveTextContent("supported date range")
		fireEvent.change(end, { target: { value: "2026-10-01" } })
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.deleteFiltered" }))
		const params = requests("log.delete_matching")[0].params as { keyword: string; to: number }
		expect(params.keyword).toBe("owned-marker")
		expect(Number.isFinite(params.to)).toBe(true)
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("blocks a reversed range until the dates are corrected", () => {
		render(<LogsView />)
		fireEvent.change(screen.getByLabelText("settings:logs.startDate"), { target: { value: "2026-10-02" } })
		fireEvent.change(screen.getByLabelText("settings:logs.endDate"), { target: { value: "2026-10-01" } })
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.deleteFiltered" }))
		expect(requests("log.delete_matching")).toHaveLength(0)
		expect(screen.getByRole("alert")).toBeInTheDocument()
	})

	it.each(["log.clear", "log.delete_matching"])(
		"displays %s failure and refreshes only after a successful retry",
		(method) => {
			render(<LogsView />)
			fireEvent.change(screen.getByLabelText("settings:logs.keyword"), { target: { value: "owned-marker" } })
			const name = method === "log.clear" ? "settings:logs.clearAll" : "settings:logs.deleteFiltered"
			fireEvent.click(screen.getByRole("button", { name }))
			reply(requests(method)[0], undefined, "owned deletion failure")
			expect(screen.getByRole("alert")).toHaveTextContent("owned deletion failure")
			expect(requests("log.list")).toHaveLength(0)
			fireEvent.click(screen.getByRole("button", { name }))
			reply(requests(method)[1], { deleted: 1 })
			expect(requests("log.list")).toHaveLength(1)
			expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		},
	)

	it("displays a synchronous request failure without pretending deletion completed", () => {
		render(<LogsView />)
		vi.mocked(vscode.postMessage).mockImplementationOnce(() => {
			throw new Error("owned send failure")
		})
		fireEvent.click(screen.getByRole("button", { name: "settings:logs.clearAll" }))
		expect(screen.getByRole("alert")).toHaveTextContent("owned send failure")
		expect(requests("log.list")).toHaveLength(0)
	})
})

describe("LogsView retention cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})
	afterEach(() => vi.useRealTimers())

	it.each([
		{ expired: 10001, batches: [10000, 1] },
		{ expired: 25005, batches: [10000, 10000, 5005] },
		{ expired: 10000, batches: [10000, 0] },
	])("drains $expired expired rows sequentially after the setting is saved", ({ batches }) => {
		render(<LogsView />)
		save()
		expect(requests("setting.set")[0].params).toEqual({ key: "log.retention_days", value: 30 })
		expect(requests("log.purge")).toHaveLength(0)
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeDisabled()
		acceptSetting()
		for (const [index, deleted_logs] of batches.entries()) {
			expect(requests("log.purge")).toHaveLength(index + 1)
			expect(requests("log.list")).toHaveLength(0)
			expect(requests("log.purge")[index].params).toEqual({ retention_days: 30 })
			reply(requests("log.purge")[index], { deleted_logs })
		}
		expect(requests("log.purge")).toHaveLength(batches.length)
		expect(requests("log.list")).toHaveLength(1)
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeEnabled()
	})

	it("does not purge when saving the setting fails and makes failure visible", () => {
		render(<LogsView />)
		save()
		reply(requests("setting.set")[0], undefined, "owned setting failure")
		expect(requests("log.purge")).toHaveLength(0)
		expect(screen.getByRole("alert")).toHaveTextContent("owned setting failure")
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeEnabled()
	})

	it("stops and shows a later purge failure instead of reporting complete", () => {
		render(<LogsView />)
		save()
		acceptSetting()
		reply(requests("log.purge")[0], { deleted_logs: 10000 })
		reply(requests("log.purge")[1], undefined, "owned purge failure")
		expect(requests("log.purge")).toHaveLength(2)
		expect(screen.getByRole("alert")).toHaveTextContent("owned purge failure")
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeEnabled()
	})

	it.each([-1, 10001, 1.5, "10000", null])("rejects malformed batch count %s without continuing", (deleted_logs) => {
		render(<LogsView />)
		save()
		acceptSetting()
		reply(requests("log.purge")[0], { deleted_logs })
		expect(requests("log.purge")).toHaveLength(1)
		expect(screen.getByRole("alert")).toBeInTheDocument()
	})

	it("ignores duplicate and unrelated responses and cancels continuation on unmount", () => {
		const view = render(<LogsView />)
		save()
		acceptSetting()
		const first = requests("log.purge")[0]
		reply(first, { deleted_logs: 10000 })
		reply(first, { deleted_logs: 10000 })
		reply({ ...first, requestId: "unrelated" }, { deleted_logs: 10000 })
		expect(requests("log.purge")).toHaveLength(2)
		view.unmount()
		reply(requests("log.purge")[1], { deleted_logs: 10000 })
		act(() => vi.advanceTimersByTime(310_000))
		expect(requests("log.purge")).toHaveLength(2)
		expect(requests("log.list")).toHaveLength(0)
	})

	it("exposes a missing response timeout and allows a fresh save", () => {
		render(<LogsView />)
		save()
		const timedOut = requests("setting.set")[0]
		act(() => vi.advanceTimersByTime(310_000))
		expect(screen.getByRole("alert")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeEnabled()
		save()
		reply(timedOut, { updated: true })
		expect(requests("log.purge")).toHaveLength(0)
		reply(requests("setting.set")[1], { updated: true })
		expect(requests("log.purge")).toHaveLength(1)
	})

	it("stops waiting for a purge response on timeout and ignores a late full batch", () => {
		render(<LogsView />)
		save()
		acceptSetting()
		const timedOut = requests("log.purge")[0]
		act(() => vi.advanceTimersByTime(310_000))
		expect(screen.getByRole("alert")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeEnabled()
		reply(timedOut, { deleted_logs: 10000 })
		expect(requests("log.purge")).toHaveLength(1)
		expect(requests("log.list")).toHaveLength(0)
	})

	it.each([1, 3650])("uses the saved retention boundary %s for every batch", (days) => {
		render(<LogsView />)
		reply(requests("setting.get")[0], days)
		save()
		expect(requests("setting.set")[0].params).toEqual({ key: "log.retention_days", value: days })
		acceptSetting()
		reply(requests("log.purge")[0], { deleted_logs: 10000 })
		expect(requests("log.purge").map((item) => item.params)).toEqual([
			{ retention_days: days },
			{ retention_days: days },
		])
		reply(requests("log.purge")[1], { deleted_logs: 0 })
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("stops after a finite batch budget with an incomplete warning", () => {
		render(<LogsView />)
		save()
		acceptSetting()
		for (let index = 0; index < 100; index++) reply(requests("log.purge")[index], { deleted_logs: 10000 })
		expect(requests("log.purge")).toHaveLength(100)
		expect(screen.getByRole("alert")).toHaveTextContent("expired logs remain")
		expect(screen.getByRole("button", { name: "octocode.save" })).toBeEnabled()
	})
})
