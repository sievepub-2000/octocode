import * as vscode from "vscode"
import { z } from "zod/v4"

const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).optional().default(60),
	alwaysAllow: z.array(z.string()).default([]),
	watchPaths: z.array(z.string()).optional(),
	disabledTools: z.array(z.string()).default([]),
})

export const typeErrorMessage = "Server type must be 'stdio', 'sse', or 'streamable-http'"

export const ServerConfigSchema = z.union([
	BaseConfigSchema.extend({
		type: z.enum(["stdio"]).optional(),
		command: z.string().min(1, "Command cannot be empty"),
		args: z.array(z.string()).optional(),
		cwd: z.string().default(() => vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? process.cwd()),
		env: z.record(z.string(), z.string()).optional(),
		url: z.undefined().optional(),
		headers: z.undefined().optional(),
	})
		.transform((data) => ({ ...data, type: "stdio" as const }))
		.refine((data) => data.type === undefined || data.type === "stdio", { message: typeErrorMessage }),
	BaseConfigSchema.extend({
		type: z.enum(["sse"]).optional(),
		url: z.string().url("URL must be a valid URL format"),
		headers: z.record(z.string(), z.string()).optional(),
		command: z.undefined().optional(),
		args: z.undefined().optional(),
		env: z.undefined().optional(),
	})
		.transform((data) => ({ ...data, type: "sse" as const }))
		.refine((data) => data.type === undefined || data.type === "sse", { message: typeErrorMessage }),
	BaseConfigSchema.extend({
		type: z.enum(["streamable-http"]).optional(),
		url: z.string().url("URL must be a valid URL format"),
		headers: z.record(z.string(), z.string()).optional(),
		command: z.undefined().optional(),
		args: z.undefined().optional(),
		env: z.undefined().optional(),
	})
		.transform((data) => ({ ...data, type: "streamable-http" as const }))
		.refine((data) => data.type === undefined || data.type === "streamable-http", { message: typeErrorMessage }),
])
