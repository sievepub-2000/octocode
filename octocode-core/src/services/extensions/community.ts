import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { z } from "zod/v4"
import { parse as parseYaml } from "yaml"
import type { ExtensionEntry, ExtensionResult, MarketplaceItem } from "@roo-code/types"
import { getSystemToolDirectory } from "../environments/tools"
import skillsSnapshot from "../../resources/skills-market/catalog.json"

const run = promisify(execFile)
const registry = "https://registry.modelcontextprotocol.io/v0.1/servers"
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const npmName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/
const argument = z.object({
	type: z.string().optional(),
	name: z.string().optional(),
	value: z.string().optional(),
	default: z.string().optional(),
	isRequired: z.boolean().optional(),
})
const packageSchema = z.object({
	registryType: z.string(),
	identifier: z.string(),
	version: z.string().optional(),
	registryBaseUrl: z.string().optional(),
	transport: z.object({ type: z.string() }),
	packageArguments: z.array(argument).optional(),
	runtimeArguments: z.array(argument).optional(),
	environmentVariables: z.array(argument.extend({ isSecret: z.boolean().optional() })).optional(),
})
const serverSchema = z.object({
	name: z.string(),
	title: z.string().optional(),
	description: z.string(),
	version: z.string(),
	packages: z.array(packageSchema).optional(),
	remotes: z
		.array(
			z.object({
				type: z.string(),
				url: z.string().url(),
				headers: z.array(argument.extend({ isSecret: z.boolean().optional() })).optional(),
			}),
		)
		.optional(),
})
const skillsSchema = z
	.array(
		z.object({
			id: z.string().max(64),
			path: z.string().max(300),
			name: z.string().max(64),
			description: z.string().min(1).max(1024),
			category: z.string().max(100),
		}),
	)
	.min(1)
	.max(10000)
	.transform((items) =>
		items.filter(
			(item) =>
				item.name === item.id &&
				/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) &&
				item.path.startsWith("skills/") &&
				item.path.split("/").at(-1) === item.id &&
				item.path.split("/").every((part) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(part)),
		),
	)
	.refine((items) => items.length > 0 && new Set(items.map((item) => item.id)).size === items.length)
let skillsCatalog: Promise<{ items: z.infer<typeof skillsSchema>; source: string }> | undefined

async function loadSkillsCatalog() {
	const fallback = {
		items: skillsSchema.parse(skillsSnapshot.entries),
		source: `GitHub · 随包快照 ${skillsSnapshot.retrievedAt}`,
	}
	const live = (skillsCatalog ??= read(
		`https://raw.githubusercontent.com/${skillsSnapshot.repository}/main/skills_index.json`,
		90_000,
	)
		.then((raw) => ({ items: skillsSchema.parse(JSON.parse(raw)), source: "GitHub · Agentic Awesome Skills" }))
		.catch(() => fallback))
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			live,
			new Promise<typeof fallback>((resolve) => {
				timer = setTimeout(() => resolve(fallback), 500)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

async function download(url: string, timeout = 20_000): Promise<Buffer> {
	const allowed = new Set([
		"registry.modelcontextprotocol.io",
		"api.github.com",
		"raw.githubusercontent.com",
		"registry.npmjs.org",
	])
	const parsed = new URL(url)
	if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname)) throw new Error("Untrusted marketplace URL")
	const response = await fetch(url, {
		redirect: "error",
		signal: AbortSignal.timeout(timeout),
		headers: { "User-Agent": "OctoCode", Accept: "application/json" },
	})
	if (!response.ok) throw new Error(`Marketplace request failed: HTTP ${response.status} (${parsed.hostname})`)
	if (!response.body) throw new Error("Empty marketplace response")
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.length
			if (size > 8 * 1024 * 1024) throw new Error("Marketplace response exceeds 8 MiB")
			chunks.push(value)
		}
	} finally {
		await reader.cancel()
	}
	return Buffer.concat(chunks)
}

async function read(url: string, timeout?: number): Promise<string> {
	return (await download(url, timeout)).toString("utf8")
}

