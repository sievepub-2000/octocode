import React, { useCallback, useEffect, useState } from "react"
import { ArrowUpCircle } from "lucide-react"

import type { UpdateStatus, UpdateStatusMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"

/**
 * The update entry in the shell's rail.
 *
 * The extension host already paints this as a status-bar item, but the shell
 * hides that part on purpose, so in the product's default layout the red dot
 * existed only where nobody could see it. This is the same fact on a surface
 * the user actually has: a dot while an update waits, and the dot *is* the
 * button — clicking it installs and reloads.
 *
 * It renders nothing until a channel is configured and has something to offer,
 * so a healthy install gains no chrome.
 */
export const UpdateRailBadge: React.FC = () => {
	const { t } = useAppTranslation()
	const [status, setStatus] = useState<UpdateStatus | null>(null)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<UpdateStatusMessage>) => {
			if (event.data?.type !== "updateStatus") return
			setStatus(event.data.values)
		}
		window.addEventListener("message", handleMessage)
		// Ask once on mount; the rail outlives the check, so a late answer still
		// lands on a mounted listener.
		vscode.postMessage({ type: "requestUpdateStatus" })
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const apply = useCallback(() => {
		if (!status?.available || status.applying) return
		// Optimistic: the install ends in a window reload, so there is no
		// response to wait for and no state to un-race.
		setStatus((prev) => (prev ? { ...prev, applying: true } : prev))
		vscode.postMessage({ type: "applyUpdate" })
	}, [status])

	if (!status || !status.configured || !status.available) return null

	const label = status.applying
		? t("common:octocode.updateApplying", { defaultValue: "Installing update…" })
		: t("common:octocode.updateAvailable", {
				version: status.version ?? "",
				defaultValue: "Update ${version} is ready. Click to install and reload.",
			})

	return (
		<button
			type="button"
			className="octo-rail-item octo-rail-item--update"
			aria-label={label}
			title={label}
			disabled={status.applying}
			onClick={apply}>
			<ArrowUpCircle size={20} />
			{/*
			 * The dot is a span rather than the icon recoloured, so it stays a
			 * distinct signal from the icon's own colour and keeps working when
			 * the icon is swapped for a spinner.
			 */}
			<span className="octo-rail-dot" aria-hidden="true" />
		</button>
	)
}
