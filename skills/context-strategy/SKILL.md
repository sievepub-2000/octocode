---
name: context-strategy
description: Context management skill for selecting, prioritizing, and compressing information sent to LLMs to maximize relevance within token limits.
---

# context-strategy

Optimize what context to include in LLM interactions for maximum effectiveness.

## When to use

- The conversation involves a large codebase and you need to decide what to include.
- Token limits are a concern and context must be compressed.
- The user asks about context window management or prompt optimization.

## Instructions

1. **Audit available context**: List all potential context sources — files, history, docs, tool outputs, skills.
2. **Relevance scoring**: Rate each source on a 1–5 scale for relevance to the current task.
3. **Priority ordering**:
   - P0: Directly referenced files and the user's current instruction.
   - P1: Files that will be modified or are imported by P0 files.
   - P2: Related docs, tests, and type definitions.
   - P3: Historical conversation context (summarize, don't include verbatim).
   - P4: Project-wide context (README, config, architecture docs).
4. **Compression techniques**:
   - Show only relevant line ranges, not entire files.
   - Summarize large files as: purpose, key exports, dependencies.
   - Use diffs instead of full file contents when reviewing changes.
   - Collapse repetitive patterns into "N similar items" summaries.
5. **Token budget**: Allocate roughly: 40% current task context, 30% code, 20% history, 10% system/skills.
6. **Refresh strategy**: When context grows stale, re-evaluate and prune before adding more.
7. Never include binary files, lock files, or generated code in context.
