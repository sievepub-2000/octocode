import { fireEvent, render, screen } from "@/utils/test-utils"
import { useAddNonInteractiveClickListener } from "./useNonInteractiveClick"

it("lets history buttons and their labels handle a single click without a second focus command", () => {
	const focus = vi.fn()
	function View() {
		useAddNonInteractiveClickListener(focus)
		return <><button><span>历史任务</span></button><p>空白区域</p></>
	}
	render(<View />)
	fireEvent.click(screen.getByText("历史任务"))
	expect(focus).not.toHaveBeenCalled()
	fireEvent.click(screen.getByText("空白区域"))
	expect(focus).toHaveBeenCalledTimes(1)
})
