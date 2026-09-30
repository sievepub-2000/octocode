import { environmentForRouteTarget, findEnvironmentForCommand } from "../manifest"
import { selectEnvironment } from "../../../integrations/terminal/environmentRouter"

/**
 * Guards the seam between "where does this command run" (the router) and "what
 * has to be installed for it to run" (the provisioner).
 *
 * These were two independent predicates: the router matches PowerShell's
 * verb-prefix grammar to send `Get-Process` to pwsh, while provisioning matched
 * the literal leading token against a trigger list containing only "pwsh". The
 * command was therefore rewritten to invoke an interpreter that on-demand
 * provisioning had never been asked to install. Deriving the requirement from
 * the resolved route removes the second source of truth.
 */
describe("route-driven provisioning", () => {
	const auto = { defaultTarget: "auto" as const }

	describe("commands the leading-token match cannot see", () => {
		it.each([
			["Get-Process", "pwsh", "powershell"],
			["Set-ItemProperty HKCU:\\X 1", "pwsh", "powershell"],
			["Invoke-WebRequest https://example.com", "pwsh", "powershell"],
			[".\\deploy.ps1 -Force", "pwsh", "powershell"],
			// `gradle` sits in the JDK trigger list, so the token match points at the
			// wrong environment here rather than at none.
			["gradle build", "android", "android"],
		])("%s routes to %s and therefore needs %s", (command, expectedTarget, expectedEnv) => {
			const target = selectEnvironment(command, auto)
			expect(target).toBe(expectedTarget)

			// The token match cannot reach the right answer — that is precisely the gap.
			expect(findEnvironmentForCommand(command)?.id).not.toBe(expectedEnv)

			expect(environmentForRouteTarget(target)?.id).toBe(expectedEnv)
		})
	})

	describe("commands both predicates already agree on", () => {
		it("resolves ./gradlew through either path", () => {
			// Kept explicit so a future trigger-list edit that breaks the token match
			// shows up as a changed expectation rather than silently relying on the route.
			expect(findEnvironmentForCommand("./gradlew assembleDebug")?.id).toBe("android")
			expect(environmentForRouteTarget(selectEnvironment("./gradlew assembleDebug", auto))?.id).toBe("android")
		})
	})

	describe("targets that execute inside a provisioned environment", () => {
		it("maps any WSL distribution to the wsl environment", () => {
			expect(environmentForRouteTarget("wsl:OctoCode")?.id).toBe("wsl")
			expect(environmentForRouteTarget("wsl:Ubuntu")?.id).toBe("wsl")
		})

		it("derives wsl from a Linux-only command's route", () => {
			const target = selectEnvironment("gcc main.c -o main", auto)
			expect(target).toMatch(/^wsl:/)
			expect(environmentForRouteTarget(target)?.id).toBe("wsl")
		})
	})

	describe("targets that need nothing provisioned", () => {
		it.each([
			["vscode-terminal", "runs in the ambient shell"],
			["msvc", "uses an externally installed Visual Studio"],
			["macos-remote", "executes on another host"],
			["docker:default", "executes inside a container"],
		])("%s requires no environment (%s)", (target) => {
			expect(environmentForRouteTarget(target)).toBeUndefined()
		})

		it("leaves an ordinary command needing nothing from the route", () => {
			const target = selectEnvironment("ls -la", auto)
			expect(target).toBe("vscode-terminal")
			expect(environmentForRouteTarget(target)).toBeUndefined()
		})
	})

	describe("the two predicates stay complementary", () => {
		it("still provisions toolchains that run in the plain terminal", () => {
			// cargo is not routed anywhere special, so only the token match can
			// know it needs Rust. Both paths are required; neither subsumes the other.
			const target = selectEnvironment("cargo build --release", auto)
			expect(target).toBe("vscode-terminal")
			expect(environmentForRouteTarget(target)).toBeUndefined()
			expect(findEnvironmentForCommand("cargo build --release")?.id).toBe("rust")
		})
	})
})
