import * as path from "path"

import { EnvironmentProvisioner, type ProvisionerHost, type ProvisionProgress } from "../provisioner"
import {
	findEnvironmentForCommand,
	getCoreEnvironmentIds,
	getOnDemandEnvironmentIds,
	type EnvironmentDescriptor,
} from "../manifest"

/** A ProvisionerHost plus the bookkeeping the assertions read back. */
type TestHost = ProvisionerHost & {
	installed: Set<string>
	installCalls: string[]
	packageCalls: string[]
	removed: string[]
	readonly wslImports: number
}

function deferredVoid() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function makeHost(overrides: Partial<ProvisionerHost> = {}): TestHost {
	const installed = new Set<string>()
	const installCalls: string[] = []
	const packageCalls: string[] = []
	const removed: string[] = []
	let wslImports = 0

	const host: TestHost = {
		environmentsDir: path.join("C:", "app", "environments"),
		platform: "win32" as NodeJS.Platform,
		installed,
		installCalls,
		packageCalls,
		removed,
		get wslImports() {
			return wslImports
		},
		pathExists: async (p: string) => installed.has(p),
		installArchive: async (env: EnvironmentDescriptor, targetDir: string) => {
			installCalls.push(env.id)
			// Simulate a correct install by creating the detect marker.
			installed.add(path.join(targetDir, env.detect.win32))
		},
		installPackages: async (env: EnvironmentDescriptor, _targetDir: string, marker: string) => {
			packageCalls.push(env.id)
			// A real host writes the marker last, which is what makes the
			// environment detectable as finished.
			installed.add(marker)
		},
		isWslDistroRegistered: async () => false,
		importWslDistro: async () => {
			wslImports++
		},
		removeEnvironment: async (env: EnvironmentDescriptor, targetDir: string) => {
			for (const entry of [...installed]) if (entry.startsWith(targetDir)) installed.delete(entry)
			removed.push(env.id)
		},
		...overrides,
	}
	return host
}

describe("environment manifest", () => {
	it("keeps the shipped core minimal", () => {
		// The whole point of on-demand provisioning is that the installer stays small.
		// If something creeps back into "core" this test should make it obvious.
		expect(getCoreEnvironmentIds().sort()).toEqual(["node", "scripts"])
	})

	it("provisions the heavy toolchains on demand", () => {
		const onDemand = getOnDemandEnvironmentIds()
		for (const id of ["rust", "jdk", "go", "dotnet", "android", "wsl", "python", "powershell"]) {
			expect(onDemand).toContain(id)
		}
	})

	describe("command → environment matching", () => {
		it.each([
			["cargo build --release", "rust"],
			["rustc --version", "rust"],
			["go test ./...", "go"],
			["java -version", "jdk"],
			["dotnet build", "dotnet"],
			["gcc main.c -o main", "wsl"],
			["swift build", "wsl"],
			["docker ps", "wsl"],
			["python3 -m pytest", "python"],
			["ffmpeg -i in.mp4 out.mkv", "ffmpeg"],
			["adb devices", "android"],
		])("matches %s to %s", (command, expected) => {
			expect(findEnvironmentForCommand(command)?.id).toBe(expected)
		})

		it("matches only the leading token, so merely mentioning a tool downloads nothing", () => {
			// A 2 GB Rust download triggered by `echo "install cargo"` would be awful.
			expect(findEnvironmentForCommand('echo "remember to install cargo"')).toBeUndefined()
			expect(findEnvironmentForCommand("git commit -m 'use docker'")).toBeUndefined()
		})

		it("strips path prefixes and executable extensions", () => {
			expect(findEnvironmentForCommand("./gradlew assembleDebug")?.id).toBe("android")
			expect(findEnvironmentForCommand("C:\\tools\\cargo.exe build")?.id).toBe("rust")
		})

		it("returns nothing for commands that need no provisioned toolchain", () => {
			expect(findEnvironmentForCommand("ls -la")).toBeUndefined()
			expect(findEnvironmentForCommand("")).toBeUndefined()
		})
	})
})

