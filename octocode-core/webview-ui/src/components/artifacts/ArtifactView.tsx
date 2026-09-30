import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Box, ExternalLink, FileUp, Trash2 } from "lucide-react"

import { Button } from "@/components/ui"
import { vscode } from "@src/utils/vscode"

import type { ArtifactKind } from "./artifactKind"
import AudioWaveform from "./AudioWaveform"
import ThreeScene from "./ThreeScene"

type LogRecord = {
	id: number
	category?: "system" | "developer"
	session_id?: string
	tool_run_id?: string
	level: string
	subsystem: string
	message: string
	fields?: Record<string, unknown>
	created_at: number
}
type Artifact = {
	category?: "system" | "developer"
	content?: string
	kind: ArtifactKind
	path: string
	records?: LogRecord[]
	uri?: string
}

const ArtifactView = () => {
	const { t } = useTranslation("common")
	const [artifact, setArtifact] = useState<Artifact>()
	const [url, setUrl] = useState("http://localhost:3000")
	const removeLog = (id: number) => {
		vscode.postMessage({
			type: "runtimeRequest",
			payload: {
				requestId: crypto.randomUUID(),
				method: "log.delete",
				params: { id, category: artifact?.category ?? "system" },
			},
		})
		setArtifact((current) => current && { ...current, records: current.records?.filter((log) => log.id !== id) })
	}

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.data?.type === "artifactSelected") setArtifact(event.data.payload)
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [])

	// `h-full`, not `h-screen`: this view renders both as a standalone panel
	// (where the parent already fills the window, so the two are equivalent) and
	// as a column inside the shell, where a viewport-height element would
	// overflow its track.
	return (
		<main className="flex h-full flex-col bg-vscode-editor-background text-vscode-editor-foreground">
			<header className="flex flex-wrap items-center gap-2 border-b border-vscode-panel-border p-2">
				<strong className="mr-auto flex items-center gap-2">
					<Box size={16} />
					{t("octocode.inspector")}
				</strong>
				<Button variant="secondary" onClick={() => vscode.postMessage({ type: "selectArtifact" })}>
					<FileUp />
					{t("octocode.openFile")}
				</Button>
				<input
					aria-label={t("octocode.browserAddress")}
					className="h-7 min-w-48 flex-1 rounded border border-vscode-input-border bg-vscode-input-background px-2"
					onChange={(event) => setUrl(event.target.value)}
					value={url}
				/>
				<Button variant="secondary" onClick={() => vscode.postMessage({ type: "openArtifactBrowser", url })}>
					<ExternalLink />
					{t("octocode.browse")}
				</Button>
			</header>
			<section className="min-h-0 flex-1 overflow-auto p-3">
				{!artifact && (
					<div className="grid h-full place-content-center text-center text-vscode-descriptionForeground">
						<Box className="mx-auto mb-3" size={40} />
						<p className="m-0">{t("octocode.inspectorHint")}</p>
					</div>
				)}
				{artifact?.kind === "code" && (
					<pre className="m-0 whitespace-pre-wrap font-mono">{artifact.content}</pre>
				)}
				{artifact?.kind === "image" && (
					<img alt={artifact.path} className="h-full w-full object-contain" src={artifact.uri} />
				)}
				{artifact?.kind === "pdf" && (
					<iframe className="h-full w-full border-0" src={artifact.uri} title={artifact.path} />
				)}
				{artifact?.kind === "video" && <video className="h-full w-full" controls src={artifact.uri} />}
				{artifact?.kind === "audio" && artifact.uri && <AudioWaveform src={artifact.uri} />}
				{artifact?.kind === "model" && artifact.uri && <ThreeScene src={artifact.uri} />}
				{artifact?.kind === "logs" && (
					<div className="space-y-2" data-testid="log-record-list">
						{artifact.records?.map((log) => (
							<article className="rounded border border-vscode-panel-border p-3" key={log.id}>
								<header className="flex items-center gap-2 text-vscode-descriptionForeground">
									<strong className="text-vscode-editor-foreground">{log.level}</strong>
									<span>{log.subsystem}</span>
									<time className="ml-auto">{new Date(log.created_at).toLocaleString()}</time>
									<Button
										aria-label={t("octocode.deleteLog")}
										size="icon"
										variant="ghost"
										onClick={() => removeLog(log.id)}>
										<Trash2 />
									</Button>
								</header>
								<p className="my-2 whitespace-pre-wrap break-words font-mono">{log.message}</p>
								{(log.session_id ||
									log.tool_run_id ||
									(log.fields && Object.keys(log.fields).length > 0)) &&
									(artifact.category === "system" ? (
										<details className="text-vscode-descriptionForeground">
											<summary>{t("octocode.logDetails")}</summary>
											<pre className="whitespace-pre-wrap break-all">
												{JSON.stringify(
													{
														session_id: log.session_id,
														tool_run_id: log.tool_run_id,
														...log.fields,
													},
													null,
													2,
												)}
											</pre>
										</details>
									) : (
										<pre className="m-0 whitespace-pre-wrap break-all text-vscode-descriptionForeground">
											{JSON.stringify(
												{
													session_id: log.session_id,
													tool_run_id: log.tool_run_id,
													...log.fields,
												},
												null,
												2,
											)}
										</pre>
									))}
							</article>
						))}
					</div>
				)}
			</section>
		</main>
	)
}

export default ArtifactView
