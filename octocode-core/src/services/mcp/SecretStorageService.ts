import * as vscode from "vscode"
import { createHash } from "node:crypto"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"

export interface StoredMcpOAuthData {
	tokens: OAuthTokens
	/** Exact MCP resource URL used when these credentials were saved. Absent on legacy data. */
	server_url?: string
	/** Unix ms timestamp after which the access token should be considered expired. */
	expires_at: number
	/**
	 * Full DCR response from the auth server, persisted so that fields like
	 * client_secret, grant_types, and token_endpoint_auth_method survive restarts.
	 * Note: redirect_uris within this object may be stale (port changes between
	 * sessions); callers must override redirect_uris with the current value.
	 */
	client_info?: OAuthClientInformationFull
}

/**
 * Thin wrapper around VS Code SecretStorage for persisting MCP OAuth tokens.
 * V2 keys isolate the full resource URL, including scheme and query. Legacy
 * records are retained under their old keys and require a new sign-in; their
 * missing issuer/resource binding cannot be inferred safely from new discovery.
 */
export class SecretStorageService {
	private readonly _storage: vscode.SecretStorage
	private readonly _namespace = "mcp.oauth.v2."

	constructor(context: vscode.ExtensionContext) {
		this._storage = context.secrets
	}

	private _key(serverUrl: string): string {
		// Keep credential-bearing URL components out of the storage key itself.
		const identity = createHash("sha256").update(new URL(serverUrl).href).digest("hex")
		return `${this._namespace}${identity}.data`
	}

	async getOAuthData(serverUrl: string): Promise<StoredMcpOAuthData | undefined> {
		const raw = await this._storage.get(this._key(serverUrl))
		if (!raw) return undefined
		try {
			return JSON.parse(raw) as StoredMcpOAuthData
		} catch {
			return undefined
		}
	}

	async saveOAuthData(serverUrl: string, data: StoredMcpOAuthData): Promise<void> {
		await this._storage.store(this._key(serverUrl), JSON.stringify(data))
	}

	async hasOAuthData(serverUrl: string): Promise<boolean> {
		const raw = await this._storage.get(this._key(serverUrl))
		return raw !== undefined
	}

	async deleteOAuthData(serverUrl: string): Promise<void> {
		await this._storage.delete(this._key(serverUrl))
	}

	/**
	 * Subscribe to changes for a specific server URL's OAuth data.
	 * The callback fires (in all VS Code windows) immediately when another
	 * window writes or deletes the token for this server.
	 *
	 * @returns A dispose function — call it to stop listening.
	 */
	onDidChange(serverUrl: string, callback: () => void): () => void {
		const key = this._key(serverUrl)
		const disposable = this._storage.onDidChange((e) => {
			if (e.key === key) {
				callback()
			}
		})
		return () => disposable.dispose()
	}
}
