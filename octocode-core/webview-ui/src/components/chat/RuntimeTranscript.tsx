import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { CheckCircle2, Hourglass, LoaderCircle, TerminalSquare } from "lucide-react"
import { useTranslation } from "react-i18next"

import { compactTranscriptEvents, describeRuntimeEvent, type RuntimeEvent } from "../artifacts/runtimeEvent"
import MarkdownBlock from "../common/MarkdownBlock"
import Thumbnails from "../common/Thumbnails"

type Props = {
	prompt: string
	images?: string[]
	events: RuntimeEvent[]
	running: boolean
	phase: "executing" | "thinking"
	onSelectOption: (answer: string) => void
}

/** Within a quarter screen (at least 48px) of the end counts as reading the latest output. */
export function isNearBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
	const distance = element.scrollHeight - element.scrollTop - element.clientHeight
	return distance <= Math.max(48, element.clientHeight * 0.25)
}

const RuntimeTranscript = ({ prompt, images = [], events, running, phase, onSelectOption }: Props) => {
	const { t } = useTranslation("common")
	const end = useRef<HTMLDivElement>(null)
	const scroller = useRef<HTMLDivElement>(null)
	// Follow new output only while the reader is on the last screen; once they
	// scroll up to reread, leave them there until they come back down.
	const following = useRef(true)
	const lastKind = events.at(-1)?.kind
	useLayoutEffect(() => {
		if (following.current || lastKind === "user.message") end.current?.scrollIntoView({ block: "end" })
	}, [events, lastKind])
	useEffect(() => {
		const element = scroller.current
		if (!element) return
		const update = () => {
			following.current = isNearBottom(element)
		}
		element.addEventListener("scroll", update, { passive: true })
		return () => element.removeEventListener("scroll", update)
	}, [])
	const transcriptEvents = useMemo(() => compactTranscriptEvents(events), [events])

	return (
		<div
			ref={scroller}
			className="min-h-0 flex-1 overflow-auto px-4 py-3"
			aria-live="polite"
			data-virtuoso-scroller="true">
			<div className="octo-user-bubble ml-auto max-w-[85%] rounded-md px-3 py-2">
				{prompt}
				{images.length > 0 && <Thumbnails images={images} />}
			</div>
			<div className="mt-4 space-y-2">
				{transcriptEvents.map((event, index) => {
					const text = describeRuntimeEvent(event, {
						completed: t("octocode.roundFinished", { defaultValue: "本轮执行结束" }),
						stopped: t("octocode.status.stopped"),
						unknown: t("octocode.status.unknown"),
					})
					if (event.kind === "user.message") {
						return (
							<div
								className="octo-user-bubble ml-auto max-w-[85%] rounded-md px-3 py-2"
								key={`${event.task_id}-${index}`}>
								{text}
								{Array.isArray((event.payload as { images?: unknown })?.images) && (
									<Thumbnails images={(event.payload as { images: string[] }).images} />
								)}
							</div>
						)
					}
					if (event.kind === "thought" || event.kind === "tool_call") {
						return (
							<p
								className="whitespace-pre-wrap text-xs leading-relaxed text-vscode-descriptionForeground"
								key={`${event.task_id}-${index}`}>
								{text}
							</p>
						)
					}
					if (event.kind === "text") {
						return (
							<div className="min-w-0 break-words" key={`${event.task_id}-${index}`}>
								<MarkdownBlock markdown={text} />
							</div>
						)
					}
					if (event.kind === "agent.needs_input") {
						const options =
							event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
								? (event.payload as { options?: unknown }).options
								: undefined
						return (
							<div
								className="border-l-2 border-vscode-button-background pl-2 text-sm"
								key={`${event.task_id}-${index}`}>
								<p className="m-0 whitespace-pre-wrap">{text}</p>
								{Array.isArray(options) && options.every((option) => typeof option === "string") && (
									<div className="mt-2 flex flex-wrap gap-2">
										{options.map((option) => (
											<button
												className="rounded border border-vscode-button-border bg-vscode-button-secondaryBackground px-2 py-1 text-sm hover:bg-vscode-button-secondaryHoverBackground"
												key={option}
												onClick={() => onSelectOption(option)}
												type="button">
												{option}
											</button>
										))}
									</div>
								)}
							</div>
						)
					}
					const Icon =
						event.kind === "agent.finished"
							? CheckCircle2
							: event.kind === "agent.started"
								? LoaderCircle
								: TerminalSquare
					return (
						<div
							className="flex items-start gap-2 border-l-2 border-vscode-panel-border pl-2 text-sm"
							key={`${event.task_id}-${index}`}>
							<Icon
								className={event.kind === "agent.started" ? "mt-0.5 animate-spin" : "mt-0.5"}
								size={15}
							/>
							<div className="min-w-0">
								<div className="text-xs text-vscode-descriptionForeground">
									{event.kind.startsWith("auto_compact_")
										? t("common:ui.contextCompaction")
										: t(`octocode.event.${event.kind}`, { defaultValue: event.kind })}
								</div>
								<pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
							</div>
						</div>
					)
				})}
				{running && (
					<div
						aria-label={t("octocode.status.running")}
						className="flex items-center gap-1.5 py-1 text-sm text-vscode-descriptionForeground"
						data-testid="runtime-wait-placeholder"
						role="status">
						<span className="octo-wait-label">
							{phase === "executing"
								? t("chat:commandExecution.executing", { defaultValue: "Executing" })
								: t("chat:reasoning.thinking", { defaultValue: "Thinking" })}
						</span>
						<Hourglass aria-hidden="true" className="octo-hourglass-flip" size={14} />
					</div>
				)}
			</div>
			<div ref={end} className="h-8" aria-hidden="true" />
		</div>
	)
}

export default RuntimeTranscript
