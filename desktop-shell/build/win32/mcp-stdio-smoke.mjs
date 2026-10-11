import { spawn } from "node:child_process"

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error("usage: node mcp-stdio-smoke.mjs <command> [args...]")

const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
let stdout = ""
let stderr = ""
let pending = ""
let failure
const responses = new Map()
const outstanding = new Set()
const recordFailure = (error) => { failure ??= error }
child.on("error", recordFailure)
child.stdin.on("error", recordFailure)
child.stdout.on("error", recordFailure)
child.stderr.on("error", recordFailure)
child.on("exit", (code, signal) => recordFailure(new Error(`MCP child exited: code=${code} signal=${signal}`)))
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  stdout += chunk
  pending += chunk
  let newline
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    try {
      const message = JSON.parse(line)
      if (!message || message.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC response")
      if (outstanding.has(message.id)) {
        outstanding.delete(message.id)
        responses.set(message.id, message)
      }
    } catch (error) {
      recordFailure(error)
    }
  }
})
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })

const send = (message) => {
  if (message.id !== undefined) outstanding.add(message.id)
  return child.stdin.write(`${JSON.stringify(message)}\n`)
}
const deadline = Date.now() + 15000
const waitFor = async (id) => {
  while (!responses.has(id) && !failure && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  const response = responses.get(id)
  if (!response) {
    if (failure) throw failure
    throw new Error(`response ${id} timeout: ${stderr.trim() ? stderr : stdout}`)
  }
  if (Object.hasOwn(response, "error") || !response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
    throw new Error(`response ${id} failed: ${JSON.stringify(response)}`)
  }
  return response.result
}

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "octocode-smoke", version: "1" } } })
  await waitFor(1)
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  const result = await waitFor(2)
  if (!Array.isArray(result.tools)) throw new Error(`tools/list failed: ${stderr.trim() ? stderr : stdout}`)
  console.log(stdout.trim())
} finally {
  if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill()
}
