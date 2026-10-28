import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const expected = JSON.parse(readFileSync(join(root, "toolchain.json"), "utf8"))

function run(candidates, args) {
	for (const command of candidates) {
		try {
			return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		} catch {}
	}
	throw new Error(`未找到可执行文件: ${candidates.join(", ")}`)
}

function packageVersion(candidates) {
	const manifest = candidates.find(existsSync)
	if (!manifest) throw new Error(`未找到 Node 包: ${candidates.join(", ")}`)
	return JSON.parse(readFileSync(manifest, "utf8")).version
}

function protocCandidates() {
	const candidates = ["protoc"]
	if (process.platform !== "win32") return candidates
	candidates.push("D:\\Program Files\\develop\\protobuf-36.1\\bin\\protoc.exe")
	const packages = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages")
	if (existsSync(packages)) {
		for (const name of readdirSync(packages)) {
			if (name.startsWith("Google.Protobuf_")) candidates.push(join(packages, name, "bin", "protoc.exe"))
		}
	}
	return candidates
}

const cargoBin = join(process.env.USERPROFILE ?? "", ".cargo", "bin")
const nodeBin = dirname(process.execPath)
const userNpmBin = join(process.env.APPDATA ?? "", "npm")
const checks = [
	["node", process.version.slice(1), expected.node],
	["npm", packageVersion([join(nodeBin, "node_modules", "npm", "package.json")]), expected.npm],
	[
		"pnpm",
		packageVersion(
			[
				join(nodeBin, "node_modules", "pnpm", "package.json"),
				join(userNpmBin, "node_modules", "pnpm", "package.json"),
			],
		),
		expected.pnpm,
	],
	["rustc", run(["rustc", join(cargoBin, "rustc.exe")], ["--version"]).split(" ")[1], expected.rustc],
	["cargo", run(["cargo", join(cargoBin, "cargo.exe")], ["--version"]).split(" ")[1], expected.cargo],
	[
		"python",
		run(process.platform === "win32" ? ["python", "py", "C:\\Python314\\python.exe"] : ["python3.14"], ["--version"]).split(" ")[1],
		expected.python,
	],
	["uv", run(["uv"], ["--version"]).split(" ")[1], expected.uv],
	["protoc", run(protocCandidates(), ["--version"]).split(" ")[1], expected.protoc],
]

const mismatches = checks.filter(([, actual, wanted]) => actual !== wanted)
console.table(checks.map(([tool, actual, wanted]) => ({ tool, actual, expected: wanted, ok: actual === wanted })))
if (mismatches.length) process.exitCode = 1
