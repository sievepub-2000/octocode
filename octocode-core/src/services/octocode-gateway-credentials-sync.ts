import type { ExtensionMessage } from "@roo-code/types"

/** Notifies the webview that OctoCode Gateway credentials are available for model discovery. */
export function postOctoCodeGatewayCredentialsReady(postMessage: (message: ExtensionMessage) => void): void {
	postMessage({ type: "octoCodeGatewayCredentialsReady" })
}
