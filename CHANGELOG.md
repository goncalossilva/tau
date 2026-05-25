# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added runtime environment-variable expansion for path-valued sandbox config.
- Added `$SSH_AUTH_SOCK` to the default sandbox Unix socket allowlist.
- Added a dedicated `/review` security focus.
- Added message queueing during `/review` and `/fix` runs.
- Added `/fix loop` to repeat review/fix cycles until the review is clean or progress stops.

### Changed

- Changed `/fix` to apply findings from partial reviews before reporting failed focus runs.
- Grounded `/review` efficiency findings in locally provable runtime costs.
- Sharpened `/review` prompts for deslopify-style maintainability issues.
- Relaxed sandbox defaults for common developer caches and trusted package/source domains, partially aligning with Claude Code on the web defaults.

### Fixed

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
