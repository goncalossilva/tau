# .agents

Reusable agent harness shared across Codex, Claude, and Pi. Everything lives here and is symlinked into each agent's config folder.

## Layout

```
AGENTS.md              Shared base instructions (symlinked into each agent folder)
skills/                Skill source of truth (SKILL.md + optional scripts/assets)
pi/extensions/         Pi-specific extensions
pi/agent/*.json        Repo-managed Pi JSON defaults
bin/setup              Set up selected Codex, Claude, and Pi configuration, skills, extensions, and dependencies
```

## Installing

`AGENTS.md` is symlinked into each agent config. Skills are symlinked to Claude, while Codex and Pi auto-discover them from `~/.agents/skills`.

| Content | Codex | Claude | Pi |
|---------|-------|--------|----|
| Instructions | `~/.codex/AGENTS.md` | `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md` |
| Skills | `~/.agents/skills` | `~/.claude/skills/` | `~/.agents/skills` |
| Extensions | — | — | `~/.pi/agent/extensions/` |
| JSON config | — | — | `~/.pi/agent/*.json` |

`bin/setup` syncs the selected agent files and installs npm runtime dependencies for relevant packages.

By default it sets up all agents. Pass `--codex`, `--claude`, and/or `--pi` to limit to those agents.

```bash
~/.agents/bin/setup --prune
```

## Skills

| Skill | Description |
|-------|-------------|
| `browser-tools` | Interactive browser automation via Chrome DevTools Protocol |
| `git-clean-history` | Reimplement a branch on a fresh branch off `main` with a clean commit history |
| `git-commit` | Tidy, focused commits with clear rationale in messages |
| `homeassistant-ops` | Operate a Home Assistant instance via REST/WebSocket APIs |
| `openscad` | Create and render OpenSCAD 3D models, export STL |
| `oracle` | Second opinion from another LLM for debugging, refactors, design, or code reviews |
| `sentry` | Fetch and analyze Sentry issues, events, and logs |
| `update-changelog` | Update CHANGELOG.md following Keep a Changelog |
| `web-design` | Distinctive, production-ready web interfaces |

## Pi Extensions

| Extension | Command / Shortcut | Description |
|-----------|--------------------|-------------|
| answer | `/answer` | Extract and interactively answer agent questions |
| branch-term | `/branch` | Open a new terminal on the current session's git branch |
| btw | `/btw` | Run a one-off side request with read-only tools and no context persistence |
| openai-fast | `/fast` | Toggle priority service tier for supported OpenAI models |
| ghostty |  | Ghostty tab title and progress while the agent is working, waiting, or idle |
| git-diff-stats |  | Status bar diff stats for local changes in the current repo |
| git-pr-status |  | Status bar PR number and link for the current branch |
| insights | `/insights` | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions |
| interlude | `ctrl+x` <small>(configurable)</small> | Stash the current message draft, send one interlude message, then restore the draft |
| loop | `/loop` | Repeat a prompt until the agent signals success |
| notify |  | Terminal notification when the agent is waiting for input |
| openai-verbosity | `/verbosity` | Set verbosity for supported OpenAI models |
| review | `/review`, `/triage` | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes |
| sandbox | `/sandbox` | OS-level sandboxing for bash commands with runtime overrides |
| session-breakdown | `/session-breakdown` | Usage stats and contribution-style calendar |
| telegram | `/telegram` | Interact with Pi via a Telegram bot and local daemon |
| todo | `/todo` | Todoist-backed tasks with offline outbox sync for single or multi-session work |
| websearch |  | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials |
| worktree | `/worktree` | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane |
