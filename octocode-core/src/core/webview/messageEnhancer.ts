import { ProviderSettings, GlobalState, TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { supportPrompt } from "../../shared/support-prompt"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"

export interface MessageEnhancerOptions {
	text: string
	apiConfiguration: ProviderSettings
	customSupportPrompts?: GlobalState["customSupportPrompts"]
	listApiConfigMeta: Array<{ id: string; name?: string }>
	enhancementApiConfigId?: string
	includeTaskHistoryInEnhance?: boolean
	/** Raw message.list rows, never Runtime events or provider configuration. */
	runtimeMessages?: readonly unknown[]
	providerSettingsManager: ProviderSettingsManager
}

export interface MessageEnhancerResult {
	success: boolean
	enhancedText?: string
	error?: string
}

/**
 * Enhances a message prompt using AI, optionally including task history for context
 */
export class MessageEnhancer {
	/**
	 * Enhances a message prompt using the configured AI provider
	 * @param options Configuration options for message enhancement
	 * @returns Enhanced message result with success status
	 */
	static async enhanceMessage(options: MessageEnhancerOptions): Promise<MessageEnhancerResult> {
		try {
			const {
				text,
				apiConfiguration,
				customSupportPrompts,
				listApiConfigMeta,
				enhancementApiConfigId,
				includeTaskHistoryInEnhance,
				runtimeMessages,
				providerSettingsManager,
			} = options

			// Determine which API configuration to use
			let configToUse: ProviderSettings = apiConfiguration

			// Try to get enhancement config first, fall back to current config
			if (enhancementApiConfigId && listApiConfigMeta.find(({ id }) => id === enhancementApiConfigId)) {
				const { name: _, ...providerSettings } = await providerSettingsManager.getProfile({
					id: enhancementApiConfigId,
				})

				if (providerSettings.apiProvider) {
					configToUse = providerSettings
				}
			}

			// Prepare the prompt to enhance
			let promptToEnhance = text

			// Include task history if enabled and available
			if (includeTaskHistoryInEnhance && runtimeMessages && runtimeMessages.length > 0) {
				const taskHistory = this.extractTaskHistory(runtimeMessages)
				if (taskHistory) {
					promptToEnhance = `${text}\n\nUse the following previous conversation context as needed:\n${taskHistory}`
				}
			}

			// Create the enhancement prompt using the support prompt system
			const enhancementPrompt = supportPrompt.create(
				"ENHANCE",
				{ userInput: promptToEnhance },
				customSupportPrompts,
			)

			// Call the single completion handler to get the enhanced prompt
			const enhancedText = await singleCompletionHandler(configToUse, enhancementPrompt)

			return {
				success: true,
				enhancedText,
			}
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	/**
	 * Reads only persisted user/assistant text. Native runs may persist only user
	 * rows; thought/tool events are deliberately not synthesized into conversation.
	 * @param messages Runtime message.list rows
	 * @returns Formatted task history string
	 */
	private static extractTaskHistory(messages: readonly unknown[]): string {
		try {
			const relevantMessages = messages
				.flatMap((message) => {
					if (!message || typeof message !== "object" || Array.isArray(message)) return []
					const row = message as Record<string, unknown>
					if (
						(row.role !== "user" && row.role !== "assistant") ||
						typeof row.content !== "string" ||
						!row.content.trim()
					)
						return []
					return [{ role: row.role, content: row.content }]
				})
				.slice(-10) // Limit to last 10 messages to avoid context explosion

			return relevantMessages
				.map((msg) => {
					const role = msg.role === "user" ? "User" : "Assistant"
					const content = msg.content
					// Truncate long messages
					return `${role}: ${content.slice(0, 500)}${content.length > 500 ? "..." : ""}`
				})
				.join("\n")
		} catch (error) {
			// Log error but don't fail the enhancement
			console.error("Failed to extract Runtime task history")
			return ""
		}
	}

	/**
	 * Captures telemetry for prompt enhancement
	 * @param taskId Optional task ID for telemetry tracking
	 * @param includeTaskHistory Whether task history was included in the enhancement
	 */
	static captureTelemetry(taskId?: string, includeTaskHistory?: boolean): void {
		if (TelemetryService.hasInstance()) {
			// Use captureEvent directly to include the includeTaskHistory property
			TelemetryService.instance.captureEvent(TelemetryEventName.PROMPT_ENHANCED, {
				...(taskId && { taskId }),
				includeTaskHistory: includeTaskHistory ?? false,
			})
		}
	}
}
