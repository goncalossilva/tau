---
name: update-changelog
description: "Update CHANGELOG.md with notable user-facing changes using Keep a Changelog conventions."
---

# Update Changelog

Use [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/) and preserve the repository's established style. Prefer `CHANGELOG.md`, or `CHANGELOG` when that is the existing file.

## Choose the scope

- **Document a specific change:** inspect the relevant diff, issue, or PR and the existing `Unreleased` entries. Update only that change; a complete release-history audit is unnecessary.
- **Audit changes since a release:** identify the requested baseline, or the latest release tag (`git describe --tags --abbrev=0`). If tags are missing or inconsistent, use the newest release section as evidence for the baseline. Inspect `git log <baseline>..HEAD --oneline` and relevant diffs or PRs to find notable omissions.
- **Prepare a release:** move `Unreleased` entries into a versioned section only when the release operation is requested.

A changelog request does not authorize committing, publishing, or creating a release.

## Entry rules

- Include notable user-visible behavior, APIs, flags, bug fixes, and security changes. Exclude internal cleanup, tests, typo-only documentation edits, dependency bumps, and other changes without visible user impact.
- Write concise, concrete entries matching the repository's bullet grammar. Explain user impact rather than copying commit subjects or listing implementation details.
- Link issues or pull requests when useful, but prefer plain prose over lists of references.
- Mark breaking changes with `**Breaking:**` within their change category, and say what breaks.
- Keep upgrade notes brief. Link substantial procedures to a migration guide or release notes.
- Add entries under `Unreleased` unless an explicitly requested release requires moving them. Preserve released content during ordinary updates.
- Merge with an existing entry when it describes the same change rather than adding a duplicate.

## Categories

Create only needed headings. Prefer the six standard types:

| Heading    | Changes                                           |
| ---------- | ------------------------------------------------- |
| Added      | New features or capabilities                      |
| Changed    | Intentional changes to existing behavior          |
| Deprecated | Features scheduled for removal                    |
| Removed    | Removed features                                  |
| Fixed      | Corrections to faulty behavior                    |
| Security   | Vulnerabilities (lead with CVE when one is known) |

Maintain comparison/release links when affected. Preserve the existing link style.
