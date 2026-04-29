# Tau

Tau is a batteries-included distribution for [Pi](https://pi.dev), a brilliant coding agent by @badlogic that's barebones yet highly (and elegantly) extensible by design.

It takes Pi's minimal core and turns it into an opinionated, complete, polished experience, adding a `websearch` tool to complement the four default built-in tools, plus several useful skills and tasteful extensions, split into purpose-driven packages:

| Package            | Purpose         |
| ------------------ | --------------- |
| `tau-coding-agent` | Coding package. |
| `tau-all-agent`    | Full package.   |

## Install

[Install Pi](https://pi.dev/docs/latest#quick-start), and then:

```bash
pi install npm:tau-coding-agent
# or
pi install npm:tau-all-agent
```

Project-local install allows you to pin Tau for everyone working on the project:

```bash
pi install -l npm:tau-coding-agent
```

## Agent configuration

Tau does not include agent configuration; those files are highly personal.

Check out [goncalossilva/.agents](https://github.com/goncalossilva/.agents) for my `AGENTS.md`, `settings.json`, `sandbox.json`, etc.

## Extensions

| Extension          | Command              | Coding | All | Description                                                                                                               |
| ------------------ | -------------------- | :----: | :-: | ------------------------------------------------------------------------------------------------------------------------- |
| `answer`           | `/answer`            |   ✓    |  ✓  | Extract and interactively answer agent questions.                                                                         |
| `branch-term`      | `/branch`            |   ✓    |  ✓  | Open a new terminal on the current session's git branch.                                                                  |
| `btw`              | `/btw`               |   ✓    |  ✓  | Run a one-off side request with read-only tools and no context persistence.                                               |
| `ghostty`          | —                    |   ✓    |  ✓  | Ghostty tab title enhancements while the agent is working, waiting, or idle.                                              |
| `git-diff-stats`   | —                    |   ✓    |  ✓  | Status bar diff stats for local changes in the current repo.                                                              |
| `git-pr-status`    | —                    |   ✓    |  ✓  | Status bar PR number and link for the current branch.                                                                     |
| `insights`         | `/insights`          |   ✓    |  ✓  | Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions.                                 |
| `interlude`        | `alt+x`              |   ✓    |  ✓  | Stash the current message draft, send one interlude message, then restore the draft.                                      |
| `loop`             | `/loop`              |   ✓    |  ✓  | Repeat a prompt until the agent signals success.                                                                          |
| `memory`           | `/memory`            |   ✓    |  ✓  | Opt-in project-local memory for learning and continuity across sessions.                                                  |
| `notify`           | —                    |   ✓    |  ✓  | Terminal notification when the agent is waiting for input.                                                                |
| `openai-fast`      | `/fast`              |   ✓    |  ✓  | Toggle priority service tier for supported OpenAI models.                                                                 |
| `openai-verbosity` | `/verbosity`         |   ✓    |  ✓  | Set verbosity for supported OpenAI models.                                                                                |
| `review`           | `/review`, `/triage` |   ✓    |  ✓  | Multi-focus review and PR feedback triage for PRs, branches, commits, and local changes, with integrated follow-up fixes. |
| `sandbox`          | `/sandbox`           |   ✓    |  ✓  | OS-level sandboxing for bash commands with runtime overrides.                                                             |
| `usage`            | `/usage`             |   ✓    |  ✓  | Historical provider usage breakdown with all-provider history and live quota snapshots.                                   |
| `websearch`        | —                    |   ✓    |  ✓  | Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser session credentials.                                   |
| `worktree`         | `/worktree`          |   ✓    |  ✓  | Create, list, and archive git worktrees, optionally opening them in a new terminal or tmux pane.                          |
| `telegram`         | `/telegram`          |   —    |  ✓  | Interact with Pi via a Telegram bot and local daemon.                                                                     |
| `todoist`          | `/todoist`           |   —    |  —  | Todoist-backed tasks with offline outbox sync for single or multi-session work.                                           |

## Skills

| Skill               | Coding | All | Description                                                                        |
| ------------------- | :----: | :-: | ---------------------------------------------------------------------------------- |
| `browser-tools`     |   ✓    |  ✓  | Interactive browser automation via Chrome DevTools Protocol.                       |
| `git-clean-history` |   ✓    |  ✓  | Reimplement a branch on a fresh branch off `main` with a clean commit history.     |
| `git-commit`        |   ✓    |  ✓  | Tidy, focused commits with clear rationale in messages.                            |
| `oracle`            |   ✓    |  ✓  | Second opinion from another LLM for debugging, refactors, design, or code reviews. |
| `sentry`            |   ✓    |  ✓  | Fetch and analyze Sentry issues, events, transactions, and logs.                   |
| `update-changelog`  |   ✓    |  ✓  | Update CHANGELOG.md following Keep a Changelog.                                    |
| `web-design`        |   ✓    |  ✓  | Distinctive, production-ready web interfaces.                                      |
| `homeassistant-ops` |   —    |  ✓  | Operate a Home Assistant instance via REST/WebSocket APIs.                         |
| `openscad`          |   —    |  ✓  | Create and render OpenSCAD 3D models, export STL.                                  |

## Themes

| Theme      | Coding | All | Description                                                   |
| ---------- | :----: | :-: | ------------------------------------------------------------- |
| `tau-dark` |   ✓    |  ✓  | Pi's official dark theme with a calmer, more cohesive polish. |

## Development

```bash
npm install
npm run check

pi -e ./packages/tau-coding-agent
pi -e ./packages/tau-all-agent
```

The source package manifests reference local resources so `pi -e ./packages/...` works from this checkout. `npm run package` stages self-contained publishable packages under `dist/`.

## Publishing

All publishable packages share the same version. Release tags use the plain version number, for example `0.1.0`.

The GitHub Actions publish workflow stages packages under `dist/` and publishes in this order:

1. `tau-coding-agent`
2. `tau-all-agent`

Published packages are self-contained copies of their selected Tau resources.

## Acknowledgements

Some extensions and skills were inspired by prior work from other agent setups and Pi users:

- @mitsuhiko for `answer`, `btw`, `loop`, `openscad`, `sentry`, `update-changelog`, and `web-design`
- @badlogic for `sandbox` and `browser-tools`
- @mjakl for `interlude`

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
