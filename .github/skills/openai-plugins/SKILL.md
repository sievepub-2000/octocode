---
name: openai-plugins
description: "Use when: working with OpenAI Codex plugins, plugin marketplaces, plugin manifests, plugin-bundled skills, or the openai/plugins repository. Helps inspect .codex-plugin/plugin.json, .agents/plugins/marketplace.json, and installed Codex plugin cache."
---

# OpenAI Plugins

Use the official OpenAI plugins repository as source context for Codex plugin work.

Local source cache:

- `C:/Users/周浩/.codex/vendor_imports/openai/plugins`

Codex runtime locations to inspect:

- `C:/Users/周浩/.codex/config.toml`
- `C:/Users/周浩/.codex/plugins/cache/`
- `C:/Users/周浩/.codex/.tmp/bundled-marketplaces/openai-bundled/`

Workflow:

1. Check whether the requested plugin is already enabled in `config.toml`.
2. Inspect plugin manifests before assuming tools are available.
3. Prefer official plugin manifests and bundled `SKILL.md` files over ad hoc instructions.
4. If installing a local plugin, keep marketplace source and plugin cache paths explicit.
