import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Search, X } from "lucide-react"

import { Button, Input } from "@/components/ui"
import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import RuntimeHistoryView from "./RuntimeHistoryView"

/**
 * The left column: everything a person navigates between, in one place.
 *
 * Conversation history lives here permanently rather than behind a rail icon
 * that replaces the whole window. The rail is for management surfaces
 * (marketplace, settings, MCP, skills, modes); this column is the working set —
 * start a task, find a past one, resume it.
 */
const TaskNavigationView = () => {
	const { t } = useTranslation("common")
	const [searchQuery, setSearchQuery] = useState("")
	const { cwd } = useExtensionState()

	return (
		<nav aria-label={t("octocode.tasks")} className="flex h-full min-h-0 flex-col">
			<details className="border-b border-vscode-panel-border p-2">
				<summary className="cursor-pointer truncate text-xs" title={cwd}>
					{cwd || t("ui.noWorkspace")}
				</summary>
				<div className="mt-2 flex flex-wrap gap-1">
					{["openFolder", "openRecent", "findFile", "commands", "keyboardShortcuts"].map((action) => (
						<Button
							key={action}
							variant="ghost"
							size="sm"
							onClick={() => vscode.postMessage({ type: "workspaceAction", text: action })}>
							{t(`ui.${action}`)}
						</Button>
					))}
				</div>
			</details>
			<div data-testid="task-navigation-actions" className="flex min-w-0 justify-start gap-1 p-2">
				<Button
					className="min-w-0 flex-1 justify-start"
					onClick={() => vscode.postMessage({ type: "clearTask" })}>
					<Plus />
					<span className="truncate">{t("octocode.newTask")}</span>
				</Button>
			</div>

			<>
				<div className="relative px-2 pb-2">
					<Search
						size={14}
						className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-vscode-descriptionForeground"
					/>
					<Input
						type="search"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder={t("octocode.searchTasks", { defaultValue: "Search conversations" })}
						aria-label={t("octocode.searchTasks", { defaultValue: "Search conversations" })}
						className="w-full pl-7 pr-7"
					/>
					{searchQuery ? (
						<button
							type="button"
							aria-label={t("octocode.clearSearch", { defaultValue: "Clear search" })}
							onClick={() => setSearchQuery("")}
							className="absolute right-4 top-1/2 -translate-y-1/2 text-vscode-descriptionForeground hover:text-vscode-foreground">
							<X size={14} />
						</button>
					) : null}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{/*
					 * The runtime list shows live sessions — the ones a person is most
					 * likely to return to — and the searchable archive follows it.
					 */}
					<RuntimeHistoryView searchQuery={searchQuery} workspace={cwd} />
				</div>
			</>
		</nav>
	)
}

export default TaskNavigationView
