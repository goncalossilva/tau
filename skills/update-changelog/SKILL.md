---
name: update-changelog
description: "Update CHANGELOG.md with notable user-facing changes using Keep a Changelog conventions."
---

# Update Changelog

Use [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and preserve the repository's established style. Prefer `CHANGELOG.md`, or `CHANGELOG` when that is the existing file.

## Choose the scope

- **Document a specific change:** inspect the relevant diff, issue, or PR and the existing `Unreleased` entries. Update only that change; a complete release-history audit is unnecessary.
- **Audit changes since a release:** identify the requested baseline, or the latest release tag (`git describe --tags --abbrev=0`). If tags are missing or inconsistent, use the newest release section as evidence for the baseline. Inspect `git log <baseline>..HEAD --oneline` and relevant diffs or PRs to find notable omissions.
- **Prepare a release:** move `Unreleased` entries into a versioned section only when the release operation is requested.

A changelog request does not authorize committing, publishing, or creating a release.

## Entry rules

- Include notable user-visible behavior, APIs, flags, bug fixes, and security changes. Exclude internal cleanup, tests, typo-only documentation edits, dependency bumps, and other changes without visible user impact.
- Write concise, concrete, past-tense fragments. Explain the user impact rather than copying commit subjects or listing implementation details.
- Follow the repository's bullet grammar consistently. If it uses `- Added …` or `- Fixed …`, retain those verbs; if it omits them, do the same.
- Use PR numbers or issue IDs when useful. Never include raw commit SHAs or installation instructions.
- Add entries under `Unreleased` unless an explicitly requested release requires moving them. Preserve released content during ordinary updates.
- Merge with an existing entry when it describes the same change rather than adding a duplicate.

## Categories

Create only the headings needed for the entries:

| Heading    | Changes                                     |
| ---------- | ------------------------------------------- |
| Added      | New features or capabilities                |
| Changed    | Changes to existing behavior                |
| Deprecated | Features scheduled for removal              |
| Removed    | Removed features                            |
| Fixed      | Bug fixes                                   |
| Security   | Security fixes and vulnerability mitigation |

Maintain existing comparison/release links when affected. Do not introduce a new link-reference convention into a file that does not use one.
