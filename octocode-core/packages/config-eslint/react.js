import pluginReactHooks from "eslint-plugin-react-hooks"
import eslintReact from "@eslint-react/eslint-plugin"
import globals from "globals"

import { config } from "./base.js"

/**
 * @type {import("eslint").Linter.Config[]}
 */
export const reactConfig = [
	...config,
	{
		plugins: {
			"@eslint-react": eslintReact,
		},
		languageOptions: {
			globals: {
				...globals.serviceworker,
			},
		},
		rules: {
			"@eslint-react/no-direct-mutation-state": "error",
			"@eslint-react/no-missing-key": "error",
			"@eslint-react/dom-no-unknown-property": "error",
		},
	},
	{
		plugins: {
			"react-hooks": pluginReactHooks,
		},
		settings: { react: { version: "detect" } },
		rules: {
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
		},
	},
]
