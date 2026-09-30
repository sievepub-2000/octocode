import { copyFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const platform = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`
const executable = process.platform === "win32" ? "octocode-host.exe" : "octocode-host"
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(root, "target", "release", executable)
const destination = path.join(root, "src", "bin", platform, executable)

await stat(source)
await mkdir(path.dirname(destination), { recursive: true })
await copyFile(source, destination)
if (process.platform === "win32") {
	await copyFile(path.join(root, "scripts", "octocode-agent.cmd"), path.join(path.dirname(destination), "octocode-agent.cmd"))
}

// Keep the prompt preview identical to the template used by the bundled harness.
const prompt = path.join(root, "..", "octo-harness", "crates", "codegen", "xai-grok-agent", "templates", "prompt.md")
const promptDestination = path.join(root, "src", "resources", "harness", "system-prompt.md")
await mkdir(path.dirname(promptDestination), { recursive: true })
await copyFile(prompt, promptDestination)
