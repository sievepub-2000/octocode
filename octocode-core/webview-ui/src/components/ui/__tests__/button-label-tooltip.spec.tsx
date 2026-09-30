import { render, screen } from "@/utils/test-utils"
import { Search } from "lucide-react"

import { Button } from "../button"

describe("Button label tooltip", () => {
	it("uses an accessible icon label as the native hover name", () => {
		render(
			<Button aria-label="查询日志" size="icon">
				<Search />
			</Button>,
		)

		expect(screen.getByRole("button", { name: "查询日志" })).toHaveAttribute("title", "查询日志")
	})

	it("preserves an explicitly supplied hover name", () => {
		render(<Button aria-label="删除" title="删除这条日志" />)

		expect(screen.getByRole("button", { name: "删除" })).toHaveAttribute("title", "删除这条日志")
	})
})
