import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type IndexLocationWithAlign, type VirtuosoHandle } from "react-virtuoso"
import { CheckCircle2, Hourglass, LoaderCircle, TerminalSquare } from "lucide-react"
import { useTranslation } from "react-i18next"

import { compactTranscriptEvents, describeRuntimeEvent, type RuntimeEvent } from "../artifacts/runtimeEvent"
import MarkdownBlock from "../common/MarkdownBlock"
import Thumbnails from "../common/Thumbnails"
import MessageTimestamp from "./MessageTimestamp"

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

type TranscriptContext = Pick<Props, "prompt" | "images" | "running" | "phase">
const initialVirtualLocation = { index: "LAST" as const, align: "end" as const }

function sameTranscriptEvent(left: RuntimeEvent, right: RuntimeEvent): boolean {
	return (
		left.session_id === right.session_id &&
		left.task_id === right.task_id &&
		left.kind === right.kind &&
		left.created_at === right.created_at &&
		(left.payload === right.payload || JSON.stringify(left.payload) === JSON.stringify(right.payload))
	)
}

const virtualComponents = {
	Header: ({ context }: { context?: TranscriptContext }) =>
		context ? (
			<div className="px-4 pt-3 pb-4">
				<div className="octo-user-bubble ml-auto max-w-[85%] rounded-md px-3 py-2">
					{context.prompt}
					{context.images && context.images.length > 0 && <Thumbnails images={context.images} />}
				</div>
			</div>
		) : null,
	Footer: ({ context }: { context?: TranscriptContext }) => {
		const { t } = useTranslation("common")
		return (
			<div className="px-4 pb-3">
				{context?.running && (
					<div
						aria-label={t("octocode.status.running")}
						className="flex items-center gap-1.5 py-1 text-sm text-vscode-descriptionForeground"
						data-testid="runtime-wait-placeholder"
						role="status">
						<span className="octo-wait-label">
							{context.phase === "executing"
								? t("chat:commandExecution.executing", { defaultValue: "Executing" })
								: t("chat:reasoning.thinking", { defaultValue: "Thinking" })}
						</span>
						<Hourglass aria-hidden="true" className="octo-hourglass-flip" size={14} />
					</div>
				)}
				<div className="h-8" aria-hidden="true" />
			</div>
		)
	},
}

