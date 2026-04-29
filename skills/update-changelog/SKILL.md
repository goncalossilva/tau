---
name: update-changelog
description: "Update CHANGELOG.md following Keep a Changelog (https://keepachangelog.com/en/1.1.0/)"
---

# Update Changelog (Keep a Changelog)

Update the repository changelog with user-facing changes that landed since the last release.

This skill is **explicitly based on** Keep a Changelog v1.1.0:
https://keepachangelog.com/en/1.1.0/

## Rules (non-negotiable)

- **Do not add installation instructions** to the changelog.
- Only include **notable, user-visible** changes.
- **Never add raw commit SHAs**. Prefer PR numbers (e.g. `#123`) and/or issue IDs.
- Add entries **only under `Unreleased`** (unless you are also cutting a release and moving items into a versioned section).
- Preserve the project’s existing formatting where possible, but align new content to Keep a Changelog.

## File to edit

- Prefer `CHANGELOG.md`.
- If missing, use `CHANGELOG`.

## Step-by-step

### 1) Identify the baseline (last released version)

Pick a baseline tag/version to compare against.

- If the project uses git tags:

```bash
git describe --tags --abbrev=0
```

- If tags are missing/inconsistent, use the newest release section in the changelog as the baseline.

### 2) Collect candidate changes

Gather commits/PRs since the baseline and identify user-facing changes.

```bash
git log <baseline>..HEAD --oneline
```

If you have PR metadata available (e.g., via GitHub), use it to improve wording and include PR numbers.

### 3) Ensure the changelog structure matches Keep a Changelog

At minimum, Keep a Changelog expects:

- A top `Unreleased` section
- Optional subsections under `Unreleased` (and under each release):
  - `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`

If `Unreleased` exists but is missing subsections, create only the ones you need for the new entries.

### 4) Add entries under `Unreleased`

Classify each change into one of the standard headings:

- **Added**: new features
- **Changed**: changes in existing functionality (including behavior changes)
- **Deprecated**: soon-to-be removed features
- **Removed**: removed features
- **Fixed**: bug fixes
- **Security**: vulnerability fixes

Write entries as **consistent bullet points**:

- Start with the category verb (Added/Changed/Deprecated/Removed/Fixed/Security) _only via the section heading_, not inside each bullet.
- Each bullet should be a single, past-tense sentence fragment.
- Prefer: `- Added … (#123)` / `- Fixed … (#456)` style (consistent grammar).

### 5) Keep it user-facing

Include:

- visible behavior changes
- new CLI flags/API additions
- bug fixes with clear impact
- security fixes (without leaking sensitive details)

Exclude (unless they change user-visible behavior):

- pure refactors
- internal cleanup
- dependency bumps with no user impact
- typo-only doc edits

### 6) Links (only if the file already uses them)

Keep a Changelog commonly includes link references at the bottom, e.g.:

- `[Unreleased]: <compare link>`
- `[1.2.3]: <compare link>`

If the project already uses these, update them accordingly (don’t introduce link refs if the changelog doesn’t use them).

## Example (consistent Keep a Changelog format)

```markdown
## [Unreleased]

### Added

- Added widget-level caching for faster dashboard loads. (#123)

### Changed

- Changed default retry policy to exponential backoff. (#140)

### Fixed

- Fixed crash when importing a config with empty sections. (#155)

## [1.4.0] - 2026-02-01

### Added

- Added support for exporting reports as CSV. (#110)

### Fixed

- Fixed incorrect timezone handling in scheduled jobs. (#117)
```

## Quality checklist

- Entries are under **`Unreleased`** and categorized correctly.
- Wording is consistent (same tense/style across bullets).
- No installation instructions, no commit SHAs.
- The changelog remains easy to scan and matches the repo’s established conventions.
