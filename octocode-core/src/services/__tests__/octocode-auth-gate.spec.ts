vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
}))

vi.mock("../../i18n", () => ({
	t: (key: string) => key,
}))

import {
	assertOctoCodeAuthenticationAllowed,
	isOctoCodeAuthenticationRequired,
} from "../octocode-auth"

describe("OctoCode startup authentication policy", () => {
	it.each([undefined, "", "false", " FALSE "])("allows use by default for %j", (value) => {
		expect(isOctoCodeAuthenticationRequired(value)).toBe(false)
		expect(() => assertOctoCodeAuthenticationAllowed(value, undefined)).not.toThrow()
	})

	it("requires a cached login token when the startup flag is true", () => {
		expect(isOctoCodeAuthenticationRequired(" true ")).toBe(true)
		expect(() => assertOctoCodeAuthenticationAllowed("true", undefined)).toThrow(
			"OctoCode requires sign-in before an agent task can run.",
		)
		expect(() => assertOctoCodeAuthenticationAllowed("true", "session-token")).not.toThrow()
	})

	it("rejects invalid startup flag values instead of silently disabling authentication", () => {
		expect(() => isOctoCodeAuthenticationRequired("yes")).toThrow(
			"OCTOCODE_REQUIRE_AUTHENTICATION must be true or false.",
		)
	})
})
