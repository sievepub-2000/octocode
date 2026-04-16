---
name: autoresearch
description: Octocode research-loop skill derived from karpathy/autoresearch for disciplined architectural analysis and experiment planning.
---

# autoresearch

Apply an inspect-measure-keep-or-discard loop to Octocode.

## When to use

- You need a full-repository analysis.
- There are multiple candidate improvements across runtime, routing, packaging, and UI.
- You want prioritized follow-up experiments instead of vague suggestions.

## Instructions

1. Establish a baseline from README, Cargo workspace layout, runtime commands, and current UI behavior.
2. Analyze module by module and record concrete evidence.
3. Distinguish strong findings from hypotheses.
4. Prefer improvements that reduce coupling, increase observability, or improve validation coverage.
5. Keep a clear keep-or-discard mindset for ideas: only elevate items with technical evidence.
6. Remember the upstream autoresearch repo is not an MCP or packaged skill. It is a reusable agent method encoded in program.md, so use that method here as a local skill.