import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { TerminalSettings } from "../TerminalSettings"
import { vscode } from "@/utils/vscode"
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
it("opens the real desktop profile picker and persists desktop environment inheritance", () => {
 render(<TerminalSettings />)
 expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getVSCodeSetting", setting: "terminal.integrated.inheritEnv" })
 const checkbox = screen.getByTestId("terminal-inherit-env-checkbox")
 expect(checkbox).toBeDisabled()
 act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "vsCodeSetting", setting: "terminal.integrated.inheritEnv", value: true } })))
 expect(checkbox).toBeChecked()
 fireEvent.click(checkbox)
 expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "updateVSCodeSetting", setting: "terminal.integrated.inheritEnv", bool: false })
 fireEvent.click(screen.getByTestId("terminal-profile-configure-button"))
 expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "openTerminalProfilePicker" })
 expect(screen.queryByTestId("terminal-output-preview-size-dropdown")).not.toBeInTheDocument()
})
