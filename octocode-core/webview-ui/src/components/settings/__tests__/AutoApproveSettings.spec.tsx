import { render, screen, fireEvent } from "@/utils/test-utils"
import { AutoApproveSettings } from "../AutoApproveSettings"
import { vscode } from "@/utils/vscode"
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ permissionProfile: "review" }) }))
it("exposes only the enforced task permission profiles", () => {
	const { container } = render(<AutoApproveSettings />)
	const select = screen.getByRole("combobox")
	expect(select).toHaveValue("review")
	for (const profile of ["directory", "full", "review"]) {
		fireEvent.change(select, { target: { value: profile } })
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "permissionProfile", text: profile })
	}
	expect(container.querySelectorAll("input")).toHaveLength(0)
	expect(screen.queryByTestId("max-cost-input")).not.toBeInTheDocument()
})
