# .agents

Reusable agent harness shared across Codex, Claude, and Pi. Everything lives here and is symlinked into each agent's config folder.

## Layout

```
AGENTS.md              Shared base instructions (symlinked into each agent folder)
skills/                Skill source of truth (SKILL.md + optional scripts/assets)
pi/extensions/         Pi-specific extensions
pi/agent/sandbox.json  Repo-managed Pi sandbox defaults
bin/sync               Symlink everything into Codex, Claude, and Pi config dirs
```

## Syncing

`AGENTS.md` is symlinked into each agent config. Skills are symlinked to Claude, while Codex and Pi auto-discover them from `~/.agents/skills`.

| Content | Codex | Claude | Pi |
|---------|-------|--------|----|
| Instructions | `~/.codex/AGENTS.md` | `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md` |
| Skills | `~/.agents/skills` | `~/.claude/skills/` | `~/.agents/skills` |
| Extensions | — | — | `~/.pi/agent/extensions/` |
| Sandbox config | — | — | `~/.pi/agent/sandbox.json` |

```bash
~/.agents/bin/sync --prune
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

| Extension | Command | Description |
|-----------|---------|-------------|
| `answer` | `/answer` | Extract and interactively answer agent questions |
| `branch-term` | `/branch-term` | Open a new terminal on the current session's git branch |
| `ghostty` | _automatic_ | Ghostty tab title and progress while the agent is working |
| `loop` | `/loop` | Repeat a prompt until the agent signals success |
| `review` | `/review` | Review PRs, branches, commits, or uncommitted changes |
| `sandbox` | `/sandbox` | OS-level sandboxing for bash commands with runtime overrides |
| `session-breakdown` | `/session-breakdown` | Usage stats and contribution-style calendar |
| `todo` | `/todo` | Todoist-backed tasks with offline outbox sync for single or multi-session work |
| `websearch` | — | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials |
| `git-checkpoint` | _automatic_ | Stash checkpoints each turn so `/fork` can restore code state |
| `notify` | _automatic_ | Terminal notification when the agent is waiting for input |
