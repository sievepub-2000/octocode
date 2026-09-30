import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpToLine, Trash2 } from "lucide-react"

import { QueuedMessage } from "@roo-code/types"

import { Button } from "@src/components/ui"

import Thumbnails from "../common/Thumbnails"

import { Mention } from "./Mention"

interface QueuedMessagesProps {
	queue: QueuedMessage[]
	onRemove: (index: number) => void
	onUpdate: (index: number, newText: string) => void
	/** Promotes among multiple messages; a single or promoted message enters the active conversation. */
	onPushNow: (index: number) => void
}

/** Grow the editor to its content so the whole message is visible while editing. */
function fitToContent(textarea: HTMLTextAreaElement) {
	textarea.style.height = "auto"
	textarea.style.height = `${textarea.scrollHeight}px`
}

export const QueuedMessages = ({ queue, onRemove, onUpdate, onPushNow }: QueuedMessagesProps) => {
	const { t } = useTranslation("chat")
	const [editingStates, setEditingStates] = useState<Record<string, { isEditing: boolean; value: string }>>({})

	if (queue.length === 0) {
		return null
	}

	const getEditState = (messageId: string, currentText: string) => {
		return editingStates[messageId] || { isEditing: false, value: currentText }
	}

	const setEditState = (messageId: string, isEditing: boolean, value?: string) => {
		setEditingStates((prev) => ({
			...prev,
			[messageId]: { isEditing, value: value ?? prev[messageId]?.value ?? "" },
		}))
	}

	const editingId = queue.find((message) => editingStates[message.id]?.isEditing)?.id

	const handleSaveEdit = (index: number, messageId: string, newValue: string) => {
		onUpdate(index, newValue)
		setEditState(messageId, false)
	}

	return (
		<div data-testid="queued-messages">
			<div className={`flex flex-col gap-1 overflow-y-auto text-xs ${editingId ? "max-h-[60vh]" : "max-h-36"}`}>
				{queue.map((message, index) => {
					const editState = getEditState(message.id, message.text)
					const collapsed = editingId !== undefined && editingId !== message.id
					const pushLabel = t(
						queue.length === 1 || (index === 0 && message.priority)
							? "common:ui.pushQueuedMessageNow"
							: "common:ui.pushQueuedMessage",
					)

					return (
						<div key={message.id} className="overflow-hidden whitespace-pre-wrap flex-shrink-0">
							<div className="flex justify-between">
								<div className="flex-grow px-2 py-1 wrap-anywhere">
									{editState.isEditing ? (
										<textarea
											ref={(textarea) => {
												if (textarea && textarea !== document.activeElement) {
													// Set cursor at the end
													textarea.setSelectionRange(
														textarea.value.length,
														textarea.value.length,
													)
												}
												if (textarea) fitToContent(textarea)
											}}
											value={editState.value}
											aria-label={t("common:ui.editQueuedMessage")}
											onChange={(e) => {
												setEditState(message.id, true, e.target.value)
												fitToContent(e.target)
											}}
											onBlur={() => handleSaveEdit(index, message.id, editState.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
													e.preventDefault()
													handleSaveEdit(index, message.id, editState.value)
												}
												if (e.key === "Escape") {
													setEditState(message.id, false, message.text)
												}
											}}
											className="w-full max-h-[50vh] overflow-y-auto bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-2 py-1 resize-none focus:outline-0 focus:ring-1 focus:ring-vscode-focusBorder"
											placeholder={t("chat:editMessage.placeholder")}
											autoFocus
											rows={Math.max(editState.value.split("\n").length, 2)}
										/>
									) : (
										<button
											type="button"
											onClick={() => setEditState(message.id, true, message.text)}
											className={`w-full border-none bg-transparent text-left cursor-pointer hover:bg-vscode-list-hoverBackground px-1 py-0.5 -mx-1 -my-0.5 rounded transition-colors ${collapsed ? "truncate whitespace-nowrap" : ""}`}
											data-collapsed={collapsed || undefined}
											title={t("chat:queuedMessages.clickToEdit")}>
											{collapsed ? (
												message.text.split("\n")[0]
											) : (
												<Mention text={message.text} withShadow />
											)}
										</button>
									)}
								</div>
								<div className="flex">
									<Button
										variant="ghost"
										aria-label={pushLabel}
										title={pushLabel}
										size="icon"
										className="shrink-0"
										onClick={(e) => {
											e.stopPropagation()
											onPushNow(index)
										}}>
										<ArrowUpToLine className="h-4 w-4" />
									</Button>
									<Button
										variant="ghost"
										aria-label={t("common:ui.deleteQueuedMessage")}
										size="icon"
										className="shrink-0"
										onClick={(e) => {
											e.stopPropagation()
											onRemove(index)
										}}>
										<Trash2 className="h-4 w-4" />
									</Button>
								</div>
							</div>
							{message.images && message.images.length > 0 && (
								<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
