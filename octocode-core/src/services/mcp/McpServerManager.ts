import * as vscode from "vscode"
import { McpHub } from "./McpHub"
import { SecretStorageService } from "./SecretStorageService"
import { ClineProvider } from "../../core/webview/ClineProvider"

/** One shared Hub with one reference per active or pending provider. */
export class McpServerManager {
	private static instance: McpHub | null = null
	private static readonly GLOBAL_STATE_KEY = "mcpHubInstanceId"
	private static providers = new Map<ClineProvider, { hub?: McpHub }>()
	private static initializationPromise: Promise<McpHub> | null = null
	private static cleanupPromise: Promise<void> | null = null

	static async getInstance(context: vscode.ExtensionContext, provider: ClineProvider): Promise<McpHub> {
		let registration = this.providers.get(provider)
		if (!registration) {
			registration = {}
			this.providers.set(provider, registration)
		}
		try {
			while (this.cleanupPromise) await this.cleanupPromise
			if (this.providers.get(provider) !== registration) throw new Error("MCP provider was released")
			let hub = this.instance
			if (!hub || hub.disposed) {
				hub = new McpHub(provider, new SecretStorageService(context))
				this.instance = hub
				const createdHub = hub
				// Only serialize metadata, never network/server readiness, during acquisition.
				const initializing = Promise.resolve()
					.then(() => context.globalState.update(this.GLOBAL_STATE_KEY, Date.now().toString()))
					.then(() => createdHub)
				this.initializationPromise = initializing
				const clearInitialization = () => {
					if (this.initializationPromise === initializing) this.initializationPromise = null
				}
				void initializing.then(clearInitialization, clearInitialization)
			}
			if (registration.hub !== hub) {
				if (this.providers.get(provider) !== registration || this.instance !== hub || hub.disposed)
					throw new Error("MCP provider was released")
				const previousHub = registration.hub
				// Claim the old lease before yielding so overlapping gets release it once.
				registration.hub = undefined
				await previousHub?.unregisterClient()
				if (this.providers.get(provider) !== registration || this.instance !== hub || hub.disposed)
					throw new Error("MCP provider was released")
				if (registration.hub !== hub) {
					hub.registerClient()
					registration.hub = hub
					if (this.providers.size === 1) hub.setProvider(provider)
				}
			}
			const initializing = this.initializationPromise
			if (initializing) await initializing
			if (this.providers.get(provider) !== registration || this.instance !== hub || hub.disposed)
				throw new Error("MCP provider was released")
			return hub
		} catch (error) {
			if (this.providers.get(provider) === registration) {
				await this.releaseProvider(provider).catch((cleanupError) => console.error("MCP provider release failed:", cleanupError))
			}
			throw error
		}
	}

	/** Preserve the synchronous void API; disposal consumers await releaseProvider. */
	static unregisterProvider(provider: ClineProvider): void {
		void this.releaseProvider(provider).catch((error) => console.error("MCP provider release failed:", error))
	}

	static async releaseProvider(provider: ClineProvider): Promise<void> {
		const registration = this.providers.get(provider)
		if (!registration) return
		this.providers.delete(provider)
		const hub = registration.hub
		if (!hub) {
			if (this.providers.size === 0) await this.cleanup(provider.context)
			return
		}
		const nextProvider = [...this.providers].find(([, next]) => next.hub === hub)?.[0]
		if (nextProvider) hub.setProvider(nextProvider)
		if (this.providers.size === 0 && this.instance === hub) {
			const initializing = this.initializationPromise
			const closing = hub.unregisterClient()
			await this.finishCleanup(provider.context, hub, initializing, closing, false)
		} else {
			await hub.unregisterClient()
		}
	}

	static notifyProviders(message: any): void {
		this.providers.forEach((_registration, provider) => {
			provider.postMessageToWebview(message).catch((error) => {
				console.error("Failed to notify provider:", error)
			})
		})
	}

	static async cleanup(context: vscode.ExtensionContext): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise
		const hub = this.instance
		const initializing = this.initializationPromise
		this.instance = null
		this.initializationPromise = null
		this.providers.clear()
		await this.finishCleanup(context, hub, initializing, hub?.dispose() ?? Promise.resolve(), true)
	}

	private static async finishCleanup(
		context: vscode.ExtensionContext,
		hub: McpHub | null,
		initializing: Promise<McpHub> | null,
		closing: Promise<void>,
		force: boolean,
	): Promise<void> {
		const cleanup = (async () => {
			try {
				await closing
			} finally {
				// Old identity writes must settle before clearing them or creating a new Hub.
				await initializing?.catch(() => undefined)
				if (force || hub?.disposed) {
					if (this.instance === hub) this.instance = null
					if (hub || initializing) await context.globalState.update(this.GLOBAL_STATE_KEY, undefined)
				}
			}
		})()
		this.cleanupPromise = cleanup
		try {
			await cleanup
		} finally {
			if (this.cleanupPromise === cleanup) this.cleanupPromise = null
		}
	}
}
