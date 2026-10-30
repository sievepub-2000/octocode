import { fireEvent, screen, within } from "@testing-library/react"
import { render } from "@/utils/test-utils"
import { OctoCodeAbout } from "../OctoCodeAbout"

describe("OctoCode author and offline documents", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline fixture"))
	})
	afterEach(() => vi.restoreAllMocks())

	it("shows the author contacts and preserves third-party ownership", () => {
		render(<OctoCodeAbout />)
		expect(screen.getByRole("heading", { name: "作者与授权" })).toBeInTheDocument()
		for (const email of ["zillafan80@gmail.com", "479729980@qq.com"]) {
			expect(
				screen
					.getAllByRole("link", { name: email })
					.some((link) => link.getAttribute("href") === `mailto:${email}`),
			).toBe(true)
		}
		expect(screen.queryByText("此项目由 zillafan80@gmail.com 独立完成。")).not.toBeInTheDocument()
		expect(screen.getByText(/第三方作品及既有许可继续保留/)).toBeInTheDocument()
	})

	it.each([
		["完整授权协议（离线）", "三、个人非商业许可", "2022 C.J. May"],
		["第三方许可与来源全文（离线）", "MIT License", "2015 - present Microsoft Corporation"],
		["使用手册（离线）", "10. 在线升级", "12. 常见问题"],
	])("opens %s with bundled complete text without network", (title, first, last) => {
		render(<OctoCodeAbout />)
		const summary = screen.getByText(title)
		const details = summary.closest("details")!
		fireEvent.click(summary)
		expect(details).toHaveAttribute("open")
		expect(details.textContent).toContain(first)
		expect(details.textContent).toContain(last)
		expect(within(details).getByTestId("about-document")).toBeInTheDocument()
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})
})
