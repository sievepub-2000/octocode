---
name: agent-skills
description: Meta-skill: how to write a SKILL.md that the OctoCode skills hub will pick up. Source of truth for the descriptor schema.
integration: internal
status: documented
---

# agent-skills

Canonical template and discovery rules for OctoCode skills.

## Frontmatter fields

| Field          | Required | Meaning                                                         |
|----------------|----------|-----------------------------------------------------------------|
| `name`         | yes      | Stable identifier; lowercase-with-dashes. Must match dir name.  |
| `description`  | yes      | One-sentence purpose. Shown in `skills-list` output.            |
| `integration`  | yes      | One of: `internal` / `external-library` / `external-binary` / `external-agent` / `reference-only`. |
| `source`       | if external | Upstream URL. Audit trail for provenance.                    |
| `status`       | recommended | `documented` / `descriptor-only` / `stable` / `experimental`.|

## Discovery

`octocode_skills::SkillRegistry::discover(workspace_root, user_config_home)` walks:
1. `<workspace>/skills/*/SKILL.md`
2. `<user_config_home>/octocode/skills/*/SKILL.md`

Workspace skills shadow user skills of the same `name`.

## Lifecycle

- Add: drop a new `skills/<name>/SKILL.md` with the frontmatter above. No registration step needed.
- Remove: delete the directory. `skills-list` reflects on next run (no cache).
- Update: edit the SKILL.md. Changes are live on next run.

## See also

- `tools-hub` — the aggregate view.
- `find-skill` — discovery helper.
