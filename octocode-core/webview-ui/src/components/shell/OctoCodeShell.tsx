import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@src/lib/utils"

/**
 * The product's own window chrome.
 *
 * OctoCode used to borrow the host editor's chrome: its activity bar, its
 * sidebar, its auxiliary bar. That made the window only as controllable as the
 * host allowed, and it opened as the host's generic editor before swapping to
 * this product a moment later — visible to users and not fixable from here.
 *
 * So the management rail and the task list live in this webview instead. What
 * stays with the host is what the host is actually for: the editor grid, which
 * still carries the preview and the execution terminal in their own groups, plus
 * terminals, files, language servers and extensions.
 *
 * Column widths are state, not CSS constants, so the side panel can collapse
 * without the grid reflowing around a missing track.
 */

export interface ShellRailItem {
	id: string
	/** Icon-only control, so this is the accessible name and the tooltip. */
	label: string
	icon: ReactNode
	badge?: number
	/** Pinned to the bottom of the rail (settings, account). */
	footer?: boolean
	/**
	 * Draws a hairline above this entry.
	 *
	 * The rail carries two kinds of thing since the editor groups stopped drawing
	 * tab strips: surfaces the main column switches to, and window panes that are
	 * already on screen and just come forward. They behave differently, so they
	 * are separated rather than reading as one list.
	 */
	separatorBefore?: boolean
	/**
	 * Rendered in place of the standard button.
	 *
	 * The account entry is the reason this exists: signing in is not a "switch the
	 * window to a view" action like the rest of the rail, it opens a menu of its
	 * own. Giving it a slot keeps the authentication surface in the rail, where the
	 * host's accounts badge used to be, instead of forcing it to become a tab.
	 */
	render?: ReactNode
}

export interface OctoCodeShellProps {
	rail: readonly ShellRailItem[]
	activeRailId: string
	onRailSelect: (id: string) => void
	/** Left panel: task list, history. Hidden entirely when omitted. */
	side?: ReactNode
	sideTitle?: string
	children: ReactNode
}

/*
 * Side panel width.
 *
 * A remembered number rather than a constant: the column holds task titles and
 * conversation history, whose useful width depends on the work, and the host
 * sidebar this replaced could always be dragged. The bounds keep a drag from
 * producing a column too narrow to read or wide enough to crowd out the
 * conversation.
 */
const SIDE_WIDTH_DEFAULT = 300
const SIDE_WIDTH_MIN = 200
const SIDE_WIDTH_MAX = 560
// Width of the collapsed strip that offers to bring the column back. Wide
// enough to click comfortably, narrow enough not to crowd the conversation.
const SIDE_RESTORE_WIDTH = 34
const SIDE_WIDTH_KEY = "octocode.shell.sideWidth"
const SIDE_OPEN_KEY = "octocode.shell.sideOpen"

/*
 * What the conversation column needs, mirrored from shell.css.
 *
 * The bounds above stop a drag from making the *panel* unusable; this stops one
 * from making the conversation unusable, which is the failure that actually
 * showed: drag the panel out far enough and the composer's controls leave the
 * box, with nothing to say why. Kept in sync with `--octo-main-min-width`.
 */
const MAIN_MIN_WIDTH = 440
const RAIL_WIDTH = 56

const clampSideWidth = (value: number, available?: number) => {
	// `available` is the shell's own width, which is the first editor group and
	// not the window; on the server or before first layout it is unknown, and
	// then only the fixed bounds apply.
	const room = available && available > 0 ? available - RAIL_WIDTH - MAIN_MIN_WIDTH : Number.POSITIVE_INFINITY
	const ceiling = Math.max(SIDE_WIDTH_MIN, Math.min(SIDE_WIDTH_MAX, room))
	return Math.min(ceiling, Math.max(SIDE_WIDTH_MIN, Math.round(value)))
}

/**
 * Reads the remembered width.
 *
 * Storage can throw outright (a private window, site data blocked, thumbnail
 * capture), so a failure has to mean "use the default", never "fail to render".
 */
const readStoredSideWidth = () => {
	try {
		const stored = Number(localStorage.getItem(SIDE_WIDTH_KEY))
		return Number.isFinite(stored) && stored > 0 ? clampSideWidth(stored) : SIDE_WIDTH_DEFAULT
	} catch {
		return SIDE_WIDTH_DEFAULT
	}
}