const RuntimeTranscript = ({ prompt, images = [], events, running, phase, onSelectOption }: Props) => {
	const { t } = useTranslation("common")
	const end = useRef<HTMLDivElement>(null)
	const scroller = useRef<HTMLDivElement>(null)
	const transcriptEvents = useMemo(() => compactTranscriptEvents(events), [events])
	// Virtuoso's inverse-pagination index keeps the same visible row when an
	// earlier history page is prepended. Stable absolute indices also keep row state.
	// React state rolls back this adjustment if concurrent rendering is interrupted.
	const [listPosition, setListPosition] = useState(() => ({ events: transcriptEvents, firstIndex: 1_000_000 }))
	if (listPosition.events !== transcriptEvents) {
		const previous = listPosition.events
		let firstIndex = listPosition.firstIndex
		if (previous[0] && transcriptEvents[0] && !sameTranscriptEvent(previous[0], transcriptEvents[0])) {
			const inserted = transcriptEvents.findIndex((event) => sameTranscriptEvent(event, previous[0]))
			if (inserted > 0 && transcriptEvents.length >= previous.length + inserted) firstIndex -= inserted
		}
		setListPosition({ events: transcriptEvents, firstIndex })
	}
	const [virtualized, setVirtualized] = useState(transcriptEvents.length > 100)
	const virtualLocation = useRef<IndexLocationWithAlign>(initialVirtualLocation)
	const virtualList = useRef<VirtuosoHandle>(null)
	const setScroller = useCallback((element: HTMLElement | Window | null) => {
		scroller.current = element instanceof HTMLElement ? (element as HTMLDivElement) : null
	}, [])

	// Follow new output only while the reader is on the last screen; once they
	// scroll up to reread, leave them there until they come back down.
	const following = useRef(true)
	const lastKind = events.at(-1)?.kind
	useLayoutEffect(() => {
		if (virtualized || transcriptEvents.length <= 100) return
		const element = scroller.current
		if (element && !following.current) {
			const top = element.getBoundingClientRect().top
			const visible = [...element.querySelectorAll<HTMLElement>("[data-transcript-index]")].find(
				(row) => row.getBoundingClientRect().bottom > top + 10,
			)
			if (visible) {
				virtualLocation.current = {
					index: Number(visible.dataset.transcriptIndex),
					align: "start",
					offset: top - visible.getBoundingClientRect().top,
				}
			}
		}
		// Capture the ordinary DOM's reading position before replacing its scroller.
		setVirtualized(true)
	}, [virtualized, transcriptEvents.length, listPosition.firstIndex])
	useLayoutEffect(() => {
		if (virtualized) {
			if (lastKind === "user.message")
				virtualList.current?.scrollToIndex({
					index: transcriptEvents.length - 1,
					align: "end",
				})
		} else if (following.current || lastKind === "user.message") end.current?.scrollIntoView({ block: "end" })
	}, [events, lastKind, virtualized, transcriptEvents.length, listPosition.firstIndex])
	useEffect(() => {
		const element = scroller.current
		if (!element) return
		const update = () => {
			following.current = isNearBottom(element)
		}
		element.addEventListener("scroll", update, { passive: true })
		return () => element.removeEventListener("scroll", update)
	}, [virtualized])
	const renderEvent = useCallback(
		(event: RuntimeEvent, index: number) => {
			const text = describeRuntimeEvent(event, {
				completed: t("octocode.roundFinished", { defaultValue: "本轮执行结束" }),
				stopped: t("octocode.status.stopped"),
				unknown: t("octocode.status.unknown"),
				prefillMemory: t("octocode.error.prefillMemory", {
					defaultValue: "模型服务预填充内存不足。当前对话已保留，服务恢复后可在此对话重试。",
				}),
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
					<Fragment key={`${event.task_id}-${index}`}>
						<MessageTimestamp timestamp={event.created_at} />
						<p className="whitespace-pre-wrap text-xs leading-relaxed text-vscode-descriptionForeground">
							{text}
						</p>
					</Fragment>
				)
			}
			if (event.kind === "text") {
				return (
					<Fragment key={`${event.task_id}-${index}`}>
						<MessageTimestamp timestamp={event.created_at} />
						<div className="min-w-0 break-words">
							<MarkdownBlock markdown={text} />
						</div>
					</Fragment>
				)
			}
			if (event.kind === "agent.needs_input") {
				const options =
					event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
						? (event.payload as { options?: unknown }).options
						: undefined
				return (
					<Fragment key={`${event.task_id}-${index}`}>
						<MessageTimestamp timestamp={event.created_at} />
						<div className="border-l-2 border-vscode-button-background pl-2 text-sm">
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
					</Fragment>
				)
			}
			const Icon =
				event.kind === "agent.finished"
					? CheckCircle2
					: event.kind === "agent.started"
						? LoaderCircle
						: TerminalSquare
			return (
				<Fragment key={`${event.task_id}-${index}`}>
					<MessageTimestamp timestamp={event.created_at} />
					<div className="flex items-start gap-2 border-l-2 border-vscode-panel-border pl-2 text-sm">
						<Icon className={event.kind === "agent.started" ? "mt-0.5 animate-spin" : "mt-0.5"} size={15} />
						<div className="min-w-0">
							<div className="text-xs text-vscode-descriptionForeground">
								{event.kind.startsWith("auto_compact_")
									? t("common:ui.contextCompaction")
									: t(`octocode.event.${event.kind}`, { defaultValue: event.kind })}
							</div>
							<pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
						</div>
					</div>
				</Fragment>
			)
		},
		[t, onSelectOption],
	)
	const context = useMemo(() => ({ prompt, images, running, phase }), [prompt, images, running, phase])

	if (virtualized) {
		return (
			<Virtuoso
				ref={virtualList}
				className="min-h-0 flex-1"
				aria-live="polite"
				data={transcriptEvents}
				firstItemIndex={listPosition.firstIndex}
				context={context}
				scrollerRef={setScroller}
				components={virtualComponents}
				initialTopMostItemIndex={virtualLocation.current}
				increaseViewportBy={300}
				followOutput={() => (following.current ? "auto" : false)}
				itemContent={(index, event) => (
					<div className="flow-root min-w-0 space-y-2 px-4 pb-2">{renderEvent(event, index)}</div>
				)}
			/>
		)
	}

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
				{transcriptEvents.map((event, index) => (
					<div
						className="flow-root space-y-2"
						data-transcript-index={index}
						key={`${event.task_id}-${index}`}>
						{renderEvent(event, index)}
					</div>
				))}
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
