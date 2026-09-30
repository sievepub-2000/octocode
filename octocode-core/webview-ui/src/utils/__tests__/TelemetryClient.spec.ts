import { telemetryClient } from "../TelemetryClient"

// The webview no longer ships events to a third-party analytics service. These
// tests pin the two things that still matter: the enabled flag follows the
// user's setting, and capturing an event neither throws nor reaches the network.
describe("TelemetryClient", () => {
	const client = telemetryClient as unknown as {
		updateTelemetryState: (setting: string, apiKey?: string, distinctId?: string) => void
		capture: (name: string, props?: Record<string, unknown>) => void
		constructor: { enabled: boolean }
	}

	const enabled = () => (telemetryClient.constructor as unknown as { enabled: boolean }).enabled

	beforeEach(() => {
		client.updateTelemetryState("disabled")
	})

	it("stays disabled when the setting is disabled", () => {
		client.updateTelemetryState("disabled", "key", "id")
		expect(enabled()).toBe(false)
	})

	it("stays disabled when the key or distinct id is missing", () => {
		client.updateTelemetryState("enabled", undefined, "id")
		expect(enabled()).toBe(false)

		client.updateTelemetryState("enabled", "key", undefined)
		expect(enabled()).toBe(false)
	})

	it("reports enabled once the setting and both identifiers are present", () => {
		client.updateTelemetryState("enabled", "key", "id")
		expect(enabled()).toBe(true)
	})

	it("captures without throwing and without contacting the network", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		client.updateTelemetryState("enabled", "key", "id")

		expect(() => client.capture("some.event", { a: 1 })).not.toThrow()
		expect(fetchSpy).not.toHaveBeenCalled()

		fetchSpy.mockRestore()
	})
})
