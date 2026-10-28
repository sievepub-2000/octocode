import { memo, useMemo, type ReactNode } from "react"
import {
	ArrowUpCircle,
	Glasses,
	Globe,
	LayoutPanelLeft,
	MessageSquare,
	Settings,
	Store,
	TerminalSquare,
	UserRound,
} from "lucide-react"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import TaskNavigationView from "@src/components/history/TaskNavigationView"
import { OctoCodeAuthBadge } from "@src/components/chat/OctoCodeAuthBadge"
import { vscode } from "@src/utils/vscode"

import { OctoCodeShell, type ShellRailItem } from "./OctoCodeShell"
import { UpdateRailBadge } from "./UpdateRailBadge"

import "./shell.css"

export type ShellTab = "chat" | "settings" | "marketplace"

interface ShellFrameProps {
	tab: ShellTab
	/**
	 * Settings section used to select the appearance or language shortcut.
	 */
	section?: string
	onSelect: (tab: ShellTab, section?: string) => void
	children: ReactNode
}

/**
 * Rail entries that bring one of the host's window panes forward.
 *
 * These replace the editor groups' tab strips: the groups no longer draw them,
 * so this is how you put the keyboard into one. They are not tabs of the main
 * column — the panes sit on screen beside it either way — so selecting one never
 * changes `tab`, and the rail's selection marker stays where it was.
 *
 * There is deliberately no browser entry. The integrated browser is opened by
 * whatever has a URL to show; `octocode.openBrowserPanel` only herds an existing
 * one into the right column and returns without creating anything, so an entry
 * wired to it would be a button that does nothing until a browser already
 * exists.
 */
const PANE_ENTRIES: readonly string[] = ["preview", "terminal"]

/**
 * Rail entries that open one section of settings.
 *
 * These are the managers that used to be their own tree views in the host
 * activity bar. They render inside settings now, so the rail cannot reach them
 * by tab alone — the id doubles as the section name, and selecting one opens
 * `settings` on it. They belong in the rail rather than buried in a settings
 * list because they are what you go and configure, not what you do while a task
 * runs.
 */
const SETTINGS_SECTION_ENTRIES: readonly string[] = ["ui", "language"]

/**
 * Wraps the app in the product's own chrome — but only where that makes sense.
 *
 * The same React app is mounted three times, distinguished only by
 * `renderContext`: once in the host's sidebar (the task list), once as a panel
 * (the artifact preview), and once as a full-window editor. The chrome belongs to
 * the third; rendering it in either of the others would nest a window layout
 * inside one of its own columns.
 *
 * The rail is in two halves, divided by a hairline. Above it are the errands:
 * appearance, language and the component marketplace. Below it is the task
 * column and the two host panes. Component management lives in the marketplace;
 * indexing lives in settings.
 *
 * Conversation history is in neither half. It lives permanently in the side
 * column, because it is something you navigate *while* working rather than a
 * place you switch the whole window to.
 *
 * The preview is deliberately NOT a column here. It stays an editor group of the
 * host's, next to the execution terminal in the group below it — that pairing is
 * the layout this product has always had, and reproducing the preview inside the
 * shell left the terminal nowhere to go but a full-width strip along the bottom.
 */
