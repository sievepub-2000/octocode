import { copyFile, mkdir, stat, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

const platform = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`
const executable = process.platform === "win32" ? "octocode-host.exe" : "octocode-host"
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(root, "target", "release", executable)
const destination = path.join(root, "src", "bin", platform, executable)

// Release must retain the full licenses for both native executables. A changed
// Host lock requires refreshed notice evidence before any binary is staged.
const notices = path.join(root, "src", "resources", "notices")
const hostNotice = await readFile(path.join(notices, "octocode-host.txt"), "utf8")
const cargoHash = createHash("sha256")
	.update(await readFile(path.join(root, "Cargo.lock")))
	.digest("hex")
if (!hostNotice.includes(`Cargo.lock SHA256: ${cargoHash}`)) {
	throw new Error("Rust Host third-party notices do not match Cargo.lock; refresh the verified license inventory")
}
const harnessNotice = path.join(root, "..", "octo-harness", "THIRD-PARTY-NOTICES")
try {
	await stat(harnessNotice)
} catch {
	// Include the resolved path: the sibling-repo layout is an assumption and a
	// bare ENOENT here is hard to debug inside a vsix build log.
	throw new Error(
		`octo-harness THIRD-PARTY-NOTICES not found at ${harnessNotice}; expected the octo-harness repo as a sibling of octocode-core`,
	)
}
const harnessNoticeText = await readFile(harnessNotice, "utf8")
if (!harnessNoticeText.trim()) {
	throw new Error("octo-harness THIRD-PARTY-NOTICES is empty; regenerate it before staging")
}
await mkdir(notices, { recursive: true })
await copyFile(harnessNotice, path.join(notices, "octocode-harness.txt"))

await stat(source)
await mkdir(path.dirname(destination), { recursive: true })
await copyFile(source, destination)
if (process.platform === "win32") {
	await copyFile(
		path.join(root, "scripts", "octocode-agent.cmd"),
		path.join(path.dirname(destination), "octocode-agent.cmd"),
	)
}

// Keep the prompt preview identical to the template used by the bundled harness.
const prompt = path.join(root, "..", "octo-harness", "crates", "codegen", "xai-grok-agent", "templates", "prompt.md")
const promptDestination = path.join(root, "src", "resources", "harness", "system-prompt.md")
await mkdir(path.dirname(promptDestination), { recursive: true })
await copyFile(prompt, promptDestination)