function entry(
	kind: "skill" | "mcp",
	id: string,
	name: string,
	description: string,
	detail: string,
	installable = true,
): ExtensionEntry {
	return {
		kind,
		id: `community:${id}`,
		name,
		description,
		detail,
		scope: "global",
		installed: false,
		builtIn: false,
		actions: installable ? ["install"] : [],
	}
}

function npmPackage(server: z.infer<typeof serverSchema>) {
	return server.packages?.find(
		(pkg) =>
			pkg.registryType === "npm" &&
			pkg.transport.type === "stdio" &&
			(!pkg.registryBaseUrl || pkg.registryBaseUrl.replace(/\/$/, "") === "https://registry.npmjs.org"),
	)
}

function remoteEndpoint(server: z.infer<typeof serverSchema>) {
	return server.remotes?.find(
		(remote) => ["streamable-http", "sse"].includes(remote.type) && new URL(remote.url).protocol === "https:",
	)
}

export async function searchCommunity(kind: "skill" | "mcp", query: string): Promise<ExtensionEntry[]> {
	return (await searchCommunityPage(kind, query)).entries
}

export async function searchCommunityPage(
	kind: "skill" | "mcp",
	query: string,
	cursor?: string,
): Promise<ExtensionResult> {
	if (kind === "skill") {
		const offset = cursor ? Number(cursor) : 0
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("Invalid skill market page")
		const catalog = await loadSkillsCatalog()
		const search = query.trim().toLowerCase()
		const items = catalog.items.filter((skill) =>
			`${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(search),
		)
		return {
			entries: items
				.slice(offset, offset + 20)
				.map((skill) =>
					entry(
						kind,
						`${skillsSnapshot.repository}/${skill.id}`,
						skill.name,
						skill.description,
						`${catalog.source} · ${skill.category}`,
					),
				),
			...(offset + 20 < items.length ? { nextCursor: String(offset + 20) } : {}),
		}
	}
	const result = z
		.object({
			servers: z.array(z.object({ server: serverSchema })),
			metadata: z.object({ nextCursor: z.string().optional() }).optional(),
		})
		.parse(
			JSON.parse(
				await read(
					`${registry}?search=${encodeURIComponent(query)}&limit=30&version=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
				),
			),
		)
	return {
		entries: result.servers.map(({ server }) =>
			entry(
				kind,
				server.name,
				server.name,
				server.description,
				npmPackage(server)
					? `${server.version} · npm`
					: remoteEndpoint(server)
						? `${server.version} · ${remoteEndpoint(server)!.type}`
						: "此组件仅提供 Docker 或尚不支持的包格式",
				!!npmPackage(server) || !!remoteEndpoint(server),
			),
		),
		nextCursor: result.metadata?.nextCursor,
	}
}

export async function searchMcpPackages(query: string, cursor?: string): Promise<ExtensionResult> {
	const offset = cursor ? Number(cursor) : 0
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("Invalid MCP market page")
	const result = z
		.object({
			total: z.number(),
			objects: z.array(
				z.object({
					package: z.object({ name: z.string(), description: z.string().optional(), version: z.string() }),
					score: z.object({ final: z.number() }),
				}),
			),
		})
		.parse(
			JSON.parse(
				await read(
					`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query.trim() || "keywords:mcp-server")}&size=20&from=${offset}&quality=0&popularity=1&maintenance=0`,
				),
			),
		)
	return {
		entries: result.objects
			.filter((item) => npmName.test(item.package.name))
			.map((item) => ({
				...entry(
					"mcp",
					`npm:${item.package.name}`,
					item.package.name,
					item.package.description ?? "",
					`${item.package.version} · npm`,
				),
				rank: item.score.final,
			})),
		...(offset + 20 < result.total ? { nextCursor: String(offset + 20) } : {}),
	}
}

