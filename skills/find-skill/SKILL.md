---
name: find-skill
description: Meta-skill for discovering, searching, and recommending available skills based on the current task context.
---

# find-skill

Search and recommend the right skill for any given task.

## When to use

- The user isn't sure which skill to apply.
- A new task arrives and skill selection would help.
- The user asks "what skills are available?" or "what can you do?".

## Instructions

1. **List installed skills**: Scan `skills/` directories for all `SKILL.md` files. Report each skill's name and one-line description.
2. **Match by task**: When the user describes a task, score each available skill on relevance (0–3):
   - 3 = directly designed for this task
   - 2 = useful supporting skill
   - 1 = tangentially related
   - 0 = not relevant
3. **Recommend**: Suggest the top 1–3 skills with a brief explanation of why each fits.
4. **Compose**: If a task benefits from multiple skills, suggest a sequence (e.g., "spec-kit → autoresearch → get-shit-down").
5. **Gap detection**: If no installed skill fits well, say so and suggest what kind of skill would be needed.
6. **Skill format reference**: Skills are Markdown files with YAML frontmatter (`name`, `description`) under `skills/{skill-name}/SKILL.md`.
7. Do not invent skills that don't exist — only recommend installed ones.
