import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import ArtifactView from "../ArtifactView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe("ArtifactView log inspector", () => {
	beforeEach(() => vi.clearAllMocks())

	it("clears an old preview while another conversation loads", () => {
		render(<ArtifactView />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "artifactSelected",
						text: "A",
						payload: { kind: "code", path: "/A.txt", content: "only A" },
					},
				}),
			)
		})
		expect(screen.getByText("only A")).toBeInTheDocument()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "runtimeSessionLoading", payload: { sessionId: "B" } } }),
			)
		})
		expect(screen.queryByText("only A")).not.toBeInTheDocument()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "artifactSelected", text: "A", payload: { kind: "code", content: "only A" } },
				}),
			)
		})
		expect(screen.queryByText("only A")).not.toBeInTheDocument()
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "artifactSelected", text: "B" } }))
		})
		expect(screen.getByText("octocode.inspectorHint")).toBeInTheDocument()
	})

	it("clears the preview and browser address when starting a new conversation", () => {
		render(<ArtifactView />)
		fireEvent.change(screen.getByRole("textbox", { name: "octocode.browserAddress" }), {
			target: { value: "https://private.example/a" },
		})
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "artifactSelected",
						text: "A",
						payload: { kind: "code", path: "/A.txt", content: "only A" },
					},
				}),
			)
			window.dispatchEvent(new MessageEvent("message", { data: { type: "invoke", invoke: "newChat" } }))
		})
		expect(screen.queryByText("only A")).not.toBeInTheDocument()
		expect(screen.getByRole("textbox", { name: "octocode.browserAddress" })).toHaveValue("http://localhost:3000")
	})

	it("renders log records in the inspector and removes one through the runtime", () => {
		render(<ArtifactView />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "artifactSelected",
						payload: {
							kind: "logs",
							category: "system",
							path: "系统日志",
							records: [
								{
									id: 7,
									level: "warn",
									subsystem: "browser",
									message: "page retried",
									fields: { url: "https://example.com" },
									created_at: 1_777_000_000_000,
								},
							],
						},
					},
				}),
			)
		})

		expect(screen.getByText("page retried")).toBeInTheDocument()
		expect(screen.getByText(/example\.com/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "octocode.deleteLog" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "runtimeRequest",
			payload: { requestId: expect.any(String), method: "log.delete", params: { id: 7, category: "system" } },
		})
		expect(screen.queryByText("page retried")).not.toBeInTheDocument()
	})

	it("keeps developer fields visible while folding system details", () => {
		render(<ArtifactView />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "artifactSelected",
						payload: {
							kind: "logs",
							category: "system",
							path: "系统日志",
							records: [
								{
									id: 8,
									category: "system",
									level: "info",
									subsystem: "host",
									message: "started",
									fields: { retention_days: 30 },
									created_at: 1,
								},
							],
						},
					},
				}),
			)
		})

		expect(screen.getByText("started")).toBeInTheDocument()
		expect(screen.getByText("octocode.logDetails").closest("details")).not.toHaveAttribute("open")
	})
})
