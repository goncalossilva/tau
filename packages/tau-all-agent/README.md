# tau-all-agent

All-purpose agent for [Pi](https://pi.dev).

Tau turns Pi's minimal core into an opinionated, polished agent setup with the full Tau feature set: coding workflows, web search, code review, sandboxing, local memory, usage reporting, Telegram access, Home Assistant operations, OpenSCAD modeling, and a curated skill set.

## Install

```bash
pi install npm:tau-all-agent
```

Project-local install lets a repository pin Tau for everyone working on it:

```bash
pi install -l npm:tau-all-agent
```

## Extensions

| Extension           | Command              | Description                                                                                                               |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `answer`            | `/answer`            | Extract and interactively answer agent questions.                                                                         |
| `branch-term`       | `/branch`            | Open a new terminal on the current session's git branch.                                                                  |
| `btw`               | `/btw`               | Run a one-off side request with read-only tools and no context persistence.                                               |
| `ghostty`           | —                    | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`    | —                    | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`     | —                    | Status bar PR number and link for the current branch.                                                                     |
| `insights`          | `/insights`          | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `stash`             | `alt+x`              | Stash the current message draft, send one message, then restore it.                                                       |
| `loop`              | `/loop`              | Repeat a prompt until the agent signals success.                                                                          |
| `memory`            | `/memory`            | Opt-in project-local memory for learning and continuity across sessions.                                                  |
| `notify`            | —                    | Terminal notification when the agent is waiting for input.                                                                |
| `openai-fast`       | `/fast`              | Toggle priority service tier for supported OpenAI models.                                                                 |
| `openai-verbosity`  | `/verbosity`         | Set verbosity for supported OpenAI models.                                                                                |
| `review`            | `/review`, `/triage` | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| `sandbox`           | `/sandbox`           | OS-level sandboxing for bash commands with runtime overrides.                                                             |
| `tool-display-mode` | `ctrl+o`             | Cycle tool output between Pi's default rendering, expanded output, and compact summaries.                                 |
| `telegram`          | `/telegram`          | Interact with Pi via a Telegram bot, mirror output, and send files from local sessions.                                   |
| `usage`             | `/usage`             | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| `websearch`         | —                    | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`          | `/worktree`          | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |

## Skills

| Skill               | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| `browser-tools`     | Interactive browser automation via Chrome DevTools Protocol.                       |
| `git-clean-history` | Reimplement a branch on a fresh branch off `main` with a clean commit history.     |
| `git-commit`        | Tidy, focused commits with clear rationale in messages.                            |
| `homeassistant-ops` | Operate a Home Assistant instance via REST/WebSocket APIs.                         |
| `openscad`          | Create and render OpenSCAD 3D models, export STL.                                  |
| `oracle`            | Second opinion from another LLM for debugging, refactors, design, or code reviews. |
| `sentry`            | Fetch and analyze Sentry issues, events, transactions, and logs.                   |
| `update-changelog`  | Update CHANGELOG.md following Keep a Changelog.                                    |
| `web-design`        | Distinctive, production-ready web interfaces.                                      |

## Themes

| Theme      | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `tau-dark` | Pi's official dark theme with a calmer, more cohesive polish. |

## Agent configuration

Tau does not include agent configuration; those files are highly personal. Configure Pi with your own `AGENTS.md`, `settings.json`, sandbox config, and model preferences.
