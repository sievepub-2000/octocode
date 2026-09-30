import { createNodeProvisionerHost } from "./node-host"
import { EnvironmentProvisioner, type ProvisionProgress } from "./provisioner"

export * from "./manifest"
export * from "./provisioner"
export { createNodeProvisionerHost } from "./node-host"

let shared: EnvironmentProvisioner | undefined

/**
 * The provisioner for the installed product, or undefined when the environment
 * root is unknown.
 *
 * `OCTOCODE_ENVIRONMENTS` is exported by the desktop shell's bootstrap. Outside
 * the packaged product (unit tests, a plain `code --extensionDevelopmentPath`)
 * there is nothing to provision into, and callers must degrade to "assume the
 * tool is on PATH" rather than inventing a directory.
 */
export function getSharedEnvironmentProvisioner(): EnvironmentProvisioner | undefined {
	const root = process.env.OCTOCODE_ENVIRONMENTS
	if (!root) return undefined
	if (!shared) {
		shared = new EnvironmentProvisioner(createNodeProvisionerHost(root))
	}
	return shared
}

/** Test seam: drop the cached instance so a new env root takes effect. */
export function resetSharedEnvironmentProvisioner(): void {
	shared = undefined
}

export type { ProvisionProgress }
