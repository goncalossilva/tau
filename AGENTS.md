## Workflow

- Starting a task: Read this guide end-to-end. Re-skim when major decisions arise or requirements shift.
- Reviewing git status or diffs: Treat them as read-only. Never revert or assume missing changes were yours.
- Planning: Consider the architecture. Research official docs, blogs, or papers. Review the existing codebase. Combine simplicity, modern best practices, and consistency with existing patterns/code. Ask about trade-offs if unsure.
- Adding a dependency: Research well-maintained options and confirm fit with the user before adding.
- Starting to code: Don't start building until asked to.

## Code Quality

- Writing code: Always idiomatic, simple, maintainable code. Always ask yourself if this is the most simple and intuitive solution to the problem.
- Code organization: Follow the step-down rule. Keep high-level behavior at the top and details below. In classes: constructor, then public API methods, then private helpers. Prefer top-down call flow when practical.
- Editing code: No breadcrumbs. If you delete, move, or rename code, do not leave a comment in the old place.
- Fixing code: Reason from first principles, find the root cause of an issue, and fix it. Don't apply band-aids on top.
- Cleaning up: Clean up unused code ruthlessly. If a function no longer needs a parameter or a helper becomes unused, delete and update callers instead of letting junk linger.

## Collaboration

- If you're unsure about trade-offs, ask the user explicitly.
- When review feedback is numbered, respond point-by-point and clearly mark what was addressed vs. deferred.

## Skills

- Use the `oracle` skill when you need a review, a second opinion, or you're stuck.
- Use the `git-commit` skill when you will commit changes or propose commit messages.
- Use the `git-clean-history` skill when you need to create a clean branch with a refined commit history.
- Use the `browser-tools` skill when you need to interact with web pages or automate browser actions.
- Use the `homeassistant-ops` skill when you need to operate/refactor a Home Assistant instance.
- Use the `openscad` skill when you need to create and render OpenSCAD 3D models.
- Use the `sentry` skill when you need to fetch and analyze Sentry issues, events, and logs.
- Use the `web-design` skill when you need to design and implement distinctive, production-ready web interfaces.
- Use the `update-changelog` skill when you need to update CHANGELOG.md following Keep a Changelog.

## Tools

- Use `gh` to access GitHub issues, pull requests, etc.
