import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect, it } from "vitest"

import { startRecoveryHelper } from "../DesktopRecovery"

it.runIf(process.platform === "win32")(
	"captures the actual process and cancels without installing or closing it",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "octocode-recovery-test-"))
		const directory = path.join(root, "恢复 下载")
		await fs.mkdir(directory)
		const journal = path.join(root, "journal.json")
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			windowsHide: true,
			stdio: "ignore",
		})
		try {
			const cancel = await startRecoveryHelper(directory, {
				mainPid: child.pid!,
				executable: process.execPath,
				installer: path.join(directory, "OctoCodeSetup.exe"),
				sha256: "0".repeat(64),
				version: "2.0.0",
				journal,
			})
			expect(child.exitCode).toBeNull()
			const second = path.join(root, "second-recovery")
			await fs.mkdir(second)
			await expect(
				startRecoveryHelper(second, {
					mainPid: child.pid!,
					executable: process.execPath,
					installer: path.join(second, "OctoCodeSetup.exe"),
					sha256: "0".repeat(64),
					version: "2.0.0",
					journal,
				}),
			).rejects.toThrow("already active")
			await cancel()
			let state: string | undefined
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					state = JSON.parse(await fs.readFile(journal, "utf8")).state
				} catch {
					/* helper still waiting */
				}
				if (state === "cancelled") break
				await new Promise((resolve) => setTimeout(resolve, 100))
			}
			expect(state).toBe("cancelled")
			expect(child.exitCode).toBeNull()
			expect(await fs.stat(path.join(directory, "OctoCodeSetup.exe")).catch(() => undefined)).toBeUndefined()
			// A cancelled quit must not remain armed when that same process later exits.
			child.kill()
			await new Promise<void>((resolve) =>
				child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve()),
			)
			await new Promise((resolve) => setTimeout(resolve, 300))
			expect(JSON.parse(await fs.readFile(journal, "utf8")).state).toBe("cancelled")
		} finally {
			child.kill()
			await new Promise<void>((resolve) =>
				child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve()),
			)
			await fs.rm(root, { recursive: true, force: true })
		}
	},
	// Two bounded 10s startups plus the 10s cancellation observation window.
	40_000,
)
