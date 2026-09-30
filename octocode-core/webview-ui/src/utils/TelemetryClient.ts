import type { TelemetrySetting } from "@roo-code/types"

/**
 * Webview telemetry sink.
 *
 * OctoCode runs entirely against a model host on the local network, and the
 * webview used to ship every UI event to a third-party analytics service
 * (posthog.com) over the public internet. That is unrelated to writing code or
 * running tasks, it is a privacy leak on an otherwise self-contained system,
 * and the client library was one of the largest things in the startup bundle --
 * it was parsed on every window open whether or not telemetry was ever enabled.
 *
 * The class is kept, rather than deleting the call sites, so callers keep a
 * single well-named place to send events to and a future local sink can be
 * added here without touching them again. `telemetryEnabled` still tracks the
 * user's setting so the behaviour stays observable and testable.
 */
class TelemetryClient {
	private static instance: TelemetryClient
	private static telemetryEnabled: boolean = false

	public updateTelemetryState(telemetrySetting: TelemetrySetting, apiKey?: string, distinctId?: string) {
		TelemetryClient.telemetryEnabled = telemetrySetting !== "disabled" && !!apiKey && !!distinctId
	}

	public static getInstance(): TelemetryClient {
		if (!TelemetryClient.instance) {
			TelemetryClient.instance = new TelemetryClient()
		}

		return TelemetryClient.instance
	}

	/** Whether the user's settings would have enabled event capture. */
	public static get enabled(): boolean {
		return TelemetryClient.telemetryEnabled
	}

	public capture(_eventName: string, _properties?: Record<string, any>) {
		// Intentionally inert: no event leaves this machine.
	}
}

export const telemetryClient = TelemetryClient.getInstance()
