---
name: upgrade-pi
description: Audit or upgrade Tau for a Pi release, or assess a specific Pi API compatibility change.
compatibility: Requires Node.js 24+, npm, tar, git, and a POSIX environment.
---

# Upgrade Pi

Choose the appropriate workflow.

- **Focused API assessment:** Inspect the owning Tau resource, relevant release entries, and target public docs, declarations, and runtime. Read examples as needed. Report compatibility requirements, useful opportunities, evidence, and unresolved verification. Do not implement an assessment request. Use the full audit only if the question requires distribution-wide coverage.
- **Complete upgrade audit or implementation:** Follow the [full upgrade workflow](references/upgrade-workflow.md), reusing a reviewed audit if the target and Tau source still match. Audit-only work ends at a reviewed plan without source changes. An authorized upgrade continues through implementation, validation, and final review.

Use public APIs from the target Pi version. Passing compilation does not establish runtime compatibility.

Keep extensions and skills independently usable. Do not couple resources merely to deduplicate trivial code or guidance, or make one skill depend on another. Skill-local supporting references are fine.

The [audit prompt templates](references/audit-prompts.md) cover release and resource passes plus independent reviews. They are for complete upgrades, not a checklist for focused API questions.
