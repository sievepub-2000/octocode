import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import ArtifactView from "../ArtifactView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe("ArtifactView log inspector", () => {
	beforeEach(() => vi.clearAllMocks())

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