/**
 * Reads the remembered open/collapsed state.
 *
 * Open unless the person explicitly collapsed it, so conversation history is
 * there when the window opens rather than missing until someone finds the
 * toggle. Only an explicit `"false"` collapses; a missing or unreadable value
 * means show the column, because the column is where the history lives.
 */
const readStoredSideOpen = () => {
	try {
		return localStorage.getItem(SIDE_OPEN_KEY) !== "false"
	} catch {
		return true
	}
}

export const OctoCodeShell = memo(function OctoCodeShell({
	rail,
	activeRailId,
	onRailSelect,
	side,
	sideTitle,
	children,
}: OctoCodeShellProps) {
	// Open on first paint and remembered thereafter: the column carries the
	// conversation history, so it should be there when the window opens, and
	// respect a deliberate collapse on the next one.
	const [sideOpen, setSideOpen] = useState(readStoredSideOpen)
	const [sideWidth, setSideWidth] = useState(readStoredSideWidth)
	const [dragging, setDragging] = useState(false)
	const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
	const shellRef = useRef<HTMLDivElement | null>(null)
	// The shell is the first editor group, not the window, so its width is the
	// only honest input to the clamp.
	const available = useCallback(() => shellRef.current?.clientWidth, [])

	/*
	 * Drag on the window, not on the handle.
	 *
	 * Listening on the handle alone loses the drag the moment the pointer outruns
	 * it — which it does immediately, because the handle is six pixels wide and
	 * the column is being resized out from under the cursor.
	 */
	useEffect(() => {
		if (!dragging) return undefined

		const onMove = (event: PointerEvent) => {
			const origin = dragRef.current
			if (!origin) return
			setSideWidth(clampSideWidth(origin.startWidth + (event.clientX - origin.startX), available()))
		}
		const onUp = () => {
			setDragging(false)
			dragRef.current = null
		}

		window.addEventListener("pointermove", onMove)
		window.addEventListener("pointerup", onUp)
		window.addEventListener("pointercancel", onUp)
		return () => {
			window.removeEventListener("pointermove", onMove)
			window.removeEventListener("pointerup", onUp)
			window.removeEventListener("pointercancel", onUp)
		}
	}, [dragging, available])

	// Remembered once the drag settles, so a drag writes one value instead of one
	// per pointer event.
	useEffect(() => {
		if (dragging) return
		try {
			localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth))
		} catch {
			// A viewer who cannot store simply gets the default next time.
		}
	}, [dragging, sideWidth])

	// Remembered the moment it changes: when the column is *not* there, a late
	// save means the history silently returns, which is the bug this fixes.
	useEffect(() => {
		try {
			localStorage.setItem(SIDE_OPEN_KEY, String(sideOpen))
		} catch {
			// A viewer who cannot store simply gets the default next time.
		}
	}, [sideOpen])

	const startDrag = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault()
			dragRef.current = { startX: event.clientX, startWidth: sideWidth }
			setDragging(true)
		},
		[sideWidth],
	)

	// Keyboard is the accessible equivalent of the drag, and the only way to
	// resize without a pointer.
	/*
	 * Pull the panel in when the shell itself gets narrower.
	 *
	 * Clamping only on drag left the window free to shrink underneath a panel
	 * that was already as wide as it was allowed to be, which is the same
	 * squeeze arriving by a different route.
	 */
	useEffect(() => {
		const element = shellRef.current
		if (!element || typeof ResizeObserver === "undefined") return undefined
		const observer = new ResizeObserver(() => setSideWidth((w) => clampSideWidth(w, element.clientWidth)))
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const nudgeWidth = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const step = event.shiftKey ? 48 : 16
			if (event.key === "ArrowLeft") {
				event.preventDefault()
				setSideWidth((w) => clampSideWidth(w - step, available()))
			} else if (event.key === "ArrowRight") {
				event.preventDefault()
				setSideWidth((w) => clampSideWidth(w + step, available()))
			}
		},
		[available],
	)

	const toggleSide = useCallback(() => setSideOpen((v) => !v), [])

	const hasSide = Boolean(side)
	const showSide = hasSide && sideOpen
	// A collapsed column still gets a strip: without one the only control that
	// could hide the history was inside the history, so collapsing it was a
	// one-way trip and the conversations looked deleted.
	const showRestore = hasSide && !sideOpen

	// Only the tracks that are actually rendered appear here, so a collapsed
	// panel leaves no empty column behind.
	// The track keeps the same floor as the column inside it, so a wide panel
	// cannot win the grid a fight the CSS would then lose.
	const columns = [
		"var(--octo-rail-width)",
		showSide ? `${sideWidth}px` : showRestore ? `${SIDE_RESTORE_WIDTH}px` : null,
		"minmax(var(--octo-main-min-width), 1fr)",
	]
		.filter(Boolean)
		.join(" ")

	const footerItems = rail.filter((i) => i.footer)
	const mainItems = rail.filter((i) => !i.footer)

	const renderRailButton = (item: ShellRailItem) => {
		const body = item.render ? (
			<div className="octo-rail-slot" title={item.label}>
				{item.render}
			</div>
		) : (
			<button
				type="button"
				aria-label={item.label}
				title={item.label}
				aria-current={item.id === activeRailId ? "page" : undefined}
				onClick={() => onRailSelect(item.id)}
				className={cn(
					"octo-rail-item",
					// The active marker is a pseudo-element so it cannot shift the icon.
					item.id === activeRailId && "octo-rail-item--active",
				)}>
				{item.icon}
				{item.badge ? <span className="octo-rail-badge">{item.badge > 99 ? "99+" : item.badge}</span> : null}
			</button>
		)
		// The separator is a wrapper rather than a sibling so the flex gap stays
		// even on both sides of it.
		return (
			<div key={item.id} className={cn("octo-rail-cell", item.separatorBefore && "octo-rail-cell--divided")}>
				{body}
			</div>
		)
	}

	return (
		<div
			ref={shellRef}
			className="octo-shell"
			style={{ gridTemplateColumns: columns, "--octo-side-width": `${sideWidth}px` } as React.CSSProperties}>
			{/*
			 * The management rail: the surfaces you switch the window between, plus
			 * the account entry pinned to the bottom. Icons only, so every entry
			 * carries its label as both the accessible name and the tooltip.
			 */}
			<nav className="octo-rail" aria-label={sideTitle ?? "OctoCode"}>
				<div className="octo-rail-group">{mainItems.map(renderRailButton)}</div>
				<div className="octo-rail-group octo-rail-group--footer">{footerItems.map(renderRailButton)}</div>
			</nav>

			{showSide ? (
				<aside className="octo-side" aria-label={sideTitle}>
					{sideTitle ? (
						<header className="octo-panel-header">
							<span className="octo-panel-title">{sideTitle}</span>
							<button
								type="button"
								className="octo-panel-collapse"
								aria-label={`Collapse ${sideTitle}`}
								onClick={toggleSide}>
								‹
							</button>
						</header>
					) : null}
					<div className="octo-panel-body">{side}</div>
				</aside>
			) : showRestore ? (
				/*
				 * The collapsed strip: the way back.
				 *
				 * The only control that hid this column lived inside it, so once
				 * collapsed there was nothing left to press and the conversation
				 * history looked deleted — the complaint this answers. A thin
				 * rail-edge button keeps the column one click away at all times.
				 */
				<button
					type="button"
					className="octo-side-restore"
					aria-label={`Show ${sideTitle ?? "tasks"}`}
					title={`Show ${sideTitle ?? "tasks"}`}
					onClick={toggleSide}>
					›
				</button>
			) : null}

			{/*
			 * The resize grip, and a sibling of the panel rather than a child of it.
			 *
			 * Inside the panel it was unusable: `.octo-side` clips its overflow, so a
			 * grip straddling the edge lost its outer half and left a three-pixel
			 * target. Out here it can sit centred on the boundary, positioned by the
			 * same width the grid column uses.
			 *
			 * It is a separator rather than a button: it has a position along an axis,
			 * which is what `aria-valuenow` reports and what the arrow keys change.
			 */}
			{showSide ? (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label={sideTitle ? `Resize ${sideTitle}` : "Resize panel"}
					aria-valuenow={sideWidth}
					aria-valuemin={SIDE_WIDTH_MIN}
					aria-valuemax={SIDE_WIDTH_MAX}
					tabIndex={0}
					className={cn("octo-resize-handle", dragging && "octo-resize-handle--active")}
					onPointerDown={startDrag}
					onKeyDown={nudgeWidth}
				/>
			) : null}

			<main className="octo-main">{children}</main>
		</div>
	)
})
