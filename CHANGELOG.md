# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Revoke and join pending Sandbox network approvals when their Bash command ends, preventing stale permission changes and decisions leaking into later commands.

## [0.2.0] - 2026-09-27

### Migration notes

- **Telegram:** Replace `PI_TELEGRAM_BOT_TOKEN` with `TAU_TELEGRAM_BOT_TOKEN` and `PI_TELEGRAM_DISABLE` with `TAU_TELEGRAM_DISABLE`.
- **Fast preferences:** In your agent directory, rename `openai-fast.json` to `fast.json`, or merge its `models` entries if `fast.json` already exists.
- **Websearch:** In custom `websearch.json` files, replace `firefox:openai-codex` and `chromium:openai-codex` with `pi:openai-codex`.

### Added

- Background subagents with model and thinking overrides, steering, and queued sandbox approvals.
- Per-command approval for agents and subagents to run Bash outside the sandbox, with access denied by default.
- `caffeinate` to prevent system sleep during agent runs while allowing the display to sleep.
- Fullscreen scrollbar and search colors for the Tau theme.
- The `github-pull-request` skill to create pull requests, check CI, address reviews, and prepare for merge.

### Changed

- **Breaking:** Renamed Tau environment variables to `TAU_*`.
- Replaced GPT-5.3-Codex-Spark with GPT-5.6 Luna for Answer, Loop, and Review ahead of Spark's retirement.
- Websearch tries another model when the preferred model is unavailable.
- Review and Subagent progress share the input box border, with expandable details.
- Escape requires confirmation before cancelling ongoing Review or Subagent work.
- Readiness notifications work in Supacode background sessions.
- **Breaking:** Extended `/fast` to Chat Completions models and renamed its configuration from `openai-fast.json` to `fast.json`.
- Limited `/verbosity` to supported GPT-5 and GPT-6 models, including Chat Completions.
- Improved sandbox support for Kotlin/Native and Java.
- Usage and Insights include Pi's background prompt-caching costs.

### Removed

- **Breaking:** Browser-backed ChatGPT Websearch, which could no longer complete browser verification. OpenAI search remains available through Pi's Codex credentials.

### Fixed

- Made Review apply scope and severity rules consistently across review types.
- Incorrect Oracle model ranking for GPT-6 Astra.
- Preserved shell settings in non-interactive sessions.
- Preserved shared defaults and concurrent sessions' changes when saving `/fast` and `/verbosity` preferences.
- Broken `ctrl+o` cycling and editor mouse controls, and incorrect Bash line counts in minimal mode.
- Drafts and results hidden or lost in narrow `/answer`, `/btw`, and Insights layouts. (#13)
- Preserved large pasted answers and reported failed question extraction in `/answer`.
- Made Insights follow the selected branch and retain final feedback from long conversations.
- Stopped scanning session history when Insights is cancelled.
- Respected custom provider settings in summaries and web searches.
- Review model lookup hangs and `/fix loop` continuing when no files change.
- Review cancellation failures during startup and retries, and stray reviewer shell commands.
- Review consuming the tool-expansion shortcut.
- Prevented extra readiness alerts after reviews.
- Loop restoring state from the wrong branch, continuing after agent errors, or treating cancelled context summaries as errors.
- Stopped Loop summaries when loops end and Git checks when sessions close.
- Kept pending Memory tasks until explicitly completed or abandoned.
- Preserved Memory log corrections and earlier dream summaries.
- Kept worktree conversations on the selected branch and available to resume.
- `/worktree list` selecting the wrong detached checkout.
- Honored cache exclusions in `.worktreeinclude`.
- Limited Websearch output to 2,000 lines or 50 KB, saving full results separately. (#14)
- Failed Gemini searches with Pi credentials and incomplete Codex results accepted as successful.
- Browser-backed Gemini searches failing on large response headers or returning partial answers without citations.
- Prevented PR details from showing for the wrong branch. (#16)
- Queued Telegram attachments until their originating session is selected.
- Telegram file sending becoming unavailable or staying enabled after switching conversation branches.
- Incorrect `/branch` launch options, conversation handoff, and recovery commands.
- Corrected Usage totals and model attribution, avoided double-counting fork history, and rejected invalid OpenRouter balances.
- Incorrect Ghostty titles and stuck compaction indicators in Ghostty and Telegram.
- Preserved stashed drafts across reloads without overwriting editor text.
- Sandbox retry failures, stale permission prompts, and lost session environment values.
- Missing sandbox status in agent context at startup.
- Stopped reporting sandbox startup errors and unrelated error output as file-access denials.
- Sandboxed file watching failures on macOS.

### Security

- Kept newer sandbox restrictions when approving filesystem requests.
- Blocked shell commands when required sandbox dependencies are missing.

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
