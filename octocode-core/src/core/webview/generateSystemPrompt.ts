import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { WebviewMessage } from "../../shared/WebviewMessage"
import type { ClineProvider } from "./ClineProvider"

export const generateSystemPrompt = async (provider: ClineProvider, _message: WebviewMessage) => {
	const prompt = await readFile(join(provider.context.extensionPath, "resources", "harness", "system-prompt.md"), "utf8")
	return `${prompt}\n\n---\n这是当前执行器的基础提示词。当前会话的任务、记忆、工具和工作区指令在执行时按实际配置追加。`
}
