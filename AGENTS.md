## Workflow

- Starting a task: Read this guide end-to-end. Re-skim when major decisions arise or requirements shift.
- Reviewing git status or diffs: Treat them as read-only. Never revert or assume missing changes were yours.
- Planning: Study the existing codebase’s architecture, patterns, and conventions first; use external docs only when needed. Prioritize consistency, then simplicity.
- Trade-offs: If there's meaningful tension between approaches, ask the user before committing.
- Adding a dependency: Research well-maintained options and confirm fit with the user before adding.
- Starting to code: Don't start building until asked to.

## Code Quality

- Writing code: Write idiomatic, simple, maintainable code consistent with surrounding code. Optimize for the simplest, most intuitive solution.
- Before writing new code: Search the codebase for existing utilities, helpers, and patterns. Reuse and extend what exists rather than inventing new abstractions unless they’re clearly reused.
- Structuring code: Prefer the best design consistent with surrounding code, even if it means editing more code. If designs are equivalent, prefer fewer moving parts (smaller API surface, fewer changes).
- Organizing code: Follow the step-down rule. Keep high-level behavior at the top and details below. In classes: constructor, then public API methods, then private helpers. Prefer top-down call flow when practical.
- Editing code: No breadcrumbs. If you delete, move, or rename code, do not leave a comment in the old place.
- Fixing code: Reason from first principles, find the root cause of an issue, and fix it. Don't apply band-aids on top.
- Cleaning up: Clean up unused code ruthlessly. If a function no longer needs a parameter or a helper becomes unused, delete and update callers instead of letting junk linger. Never implement backward compatibility unless explicitly asked.

## Collaboration

- When review feedback is numbered, respond point-by-point and clearly mark what was addressed vs. deferred.
- Never push or open pull requests without the user explicitly asking you to.

## Communication

- Be direct, technical, and intellectually honest. No praise, filler, or performative politeness.
- If an idea is wrong or suboptimal, say so and explain why. Challenge assumptions and propose better alternatives.

## Skills

- Use the `oracle` skill when you need a review, a second opinion, or you're stuck.
- Use the `git-commit` skill when you will commit changes or propose commit messages.
- Use the `git-clean-history` skill when you need to create a clean branch with a refined commit history.
- Use the `browser-tools` skill when you need to interact with web pages or automate browser actions.
- Use the `homeassistant-ops` skill when you need to operate/refactor a Home Assistant instance.
- Use the `memory` skill when working in any repo that has a `.memory/` directory. Use `/memory sleep` to consolidate knowledge, compress context, and surface drift against the original brief.
- Use the `openscad` skill when you need to create and render OpenSCAD 3D models.
- Use the `sentry` skill when you need to fetch and analyze Sentry issues, events, and logs.
- Use the `web-design` skill when you need to design and implement distinctive, production-ready web interfaces.
- Use the `update-changelog` skill when you need to update CHANGELOG.md following Keep a Changelog.

## Memory

- Repo memory lives in `.memory/`.
- `.memory/core/` holds `directives.md`, `context.md`, `focus.md`, and `pending.md`. Keep the combined total at or below 300 lines.
- `.memory/wiki/` holds long-form knowledge, reflections, and `current_brief.md`.
- `.memory/raw/` holds large artifacts and media and is gitignored.
- If work is left unfinished, update `.memory/core/pending.md`.
- If architecture or behavior changes, update `.memory/core/context.md`.
- If a non-trivial decision or discovery occurs, append to `.memory/log.md`.
- If the user provides a substantial brief, write it to `.memory/wiki/current_brief.md` before acting.
- Sleep is the only consolidation mechanism. Drift correction happens during sleep.

## Tools

- Prefer `gh` to access GitHub issues, pull requests, etc.
- Use `git log` and `git blame` when historical context would help.