describe("EnvironmentProvisioner", () => {
	it("repairs packages without replacing an existing interpreter or its user packages", async () => {
		const host = makeHost()
		host.installed.add(path.join(host.environmentsDir, "python", "python.exe"))
		const provisioner = new EnvironmentProvisioner(host)
		expect(await provisioner.isInstalled("python")).toBe(false)
		await provisioner.ensure("python")
		expect(host.installCalls).toEqual([])
		expect(host.packageCalls).toEqual(["python"])
		expect(await provisioner.isInstalled("python")).toBe(true)
	})
	it("does not download an environment that is already present", async () => {
		const host = makeHost()
		host.installed.add(path.join(host.environmentsDir, "rust", "cargo", "bin", "cargo.exe"))
		const provisioner = new EnvironmentProvisioner(host)

		const phases: string[] = []
		const result = await provisioner.ensure("rust", (p) => phases.push(p.phase))

		expect(result.installed).toBe(false)
		expect(host.installCalls).toEqual([])
		expect(phases).toEqual(["already-present"])
	})

	it("installs a missing toolchain and reports readable progress", async () => {
		const host = makeHost()
		const provisioner = new EnvironmentProvisioner(host)

		const messages: ProvisionProgress[] = []
		const result = await provisioner.ensure("rust", (p) => messages.push(p))

		expect(result.installed).toBe(true)
		expect(host.installCalls).toEqual(["rust"])
		expect(messages.map((m) => m.phase)).toEqual(["resolving", "done"])
		// The first line is what the agent narrates, so it must state the size.
		expect(messages[0].message).toContain("2.1 GB")
	})

	it("collapses concurrent requests for the same environment into one install", async () => {
		const host = makeHost()
		const provisioner = new EnvironmentProvisioner(host)

		const [a, b, c] = await Promise.all([
			provisioner.ensure("go"),
			provisioner.ensure("go"),
			provisioner.ensure("go"),
		])

		expect(host.installCalls).toEqual(["go"])
		expect([a.installed, b.installed, c.installed]).toEqual([true, true, true])
	})

	it("retries after a failure instead of caching it", async () => {
		let attempt = 0
		const host = makeHost({
			installArchive: async (env: EnvironmentDescriptor, targetDir: string) => {
				attempt++
				if (attempt === 1) throw new Error("network reset")
				host.installed.add(path.join(targetDir, env.detect.win32))
			},
		})
		const provisioner = new EnvironmentProvisioner(host)

		await expect(provisioner.ensure("go")).rejects.toThrow(/network reset/)
		await expect(provisioner.ensure("go")).resolves.toMatchObject({ installed: true })
		expect(attempt).toBe(2)
	})

	it("fails loudly when an install leaves no usable executable", async () => {
		// A resolver can return 200 for the wrong archive; the directory then exists
		// but is useless. Claiming success here would produce a confusing failure later.
		const host = makeHost({ installArchive: async () => {} })
		const provisioner = new EnvironmentProvisioner(host)

		await expect(provisioner.ensure("go")).rejects.toThrow(/executable was not found/)
	})

	it("refuses to runtime-provision a core environment", async () => {
		const host = makeHost()
		const provisioner = new EnvironmentProvisioner(host)

		await expect(provisioner.ensure("node")).rejects.toThrow(/base installation/)
		expect(host.installCalls).toEqual([])
	})

	it("detects WSL through the OS registration rather than a file", async () => {
		const registered = makeHost({ isWslDistroRegistered: async () => true })
		expect(await new EnvironmentProvisioner(registered).isInstalled("wsl")).toBe(true)

		const absent = makeHost({ isWslDistroRegistered: async () => false })
		expect(await new EnvironmentProvisioner(absent).isInstalled("wsl")).toBe(false)
	})

	it("imports the WSL distribution when a Linux-only command needs it", async () => {
		let registered = false
		const host = makeHost({
			isWslDistroRegistered: async () => registered,
			importWslDistro: async () => {
				registered = true
			},
		})
		const provisioner = new EnvironmentProvisioner(host)

		const result = await provisioner.ensureForCommand("gcc main.c -o main")

		expect(result?.id).toBe("wsl")
		expect(result?.installed).toBe(true)
	})

	it("returns undefined for a command needing no provisioned environment", async () => {
		const provisioner = new EnvironmentProvisioner(makeHost())
		expect(await provisioner.ensureForCommand("ls -la")).toBeUndefined()
	})

	it("exposes absolute PATH entries for an installed environment", async () => {
		const host = makeHost()
		const provisioner = new EnvironmentProvisioner(host)

		const result = await provisioner.ensure("android")

		expect(result.pathEntries).toEqual([
			path.join(host.environmentsDir, "android", "platform-tools"),
			path.join(host.environmentsDir, "android", "cmdline-tools/latest/bin"),
		])
	})

	it("rejects an unknown environment id with a discoverable message", async () => {
		const provisioner = new EnvironmentProvisioner(makeHost())
		await expect(provisioner.ensure("haskell")).rejects.toThrow(/Unknown environment "haskell"/)
	})

	describe("environments that need packages", () => {
		/*
		 * A resolver fetches a plain interpreter: stdlib and pip, nothing else. The
		 * bundled code-review-graph MCP server needs a module on top of that, so an
		 * interpreter alone is not a finished environment — it would start and then
		 * fail on the missing module, which reads as a broken server rather than an
		 * incomplete install.
		 */
		it("installs the declared packages after unpacking", async () => {
			const host = makeHost()
			const provisioner = new EnvironmentProvisioner(host)

			await provisioner.ensure("python")

			expect(host.installCalls).toEqual(["python"])
			expect(host.packageCalls).toEqual(["python"])
		})

		it("does not count an interpreter without its packages as installed", async () => {
			const host = makeHost()
			// An interpreter left by an earlier version, before the packages were
			// declared: the detect marker is there and nothing else is.
			host.installed.add(path.join(host.environmentsDir, "python", "python.exe"))
			const provisioner = new EnvironmentProvisioner(host)

			expect(await provisioner.isInstalled("python")).toBe(false)

			await provisioner.ensure("python")
			expect(host.packageCalls).toEqual(["python"])
			expect(await provisioner.isInstalled("python")).toBe(true)
		})

		it("skips the work once the packages are recorded", async () => {
			const host = makeHost()
			const provisioner = new EnvironmentProvisioner(host)
			await provisioner.ensure("python")

			const second = await provisioner.ensure("python")

			expect(second.installed).toBe(false)
			expect(host.packageCalls).toEqual(["python"])
		})
	})

	describe("environments named by an executable path", () => {
		/*
		 * The bundled MCP servers are configured with absolute paths built from
		 * `${env:OCTOCODE_PYTHON_BASE}`, so the leading token is a full path to an
		 * interpreter and no trigger word matches it. Without this the server spawns
		 * against a directory that was never provisioned and fails with ENOENT.
		 */
		it("recognises an executable inside an environment", () => {
			const host = makeHost()
			const provisioner = new EnvironmentProvisioner(host)

			expect(
				provisioner.environmentForExecutable(path.join(host.environmentsDir, "python", "python.exe"))?.id,
			).toBe("python")
		})

		it("provisions the environment an executable lives in", async () => {
			const host = makeHost()
			const provisioner = new EnvironmentProvisioner(host)

			await provisioner.ensureForExecutable(path.join(host.environmentsDir, "python", "python.exe"))

			expect(host.installCalls).toEqual(["python"])
		})

		it.each([
			["a bare command name", "python.exe"],
			["something outside the environments directory", path.join("C:", "Windows", "py.exe")],
			[
				"a sibling directory that only looks similar",
				path.join("C:", "app", "environments-old", "python", "python.exe"),
			],
			["nothing at all", ""],
		])("returns nothing for %s", (_case, executable) => {
			const provisioner = new EnvironmentProvisioner(makeHost())

			expect(provisioner.environmentForExecutable(executable)).toBeUndefined()
		})
	})
})

