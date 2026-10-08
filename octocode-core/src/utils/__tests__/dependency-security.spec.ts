import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const requireFromTest = createRequire(import.meta.url)
const requireFromSdk = createRequire(requireFromTest.resolve("@modelcontextprotocol/sdk/client/index.js"))
const requireFromAjv = createRequire(requireFromSdk.resolve("ajv"))
const requireFromRateLimit = createRequire(requireFromSdk.resolve("express-rate-limit"))

describe("dependency security boundaries", () => {
	it("rejects a port that would replace the serialized URI authority", () => {
		const uri = requireFromAjv("fast-uri")
		expect(() =>
			uri.serialize({ scheme: "http", host: "trusted.example", port: "@127.0.0.1:8124", path: "/app" }),
		).toThrow()
		expect(new URL(uri.serialize({ scheme: "http", host: "trusted.example", port: 8080, path: "/app" })).host).toBe(
			"trusted.example:8080",
		)
	})

	it("keeps address families separate and recognizes the full IPv6 link-local range", () => {
		const { Address4, Address6 } = requireFromRateLimit("ip-address")
		expect(new Address4("32.1.13.184").isInSubnet(new Address6("2001:db8::/32"))).toBe(false)
		expect(new Address6("febf::1").isLinkLocal()).toBe(true)
		expect(new Address6("2001:db8::1").isInSubnet(new Address6("2001:db8::/32"))).toBe(true)
	})

	it("escapes a plain string rendered at the Hono root", async () => {
		const { renderToString } = requireFromSdk("hono/jsx/dom/server")
		const rendered = await renderToString("<img src=x onerror=owned>")
		expect(rendered).not.toContain("<img")
		expect(rendered).toContain("&lt;img")
	})

	it("handles an unrequested WebSocket subprotocol without crashing the client process", () => {
		const entry = requireFromTest.resolve("undici")
		const script = `
const http = require('node:http'), crypto = require('node:crypto');
const { WebSocket } = require(${JSON.stringify(entry)});
const sockets = new Set(), server = http.createServer();
server.on('connection', socket => {
	sockets.add(socket);
	socket.on('close', () => sockets.delete(socket));
});
function cleanup() {
	for (const socket of sockets) socket.destroy();
	server.close();
}
server.on('upgrade', (request, socket) => {
	const accept = crypto.createHash('sha1')
		.update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
	socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n' +
		'Sec-WebSocket-Accept: ' + accept + '\\r\\nSec-WebSocket-Protocol: unrequested-owned\\r\\n\\r\\n');
});
server.listen(0, '127.0.0.1', () => {
	const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
	ws.addEventListener('error', () => { console.log(JSON.stringify({ handled: true })); cleanup(); });
	ws.addEventListener('open', () => { process.exitCode = 2; ws.close(); cleanup(); });
});
setTimeout(() => { process.exitCode = 3; cleanup(); }, 2000).unref();
`
		const child = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", script], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 3000,
			maxBuffer: 512 * 1024,
		})
		expect(child.error).toBeUndefined()
		expect(child.status, child.stderr).toBe(0)
		expect(JSON.parse(child.stdout)).toEqual({ handled: true })
	})
})
