import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, Circle, FolderPlus, Hourglass, Pencil, Trash2, Undo2, X } from "lucide-react"

import { Button, Input } from "@/components/ui"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { vscode } from "@src/utils/vscode"

import type { RuntimeSession, RuntimeProject } from "@roo-code/types"

const liveStatuses = new Set(["prepared", "running", "active"])

/**
 * One-character control for the project rows.
 *
 * These sit inside a `<summary>`, which means two things: the label has to be
 * narrow enough that the project name keeps the row, and the click must not
 * reach the disclosure — pressing "delete" should not also fold the project
 * away underneath the dialog it opens.
 */
const GlyphButton = ({
	glyph,
	label,
	disabled,
	onClick,
}: {
	glyph: string
	label: string
	disabled?: boolean
	onClick: () => void
}) => (
	<button
		type="button"
		aria-label={label}
		title={label}
		disabled={disabled}
		onClick={(event) => {
			event.preventDefault()
			event.stopPropagation()
			onClick()
		}}
		className="flex size-5 shrink-0 items-center justify-center rounded border-none bg-transparent font-mono text-xs leading-none text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground hover:text-vscode-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:cursor-not-allowed disabled:opacity-40">
		{glyph}
	</button>
)

const RuntimeHistoryView = ({
	searchQuery = "",
	workspace,
}: {
	searchQuery?: string
	/** Folder a project created from here is filed under. */
	workspace?: string
}) => {
	const { t } = useTranslation("common")
	const [sessions, setSessions] = useState<RuntimeSession[]>([])
	const [projects, setProjects] = useState<RuntimeProject[]>([])
	const [dialog, setDialog] = useState<{
		kind: "assign" | "create" | "rename" | "delete"
		ids?: string[]
		project?: RuntimeProject
	}>()
	const [projectId, setProjectId] = useState("")
	const [name, setName] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const [loading, setLoading] = useState<string>()
	const [editing, setEditing] = useState<string>()
	const [title, setTitle] = useState("")
	const requests = useRef(new Map<string, { kind: "sessions" | "projects" | "mutation" }>())

	const request = useCallback(
		(method: string, params: unknown, pending?: { kind: "sessions" | "projects" | "mutation" }) => {
			const requestId = crypto.randomUUID()
			requests.current.set(requestId, pending ?? { kind: "mutation" })
			if (!pending) {
				setBusy(true)
				setError("")
			}
			vscode.postMessage({ type: "runtimeRequest", payload: { requestId, method, params } })
		},
		[],
	)

	const refresh = useCallback(() => {
		request("session.list", {}, { kind: "sessions" })
		request("project.list", {}, { kind: "projects" })
	}, [request])

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (
				event.data?.type === "rooHistoryImportProgress" &&
				event.data.rooHistoryImportProgress?.status === "finished"
			) {
				refresh()
				return
			}
			if (event.data?.type === "runtimeSessionLoadFailed") {
				setLoading(undefined)
				setError(String(event.data.payload?.error ?? ""))
				return
			}
			if (event.data?.type === "runtimeSessionLoaded") setLoading(undefined)
			if (
				event.data?.type === "runtimeTaskStarted" ||
				(event.data?.type === "agentEvent" &&
					["agent.started", "agent.finished", "agent.error"].includes(event.data.payload?.kind))
			) {
				refresh()
				return
			}
			if (event.data?.type !== "runtimeResponse") return
			const pending = requests.current.get(event.data.payload?.requestId)
			if (!pending) return
			requests.current.delete(event.data.payload.requestId)
			if (pending.kind === "mutation") setBusy(false)
			if (event.data.payload.error) {
				setError(String(event.data.payload.error))
				return
			}
			const result = event.data.payload.result
			if (pending.kind === "sessions" && Array.isArray(result)) setSessions(result)
			if (pending.kind === "projects" && Array.isArray(result)) setProjects(result)
			if (pending.kind === "mutation") {
				setDialog(undefined)
				setEditing(undefined)
				if (result?.indexes?.warnings?.length)
					setError(t("common:ui.projectIndexWarning") + JSON.stringify(result.indexes.warnings))
				refresh()
			}
		}
		window.addEventListener("message", receive)
		refresh()
		return () => window.removeEventListener("message", receive)
	}, [refresh, t])

	const matches = (value: string) => value.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())
	const openAssign = (ids: string[]) => {
		setProjectId(projects[0]?.id ?? "")
		setName("")
		setError("")
		setDialog({ kind: "assign", ids })
	}
	/*
	 * A project made before it has any sessions.
	 *
	 * The assign flow can also create one, but only around conversations that
	 * already exist — it takes the workspace from the first of them. Starting
	 * empty there is nothing to read it from, so the window's own folder is what
	 * the project is filed under.
	 */
	const openCreate = () => {
		setName("")
		setError("")
		setDialog({ kind: "create" })
	}
	const submit = () => {
		if (!dialog || busy) return
		if (dialog.kind === "create") request("project.create", { name: name.trim(), session_ids: [], workspace })
		else if (dialog.kind === "assign")
			request(
				projectId ? "project.assign" : "project.create",
				projectId
					? { project_id: projectId, session_ids: dialog.ids }
					: { name: name.trim(), session_ids: dialog.ids },
			)
		else if (dialog.kind === "rename") request("project.rename", { id: dialog.project?.id, name: name.trim() })
		else request("project.delete", { id: dialog.project?.id })
	}
	const renderRow = (session: RuntimeSession) => (
		<div
			className="relative border-b border-vscode-sideBar-border py-2 pl-2"
			data-testid={`runtime-session-row-${session.id}`}
			key={session.id}>
			<div className="flex items-center">
				{editing === session.id ? (
					<Input
						aria-label={t("octocode.taskTitle")}
						className="min-w-0 flex-1"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
					/>
				) : (
					<button
						className="min-w-0 flex-1 truncate text-left before:absolute before:inset-0"
						aria-busy={loading === session.id}
						onClick={() => {
							setError("")
							setLoading(session.id)
							vscode.postMessage({ type: "openRuntimeSession", text: session.id })
						}}>
						{session.title}
					</button>
				)}
				<div className="relative z-10 ml-auto flex shrink-0 items-center gap-0">
					<Button
						className="size-8"
						variant="ghost"
						aria-label={t("common:ui.assignProject")}
						title={t("common:ui.assignProject")}
						disabled={busy}
						onClick={() => openAssign([session.id])}>
						<FolderPlus />
					</Button>
					{session.project_id && (
						<Button
							className="size-8"
							variant="ghost"
							aria-label={t("common:ui.returnToHistory")}
							title={t("common:ui.returnKeepArtifacts")}
							disabled={busy}
							onClick={() => request("project.assign", { session_ids: [session.id], project_id: null })}>
							<Undo2 />
						</Button>
					)}
					<span
						aria-label={t(`octocode.status.${session.status}`, {
							defaultValue: session.status,
						})}
						className={`flex size-8 items-center justify-center ${liveStatuses.has(session.status) ? "octo-hourglass-flip" : ""}`}
						data-status={session.status}
						data-testid={`runtime-session-status-${session.id}`}
						title={t(`octocode.status.${session.status}`, { defaultValue: session.status })}>
						{liveStatuses.has(session.status) ? (
							<Hourglass aria-hidden="true" className="size-4" />
						) : (
							// Finished, paused or failed: the hourglass settles into a bold ring.
							<Circle aria-hidden="true" className="size-4" strokeWidth={3} />
						)}
					</span>
					{editing === session.id ? (
						<>
							<Button
								className="size-8"
								aria-label={t("octocode.saveTitle")}
								variant="ghost"
								onClick={() => {
									request("session.update", {
										id: session.id,
										title: title.trim() || session.title,
									})
								}}>
								<Check />
							</Button>
							<Button
								className="size-8"
								aria-label={t("octocode.cancelEdit")}
								variant="ghost"
								onClick={() => setEditing(undefined)}>
								<X />
							</Button>
						</>
					) : (
						<Button
							className="size-8"
							aria-label={t("octocode.renameTask")}
							variant="ghost"
							onClick={() => {
								setEditing(session.id)
								setTitle(session.title)
							}}>
							<Pencil />
						</Button>
					)}
					<Button
						className="size-8"
						aria-label={t("octocode.deleteTask")}
						disabled={busy || ["prepared", "running"].includes(session.status)}
						variant="ghost"
						onClick={() => {
							request("session.delete", { id: session.id })
						}}>
						<Trash2 />
					</Button>
				</div>
			</div>
			<div className="text-xs text-vscode-descriptionForeground">
				{t(`octocode.status.${session.status}`, { defaultValue: session.status })} ·{" "}
				{new Date(session.updated_at).toLocaleString()}
			</div>
		</div>
	)
	return (
		<div className="h-full overflow-auto" aria-label={t("octocode.taskHistory")}>
			{loading && (
				<div className="p-2 text-xs text-vscode-descriptionForeground" role="status">
					{t("common:ui.loadingHistory")}
				</div>
			)}
			{error && !dialog && (
				<div role="alert" className="p-2 text-vscode-errorForeground">
					{error}
				</div>
			)}
			<details open data-testid="runtime-projects-section">
				<summary className="flex cursor-pointer items-center gap-1 py-2 pl-2 pr-1 font-semibold">
					<span className="min-w-0 flex-1 truncate">{t("common:ui.projects")}</span>
					<GlyphButton glyph="+" label={t("common:ui.newProject")} disabled={busy} onClick={openCreate} />
				</summary>
				<div className="flex items-center justify-between p-2">
					{projects.length > 0 && (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => request("project.refresh", {})}>
							{t("common:ui.refreshArtifactIndex")}
						</Button>
					)}
				</div>
				{projects.length === 0 && (
					<p className="px-2 text-xs text-vscode-descriptionForeground">{t("common:ui.noProjects")}</p>
				)}
				{projects
					.filter((p) => matches(p.name) || sessions.some((s) => s.project_id === p.id && matches(s.title)))
					.map((project) => (
						<details open className="pl-2" key={project.id} data-testid={`runtime-project-${project.id}`}>
							<summary
								className="flex cursor-pointer items-center gap-1 py-2 pl-2 pr-1"
								title={project.name}>
								<span className="min-w-0 flex-1 truncate">
									{project.name}（{sessions.filter((s) => s.project_id === project.id).length}）
								</span>
								<GlyphButton
									glyph="E"
									label={t("common:ui.renameProject")}
									disabled={busy}
									onClick={() => {
										setName(project.name)
										setError("")
										setDialog({ kind: "rename", project })
									}}
								/>
								<GlyphButton
									glyph="−"
									label={t("common:ui.deleteProject")}
									disabled={busy}
									onClick={() => {
										setError("")
										setDialog({ kind: "delete", project })
									}}
								/>
							</summary>
							{sessions
								.filter(
									(s) => s.project_id === project.id && (matches(project.name) || matches(s.title)),
								)
								.map(renderRow)}
							<Button
								size="sm"
								variant="ghost"
								title={`${project.directory}/artifacts.json`}
								onClick={() =>
									vscode.postMessage({
										type: "openFile",
										text: `${project.directory}/artifacts.json`,
									})
								}>
								{t("common:ui.viewArtifactIndex")}
							</Button>
						</details>
					))}
			</details>
			<details
				open
				className="mt-3 border-t border-dashed border-vscode-descriptionForeground pt-2"
				data-testid="runtime-history-section">
				<summary className="cursor-pointer p-2 font-semibold">{t("common:ui.taskHistory")}</summary>
				{sessions.filter((s) => !s.project_id && matches(s.title)).map(renderRow)}
				{sessions.every((s) => Boolean(s.project_id)) && (
					<div className="p-2 text-xs text-vscode-descriptionForeground">{t("common:ui.noTaskHistory")}</div>
				)}
			</details>
			<Dialog
				open={Boolean(dialog)}
				onOpenChange={(open) => {
					if (!open && !busy) setDialog(undefined)
				}}>
				<DialogContent>
					<DialogTitle>
						{dialog?.kind === "assign"
							? t("common:ui.assignProject")
							: dialog?.kind === "create"
								? t("common:ui.newProject")
								: dialog?.kind === "rename"
									? t("common:ui.renameProject")
									: t("common:ui.deleteProject")}
					</DialogTitle>
					<DialogDescription>
						{dialog?.kind === "delete"
							? t("common:ui.deleteProjectDescription")
							: t("common:ui.projectDescription")}
					</DialogDescription>
					{dialog?.kind === "assign" && projects.length > 0 && (
						<label>
							{t("common:ui.targetProject")}
							<select
								aria-label={t("common:ui.targetProject")}
								className="block w-full bg-vscode-input-background p-2"
								value={projectId}
								disabled={busy}
								onChange={(e) => setProjectId(e.target.value)}>
								<option value="">{t("common:ui.newProject")}</option>
								{projects.map((p) => (
									<option value={p.id} key={p.id}>
										{p.name}
									</option>
								))}
							</select>
						</label>
					)}
					{(dialog?.kind === "rename" ||
						dialog?.kind === "create" ||
						(dialog?.kind === "assign" && !projectId)) && (
						<Input
							autoFocus
							aria-label={t("common:ui.projectName")}
							placeholder={t("common:ui.projectNamePlaceholder")}
							maxLength={100}
							value={name}
							disabled={busy}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim()) submit()
							}}
						/>
					)}
					{error && (
						<div role="alert" className="text-vscode-errorForeground">
							{error}
						</div>
					)}
					<Button
						disabled={
							busy ||
							((dialog?.kind === "rename" ||
								dialog?.kind === "create" ||
								(dialog?.kind === "assign" && !projectId)) &&
								!name.trim())
						}
						onClick={submit}>
						{busy ? t("common:ui.saving") : t("common:ui.confirm")}
					</Button>
				</DialogContent>
			</Dialog>
		</div>
	)
}

export default RuntimeHistoryView
