import type { PermissionProfile } from "@roo-code/types"

export type WorkbenchPermissionOperation = "read" | "write" | "browser" | "execute"
export type WorkbenchTaskIdentity = {
	taskId: string
	sessionId: string
	permissionProfile?: PermissionProfile
	readOnly?: boolean
}

export function requireWorkbenchPermission(
	operation: WorkbenchPermissionOperation,
	task: WorkbenchTaskIdentity | undefined,
): WorkbenchTaskIdentity {
	if (!task) throw new Error("Authenticated task is required")
	if (operation === "read" || operation === "browser") return task
	if (task.permissionProfile !== "full" || task.readOnly) {
		throw new Error(`OctoCode permission profile does not allow ${operation}`)
	}
	return task
}