export async function installCommunitySkill(id: string): Promise<void> {
	const [owner, repository, name, extra] = id.split("/")
	if (!owner || !repository || !name || extra || ![owner, repository, name].every((part) => identifier.test(part)))
		throw new Error("Invalid skill catalog id")
	const root = getSystemToolDirectory("skills")
	if (!root) throw new Error("System tools directory is unavailable")
	const target = path.join(root, name)
	await fs.mkdir(root, { recursive: true })
	const stage = await fs.mkdtemp(path.join(root, ".install-"))
	try {
		const revision = z
			.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
			.parse(JSON.parse(await read(`https://api.github.com/repos/${owner}/${repository}/commits/HEAD`))).sha
		const isAas = `${owner}/${repository}` === skillsSnapshot.repository
		const catalogPath = isAas
			? (await loadSkillsCatalog()).items.find((skill) => skill.id === name)?.path
			: undefined
		if (isAas && !catalogPath) throw new Error("Skill is missing from the validated GitHub catalog")
		const treeRef = catalogPath ? encodeURIComponent(`${revision}:${catalogPath}`) : revision
		const tree = z
			.object({
				truncated: z.boolean(),
				tree: z.array(
					z.object({ path: z.string(), mode: z.string(), type: z.string(), size: z.number().optional() }),
				),
			})
			.parse(
				JSON.parse(
					await read(`https://api.github.com/repos/${owner}/${repository}/git/trees/${treeRef}?recursive=1`),
				),
			)
		if (tree.truncated) throw new Error("Repository tree is incomplete; cannot safely identify this skill")
		let candidates = tree.tree.filter((item) =>
			catalogPath
				? item.path === "SKILL.md"
				: item.path === `${name}/SKILL.md` || item.path.endsWith(`/${name}/SKILL.md`),
		)
		if (!candidates.length) candidates = tree.tree.filter((item) => item.path === "SKILL.md")
		if (candidates.length !== 1) throw new Error("The skill directory is missing or ambiguous in the repository")
		const prefix = candidates[0].path.slice(0, -"SKILL.md".length)
		const files = tree.tree.filter((item) => item.path.startsWith(prefix) && item.type === "blob")
		if (files.length > 200 || files.reduce((size, item) => size + (item.size ?? 0), 0) > 8 * 1024 * 1024)
			throw new Error("Skill exceeds the installation size limit")
		for (const file of files) {
			const relative = file.path.slice(prefix.length)
			if (
				!/^100(644|755)$/.test(file.mode) ||
				relative
					.split("/")
					.some(
						(part) =>
							!part ||
							part === "." ||
							part === ".." ||
							/[<>:"\\|?*]/.test(part) ||
							[...part].some((character) => character.charCodeAt(0) < 32) ||
							/[ .]$/.test(part) ||
							/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
					)
			)
				throw new Error("Unsafe path or link in skill package")
			const destination = path.join(stage, relative)
			await fs.mkdir(path.dirname(destination), { recursive: true })
			await fs.writeFile(
				destination,
				await download(
					`https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${catalogPath ? catalogPath + "/" : ""}${file.path.split("/").map(encodeURIComponent).join("/")}`,
				),
			)
			if (file.mode === "100755" && process.platform !== "win32") await fs.chmod(destination, 0o755)
		}
		if (catalogPath) {
			for (const license of ["LICENSE", "LICENSE-CONTENT"]) {
				await fs.writeFile(
					path.join(stage, `.octocode-${license}`),
					await read(`https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${license}`),
				)
			}
		}
		await fs.writeFile(
			path.join(stage, ".octocode-source.json"),
			JSON.stringify({ repository: `${owner}/${repository}`, revision, id, path: catalogPath }),
		)
		const document = await fs.readFile(path.join(stage, "SKILL.md"), "utf8")
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document)
		if (!frontmatter) throw new Error("Skill has no YAML frontmatter")
		const metadata = z
			.object({
				name: z
					.string()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
					.max(64),
				description: z.string().min(1).max(1024),
			})
			.parse(parseYaml(frontmatter[1]))
		if (metadata.name !== name) throw new Error("Skill name does not match its catalog directory")
		// rename fails if an existing installation contains files: never overwrite it.
		await fs.rename(stage, target)
	} finally {
		await fs.rm(stage, { recursive: true, force: true })
	}
}

