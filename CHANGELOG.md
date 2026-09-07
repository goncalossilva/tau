# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added explicit fullscreen scrollbar and search colors to the Tau theme.
- Added the `github-pull-request` skill for creating and stewarding pull requests through CI, review, and merge.

### Changed

- Made `/fast` and `/verbosity` preferences provider/model-local, preserving shared defaults and coordinating saves across Pi processes.
- Switched prompt-aware status, notifications, and Review cancellation to Pi's native prompt lifecycle.
- Limited `/verbosity` to supported GPT-5 and GPT-6 models while supporting Responses and Chat Completions transports.
- Generalized `/fast` to compatible providers and Chat Completions models.
- Updated Pi to 0.85.1, preserving provider settings across nested model calls and raw web searches, active status through in-run compaction, and wrapped-editor mouse handling.
- Improved sandbox defaults for Kotlin/Native and Java tooling on macOS and Linux.

### Fixed

- Cancelled and joined Loop status summarization before ending, restoring, or closing a loop.
- Preserved `/btw` answers through narrow terminal resizes without overflowing the display.
- Required explicit pending-work decisions during Memory dreams instead of inferring completion from summary wording.
- Preserved Memory log corrections when timestamps repeat or clocks move backward, without overwriting earlier dream summaries.
- Made switched worktree conversations discoverable from the destination's default session storage while preserving custom session directories.
- Kept `/worktree list` actions on the selected checkout when detached worktrees share a label.
- Honored `.worktreeinclude` exclusions inside copied cache directories without scanning excluded subtrees.
- Limited Websearch results and errors to 2,000 lines or 50 KB, preserving full output in private temporary files. (#14)
- Rejected incomplete Codex web searches and stopped browser fallback attempts on cancellation.
- Stopped PR status lookups before session teardown and prevented outdated results from restoring another branch's PR. (#16)
- Queued Telegram attachments from inactive sessions until their originating session is selected, preserving file contents and preventing cross-session delivery.
- Restored `/branch` terminal and tmux flags with quoted launch arguments and recovery on launcher failure.
- Persisted `/branch` forks before terminal handoff, including pre-assistant and empty selections.
- Made `/branch` recovery commands work with custom session storage and shell-sensitive paths.
- Kept long `/answer` questionnaires width-safe and preserved drafts through narrow terminal resizes.
- Reported `/answer` extraction failures instead of treating them as cancellation or accepting failed responses.
- Stopped background Git diff processes and cleaned up temporary indexes before closing or replacing sessions.
- Corrected historical Usage totals to follow activity dates, count copied fork history once, and include tool and summary usage.
- Kept Ghostty terminal titles synchronized with session renames and outstanding parallel tools.
- Preserved stashed drafts across extension reloads and avoided overwriting in-progress editor text during restoration.
- Preserved the selected conversation branch when switching worktrees.
- Stopped active loops after terminal agent errors instead of repeatedly restarting failed runs.
- Restored loop state from the selected conversation branch when resuming or navigating session history.
- Corrected Gemini web search requests when using Pi credentials.
- Preserved complete pasted answers when navigating and submitting `/answer` forms.
- Fixed Review model discovery hanging indefinitely or failing on unrelated provider refresh errors.
- Fixed Usage attributing Anthropic server-side fallbacks to the requested model instead of the responding model.
- Fixed sandboxed and bypassed shell commands losing Pi session environment values after session changes.
- Fixed Ghostty and Telegram remaining in compaction state after a failed or cancelled compaction.
- Fixed `ctrl+o` tool output cycling between collapsed, expanded, and minimal modes.
- Fixed repeated sandbox commands inheriting stale violation reports from earlier attempts.
- Fixed filesystem and macOS service approval time exhausting the command's automatic retry timeout.

### Security

- Preserved newer sandbox restrictions when accepting pending filesystem approvals, without reviving a runtime blocked by missing prerequisites.
- Blocked shell execution when required sandbox dependencies are missing instead of running unsandboxed.

## [0.1.6] - 2026-08-01

### Added

- `/insights` now outputs its report into a temporary file and shows the path after closing. (#4)
- Added paired-session Telegram file sending through `telegram_send_file`. Thanks @AfzalivE. (#5)
- Added per-session macOS Mach/XPC service approvals to the sandbox. Thanks @AfzalivE. (#6)

### Changed

- Updated Pi to 0.83.0 and migrated extensions to its model runtime and credential APIs.
- Enabled provider-side strict JSON Schema sampling for review and triage submissions when supported.
- Included nested model usage from the memory dream tool in Pi session totals.
- Allowed sandboxed macOS tools to query system DNS and network configuration by default.
- Included `/sandbox enable` and `/sandbox disable` state changes in agent context.
- Updated Oracle to prefer GPT-5.6 Sol and Claude Fable 5 when available.

### Fixed

- Sandboxed Git-over-SSH on macOS now works with the authenticated network proxy. ([upstream #385](https://github.com/anthropic-experimental/sandbox-runtime/pull/385))

## [0.1.5] - 2026-07-10

### Added

- Added environment-variable support in sandbox path settings.
- Allowed sandboxed commands to use the active SSH agent by default.
- Added security and testing review focuses, with `focus=` filtering for `/review` and `/fix`.
- Added message queueing while `/review` and `/fix` are running.
- Added `/fix loop` to keep fixing until reviews pass or progress stops.

### Changed

- Updated Pi to 0.80.6.
- Oracle checks now use the strongest available thinking setting by default.
- Moved extension config lookups to Pi's configured agent directory; `websearch.json` now lives under `~/.pi/agent` by default.
- Project sandbox config is now ignored until the project is trusted, with a warning when it is skipped.
- `/branch` and `/worktree` command cards no longer pollute model context.
- Improved websearch responsiveness when using browser sessions.
- Made `/fix` use findings from partial reviews instead of failing the whole run.
- Let `/fix` mark valid out-of-scope findings as deferred follow-up for the project backlog.
- Renamed the `interlude` extension and keybinding config to `stash`.
- Improved `/review` prompts to favor locally verifiable findings and lean-code quality checks.
- Improved `/review` output with run durations and clearer invalid-output excerpts.
- Relaxed sandbox defaults for common developer caches and trusted package/source domains.
- Allowed sandboxed commands to access OpenRouter by default.
- Improved sandbox defaults for Kotlin, Android, and Gradle workflows while protecting user-level Gradle config.
- Improved Python developer ergonomics by suppressing prompts for blocked `__pycache__` writes.

### Fixed

- Incidental macOS service lookups no longer interrupt otherwise successful sandboxed commands.
- Fixed `/review` resolving OpenRouter model IDs containing `/` to the wrong provider.
- Fixed Oracle model checks loading unrelated telegram extension resources.
- Fixed sandbox prompts when traversal commands skip protected read-denied directories.
- Fixed loop, notify, telegram, ghostty, and review extensions acting before retries or continuations had fully finished.
- Fixed TUI-only extension commands to avoid opening unsupported custom UI in RPC mode.
- Fixed telegram extension sessions going silent when Pi ended with an error.
- Fixed rare `/review` runs that could finish without usable findings and leave stray result files.
- Fixed `/sandbox off` still prompting for network access.

## [0.1.4] - 2026-05-09

### Added

- Added a sandbox `allowTempDirs` option, enabled by default, for platform temporary directory writes.

### Changed

- Replaced deprecated Telegram dependency with built-in Telegram Bot API client.
- Tightened compact tool rendering.
- Allowed `/fix context=...` to guide fix passes without forcing a fresh review.

### Removed

- Removed live Gemini CLI quota reporting because Pi no longer includes the Gemini CLI provider.

## [0.1.3] - 2026-05-04

### Added

- Added the `tool-display-mode` extension.

### Changed

- Improved npm package metadata.
- Updated npm package README taglines.
- Relaxed default sandbox settings for common coding workflows.

## [0.1.2] - 2026-04-29

### Changed

- Improved npm package READMEs with feature summaries and command descriptions.

## [0.1.1] - 2026-04-29

### Added

- Added the `tau-dark` Pi theme.

### Changed

- Allowed Oracle reviews to include scratch diff files such as `/tmp/review.diff`.

### Removed

- Removed the `answer` extension keyboard shortcut; use `/answer` instead.

## [0.1.0] - 2026-04-29

### Added

- Published the initial Tau package snapshot, based on `goncalossilva/.agents` as of 2026-04-29.
