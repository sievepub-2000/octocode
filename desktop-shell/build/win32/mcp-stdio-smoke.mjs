import { spawn } from "node:child_process"

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error("usage: node mcp-stdio-smoke.mjs <command> [args...]")

const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
let stdout = ""
let stderr = ""
child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "octo-smoke", version: "1" } } })

const deadline = Date.now() + 15000
while (!stdout.includes('"id":1') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
if (!stdout.includes('"id":1')) {
  child.kill()
  throw new Error(`initialize timeout: ${stderr || stdout}`)
}

send({ jsonrpc: "2.0", method: "notifications/initialized" })
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
while (!stdout.includes('"id":2') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
child.kill()
if (!stdout.includes('"id":2') || !stdout.includes('"tools"')) throw new Error(`tools/list failed: ${stderr || stdout}`)
console.log(stdout.trim())