export const ShellFrame = memo(function ShellFrame({ tab, section, onSelect, children }: ShellFrameProps) {
	const { renderContext } = useExtensionState()
	const { t } = useAppTranslation()

	const rail = useMemo<ShellRailItem[]>(
		() => [
			/*
			 * Above the hairline: what you go and configure.
			 *
			 * Appearance and language open their existing settings sections.
			 */
			{ id: "ui", label: t("settings:sections.ui", { defaultValue: "Interface" }), icon: <Glasses size={20} /> },
			{
				id: "language",
				label: t("settings:sections.language", { defaultValue: "Language" }),
				icon: <Globe size={20} />,
			},
			{
				id: "marketplace",
				label: t("common:ui.marketplace"),
				icon: <Store size={20} />,
			},
			/*
			 * Below it: where the work is.
			 *
			 * The task column and the two host panes are what a running task lives in,
			 * and you move between them constantly — nothing like the errands above, so
			 * the hairline separates them rather than letting the rail read as one list.
			 */
			{
				id: "chat",
				label: t("chat:task.title", { defaultValue: "Chat" }),
				icon: <MessageSquare size={20} />,
				separatorBefore: true,
			},
			{
				id: "preview",
				label: t("common:octocode.preview", { defaultValue: "Preview" }),
				icon: <LayoutPanelLeft size={20} />,
			},
			{
				id: "terminal",
				label: t("common:octocode.terminal", { defaultValue: "Terminal" }),
				icon: <TerminalSquare size={20} />,
			},
			/*
			 * The update entry, beside settings because that is where it leads.
			 *
			 * The host already draws this as a status-bar item, but the shell hides
			 * that part on purpose, so in the default layout the red dot had no
			 * surface at all. The badge renders nothing until a configured channel
			 * has something to offer, and then the dot is the button: one click
			 * installs and reloads.
			 */
			{
				id: "update",
				label: t("common:octocode.update", { defaultValue: "Update" }),
				icon: <ArrowUpCircle size={20} />,
				footer: true,
				render: <UpdateRailBadge />,
			},
			{
				id: "settings",
				label: t("settings:common.title", { defaultValue: "Settings" }),
				icon: <Settings size={20} />,
				footer: true,
			},
			/*
			 * The account entry, where the host's accounts badge used to sit.
			 *
			 * It is the same component the chat toolbar uses, so there is exactly one
			 * authentication surface in the product: it shows the operating-system
			 * account while nobody is signed in, and the existing OAuth sign-in is one
			 * click away inside it.
			 */
			{
				id: "account",
				label: t("common:octocode.account", { defaultValue: "Account" }),
				icon: <UserRound size={20} />,
				footer: true,
				// `ml-0` undoes the toolbar spacing the badge carries by default;
				// tailwind-merge makes the later class win rather than both applying.
				render: <OctoCodeAuthBadge align="left" className="ml-0" />,
			},
		],
		[t],
	)

	if (renderContext !== "editor") {
		return <>{children}</>
	}

	const handleRailSelect = (id: string) => {
		if (PANE_ENTRIES.includes(id)) {
			/*
			 * Let go of the keyboard before asking the host to take it.
			 *
			 * The host cannot pull focus out of a focused webview: it marks the
			 * target group active — the window title changes — while the keystrokes
			 * keep going to the chat box. Measured on a running build, where
			 * `document.activeElement` in the workbench stayed the webview's iframe
			 * throughout. The host blurs that iframe as well; this releases the
			 * button inside it, so the webview stops reporting itself as focused
			 * and stops reclaiming what the host just took.
			 */
			;(document.activeElement as HTMLElement | null)?.blur()
			vscode.postMessage({ type: "revealWorkbenchPane", text: id })
			return
		}
		/*
		 * A section entry opens settings *on* that section.
		 *
		 * The section has to travel with the tab switch rather than be set beside
		 * it: the switch resets the remembered section, so setting it first left
		 * every one of these entries opening settings at the top instead.
		 */
		if (SETTINGS_SECTION_ENTRIES.includes(id)) {
			onSelect("settings", id)
			return
		}
		onSelect(id as ShellTab)
	}

	// Four entries share the `settings` tab, so the section is what tells them apart.
	const activeRailId = tab === "settings" && section && SETTINGS_SECTION_ENTRIES.includes(section) ? section : tab

	return (
		<OctoCodeShell
			rail={rail}
			activeRailId={activeRailId}
			onRailSelect={handleRailSelect}
			sideTitle={t("common:octocode.tasks", { defaultValue: "Tasks" })}
			side={<TaskNavigationView />}>
			{children}
		</OctoCodeShell>
	)
})
