---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use for real-browser frontend testing, dynamic-page interaction, or user selection in a visible browser.
---

# Browser Tools

Tools for interacting with Chromium or Google Chrome over remote debugging at `127.0.0.1:9222`. Ordinary source edits and pages retrievable without browser interaction do not require this skill.

## Setup and session ownership

Chromium or Chrome with remote debugging support is required. Scripts auto-detect common macOS and Linux installs. For development in a source checkout, install dependencies with `npm install` at the repository root.

Run browser commands from this skill directory. All command paths in this skill and its references are relative to this directory, not `references/`.

```bash
"./scripts/browser-start.js"                         # Dedicated tool profile
"./scripts/browser-start.js" --profile               # Seed cookies/logins from your browser profile
"./scripts/browser-start.js" --browser chromium      # Or chrome
"./scripts/browser-start.js" --executable /path/to/browser
```

- An existing browser on `:9222` is reused. `--browser`, `--executable`, and `--profile` affect only new instances. Do not kill or restart a user's browser to apply launch options.
- New instances use `~/.cache/browser-tools`. `--profile` syncs the source profile into that dedicated directory, excluding session/tab files. It does not operate directly on the source profile, but can overwrite tool-profile state. Use it when existing authentication is needed, not as a routine reset.
- Preserve the user's tabs, drafts, and authentication. Open a new tab rather than navigating an unrelated one. Check the target URL before acting. Close only tabs you created and no longer need, not user-owned tabs or the reused browser.

Environment overrides:

| Variable                    | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `BROWSER_TOOLS_BROWSER`     | `chromium` or `chrome` selection                                                                                 |
| `BROWSER_TOOLS_EXECUTABLE`  | Explicit browser executable path                                                                                 |
| `BROWSER_TOOLS_PROFILE_SRC` | Source profile directory for `--profile`. With a custom executable in auto mode, set this or select `--browser`. |
| `BROWSER_TOOLS_LOG_ROOT`    | Watcher log directory. See the logging reference before enabling capture.                                        |

## Task router

Read only the reference needed for the task before running its commands.

| Task                                                              | Read                                     | Scripts                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Navigate, inspect DOM, interact, or wait for app state            | [Interaction](references/interaction.md) | `browser-nav.js`, `browser-eval.js`                                                              |
| Verify appearance or let the user select elements                 | [Interaction](references/interaction.md) | `browser-screenshot.js`, `browser-pick.js`                                                       |
| Extract readable content that needs a browser                     | [Interaction](references/interaction.md) | `browser-content.js`                                                                             |
| Diagnose console errors or network activity                       | [Logging](references/logging.md)         | `browser-watch.js`, `browser-logs-tail.js`, `browser-net-summary.js`, `browser-start.js --watch` |
| Handle blocking consent dialogs or inspect/export session cookies | [Cookies](references/cookies.md)         | `browser-dismiss-cookies.js`, `browser-cookies.js`                                               |

Choose DOM inspection for structure and values, screenshots for visual questions, and the picker when the user wants to identify elements. Batch only steps whose intermediate results do not need inspection. Verify observable outcomes rather than equating a click or elapsed delay with success.