export async function prepareCommunityMcp(id: string): Promise<{ item: MarketplaceItem; directory?: string }> {
	const npmId = id.startsWith("npm:") ? id.slice(4) : undefined
	if (npmId ? !npmName.test(npmId) : !/^[a-zA-Z0-9._/-]{1,250}$/.test(id) || id.includes(".."))
		throw new Error("Invalid MCP registry id")
	const metadata = npmId
		? z
				.object({ name: z.string(), version: z.string(), description: z.string().optional() })
				.parse(JSON.parse(await read(`https://registry.npmjs.org/${encodeURIComponent(npmId)}/latest`)))
		: undefined
	if (metadata && metadata.name !== npmId) throw new Error("MCP package identity does not match its registry entry")
	const result = metadata
		? {
				server: serverSchema.parse({
					name: id,
					description: metadata.description ?? "",
					version: metadata.version,
					packages: [
						{
							registryType: "npm",
							identifier: metadata.name,
							version: metadata.version,
							transport: { type: "stdio" },
						},
					],
				}),
			}
		: z
				.object({ server: serverSchema })
				.parse(JSON.parse(await read(`${registry}/${encodeURIComponent(id)}/versions/latest`)))
	const pkg = npmPackage(result.server)
	const remote = remoteEndpoint(result.server)
	if (!pkg && remote) {
		const headers: Record<string, string> = {}
		let disabled = false
		for (const header of remote.headers ?? []) {
			if (!header.name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name))
				throw new Error("Invalid MCP header name")
			const value = header.value ?? header.default
			if (value && !header.isSecret && !/[{}\r\n]/.test(value)) headers[header.name] = value
			else if (header.isRequired) disabled = true
		}
		return {
			item: {
				type: "mcp",
				id,
				name: result.server.title ?? id,
				description: result.server.description,
				url: "https://registry.modelcontextprotocol.io",
				content: JSON.stringify({ type: remote.type, url: remote.url, headers, disabled }),
			},
		}
	}
	if (!pkg || !npmName.test(pkg.identifier) || !pkg.version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version))
		throw new Error("This server has no supported, pinned native npm package")
	const root = getSystemToolDirectory("mcp")
	const environments = process.env.OCTOCODE_ENVIRONMENTS
	if (!root || !environments) throw new Error("System tools directory is unavailable")
	await fs.mkdir(root, { recursive: true })
	const directory = path.join(root, createHash("sha256").update(id).digest("hex").slice(0, 24))
	await fs.mkdir(directory) // refuses to overwrite an existing installation
	try {
		const node =
			process.env.OCTOCODE_NODE ??
			path.join(environments, "node", process.platform === "win32" ? "node.exe" : "bin/node")
		const npm = path.join(
			environments,
			"node",
			process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js",
		)
		await run(
			node,
			[
				npm,
				"install",
				"--prefix",
				directory,
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--registry=https://registry.npmjs.org",
				`${pkg.identifier}@${pkg.version}`,
			],
			{ timeout: 180_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
		)
		const packageRoot = path.join(directory, "node_modules", pkg.identifier)
		const manifest = z
			.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]) })
			.parse(JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")))
		const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin)
		if (bins.length !== 1) throw new Error("This MCP package does not have one unambiguous executable")
		const executable = path.resolve(packageRoot, bins[0])
		if (!executable.startsWith(packageRoot + path.sep))
			throw new Error("Package executable escaped installation directory")
		const args: string[] = [executable]
		let disabled = !!pkg.runtimeArguments?.length
		for (const arg of pkg.packageArguments ?? []) {
			const value = arg.value ?? arg.default
			if (!value || /[{}]/.test(value)) {
				disabled = true
				continue
			}
			if (arg.type === "named" && arg.name) args.push(arg.name)
			args.push(value)
		}
		const env: Record<string, string> = {}
		for (const variable of pkg.environmentVariables ?? []) {
			if (!variable.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name))
				throw new Error("Invalid MCP environment variable")
			const value = variable.value ?? variable.default
			if (value && !variable.isSecret) env[variable.name] = value
			else if (variable.isRequired) disabled = true
		}
		await fs.writeFile(
			path.join(directory, ".octocode-source.json"),
			JSON.stringify({ id, package: pkg.identifier, version: pkg.version }),
		)
		return {
			directory,
			item: {
				type: "mcp",
				id,
				name: id,
				description: result.server.description,
				url: "https://registry.modelcontextprotocol.io",
				content: JSON.stringify({
					command: node,
					args,
					env,
					disabled,
					...(disabled ? { disabledReason: "请在 MCP 设置中补全此服务要求的参数或凭据后启用。" } : {}),
				}),
			},
		}
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true })
		throw error
	}
}