describe("removing environments", () => {
	it("waits for removal before ensuring the same toolchain again", async () => {
		const entered = deferredVoid()
		const release = deferredVoid()
		const host = makeHost()
		const remove = host.removeEnvironment
		host.removeEnvironment = async (env, dir) => {
			entered.resolve()
			await release.promise
			await remove(env, dir)
		}
		const provisioner = new EnvironmentProvisioner(host)
		const deleting = provisioner.remove("go")
		await entered.promise
		const installing = provisioner.ensure("go")
		try {
			await Promise.resolve()
			await Promise.resolve()
			expect(host.installCalls).toEqual([])
		} finally {
			release.resolve()
			await Promise.allSettled([deleting, installing])
		}
		await expect(installing).resolves.toMatchObject({ installed: true })
		expect(await provisioner.isInstalled("go")).toBe(true)
	})

	it("uninstalls on-demand toolchains and refuses the core", async () => {
		const host = makeHost()
		const provisioner = new EnvironmentProvisioner(host)
		await provisioner.ensure("go")
		expect(await provisioner.isInstalled("go")).toBe(true)
		await provisioner.remove("go")
		expect(host.removed).toEqual(["go"])
		expect(await provisioner.isInstalled("go")).toBe(false)
		await expect(provisioner.remove("node")).rejects.toThrow("base installation")
		await expect(provisioner.remove("python")).rejects.toThrow("base installation")
		await expect(provisioner.remove("nope")).rejects.toThrow("Unknown environment")
	})

	it("still refuses removal during an install and releases the lock afterwards", async () => {
		const entered = deferredVoid()
		const release = deferredVoid()
		const host = makeHost()
		const install = host.installArchive
		host.installArchive = async (env, dir, progress) => {
			entered.resolve()
			await release.promise
			await install(env, dir, progress)
		}
		const provisioner = new EnvironmentProvisioner(host)
		const installing = provisioner.ensure("go")
		await entered.promise
		try {
			await expect(provisioner.remove("go")).rejects.toThrow("being installed")
			expect(host.removed).toEqual([])
		} finally {
			release.resolve()
			await installing
		}
		await provisioner.remove("go")
		expect(await provisioner.isInstalled("go")).toBe(false)
	})

	it("coalesces duplicate removals and waiting ensures without blocking other environments", async () => {
		const entered = deferredVoid()
		const release = deferredVoid()
		const host = makeHost()
		const remove = host.removeEnvironment
		let removals = 0
		host.removeEnvironment = async (env, dir) => {
			removals++
			entered.resolve()
			await release.promise
			await remove(env, dir)
		}
		const provisioner = new EnvironmentProvisioner(host)
		const first = provisioner.remove("go")
		await entered.promise
		const second = provisioner.remove("go")
		const installs = [provisioner.ensure("go"), provisioner.ensure("go")]
		try {
			await provisioner.ensure("jdk")
			expect(host.installCalls).toEqual(["jdk"])
			expect(removals).toBe(1)
		} finally {
			release.resolve()
			await Promise.allSettled([first, second, ...installs])
		}
		await Promise.all([first, second, ...installs])
		expect(host.installCalls).toEqual(["jdk", "go"])
		expect(await provisioner.isInstalled("go")).toBe(true)
	})

	it("propagates removal failure to waiting ensure and permits a later retry", async () => {
		const entered = deferredVoid()
		const release = deferredVoid()
		const host = makeHost()
		const remove = host.removeEnvironment
		host.removeEnvironment = async () => {
			entered.resolve()
			await release.promise
			throw new Error("owned removal failure")
		}
		const provisioner = new EnvironmentProvisioner(host)
		const deleting = provisioner.remove("go")
		await entered.promise
		const installing = provisioner.ensure("go")
		const failures = Promise.all([
			expect(deleting).rejects.toThrow("owned removal failure"),
			expect(installing).rejects.toThrow("owned removal failure"),
		])
		release.resolve()
		await failures
		expect(host.installCalls).toEqual([])
		host.removeEnvironment = remove
		await provisioner.remove("go")
		await provisioner.ensure("go")
		expect(await provisioner.isInstalled("go")).toBe(true)
	})

	it("releases mutation state even when a host throws synchronously", async () => {
		const host = makeHost()
		const remove = host.removeEnvironment
		const install = host.installArchive
		host.removeEnvironment = () => {
			throw new Error("synchronous removal")
		}
		host.installArchive = () => {
			throw new Error("synchronous install")
		}
		const provisioner = new EnvironmentProvisioner(host)
		await expect(provisioner.remove("go")).rejects.toThrow("synchronous removal")
		await expect(provisioner.ensure("go")).rejects.toThrow("synchronous install")
		host.removeEnvironment = remove
		host.installArchive = install
		await provisioner.ensure("go")
		await provisioner.remove("go")
		expect(await provisioner.isInstalled("go")).toBe(false)
	})
})
