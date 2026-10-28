/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Relocate both SDK 2 addons to the same verified on-demand cache as its DLLs. */
export function patchFoundryNativeLoader(source: string): string {
	const marker = '// VSCODE_PATCH:foundry-native-dir-v2';
	if (source.includes(marker)) {
		return source;
	}
	const needle = 'const prebuildDir = resolve(pkgRoot, "prebuilds", `${process.platform}-${process.arch}`);';
	if (!source.includes(needle)) {
		throw new Error('foundry-local-sdk native loader layout changed; refusing an incomplete on-demand runtime override');
	}
	return source.replace(needle, `${marker}\nconst prebuildDir = resolve(process.env.VSCODE_FOUNDRY_LOCAL_NATIVE_DIR || pkgRoot, "prebuilds", \`\${process.platform}-\${process.arch}\`);`);
}
