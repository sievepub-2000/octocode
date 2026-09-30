import { render, screen, fireEvent, act, cleanup } from "@testing-library/react"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { vscode } from "@src/utils/vscode"

import { UpdateRailBadge } from "../UpdateRailBadge"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: { defaultValue?: string; version?: string }) =>
			(opts?.defaultValue ?? key).replace("${version}", opts?.version ?? ""),
	}),
}))

const posted = () => vi.mocked(vscode.postMessage).mock.calls.map((c) => (c[0] as { type: string }).type)

const push = (values: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "updateStatus", values } }))
	})
}

describe("UpdateRailBadge", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		cleanup()
	})

	it("asks the host for status on mount", () => {
		render(<UpdateRailBadge />)
		expect(posted()).toContain("requestUpdateStatus")
	})

	it("renders nothing while there is no update to offer", () => {
		const { container } = render(<UpdateRailBadge />)
		// Nothing at all until a status arrives.
		expect(container).toBeEmptyDOMElement()

		push({ available: false, current: "0.1.0", configured: true, applying: false })
		expect(screen.queryByRole("button")).not.toBeInTheDocument()

		// A channel nobody configured stays silent even if it somehow reports one.
		push({ available: true, current: "0.1.0", version: "0.1.1", configured: false, applying: false })
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("shows a red dot and a clickable update action when one is ready", () => {
		render(<UpdateRailBadge />)
		push({ available: true, current: "0.1.0", version: "0.1.1", configured: true, applying: false })

		const button = screen.getByRole("button")
		expect(button).toHaveClass("octo-rail-item--update")
		expect(button.getAttribute("aria-label")).toContain("0.1.1")
		expect(button.querySelector(".octo-rail-dot")).not.toBeNull()
		expect(button).toBeEnabled()
	})

	it("posts applyUpdate once and disables itself while installing", () => {
		render(<UpdateRailBadge />)
		push({ available: true, current: "0.1.0", version: "0.1.1", configured: true, applying: false })

		const button = screen.getByRole("button")
		fireEvent.click(button)
		expect(posted()).toContain("applyUpdate")

		// Clicking again must not queue a second install.
		fireEvent.click(button)
		expect(posted().filter((t) => t === "applyUpdate")).toHaveLength(1)
		push({ available: true, current: "0.1.0", version: "0.1.1", configured: true, applying: false })
		expect(button).toBeEnabled()
	})

	it("reflects an applying status pushed from the host", () => {
		render(<UpdateRailBadge />)
		push({ available: true, current: "0.1.0", version: "0.1.1", configured: true, applying: true })
		expect(screen.getByRole("button")).toBeDisabled()
	})

	it("stops rendering once the host reports no update", () => {
		const { container } = render(<UpdateRailBadge />)
		push({ available: true, current: "0.1.0", version: "0.1.1", configured: true, applying: false })
		expect(screen.getByRole("button")).toBeInTheDocument()
		push({ available: false, current: "0.1.1", configured: true, applying: false })
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(container).toBeEmptyDOMElement()
	})
})
