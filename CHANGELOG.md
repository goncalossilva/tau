# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Updated Oracle to prefer GPT-5.6 Sol and Claude Fable 5 when available.

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
