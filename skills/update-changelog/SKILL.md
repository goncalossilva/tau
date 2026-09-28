---
name: update-changelog
description: "Update CHANGELOG.md with notable user-facing changes using Keep a Changelog conventions."
---

# Update Changelog

Use [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/) and preserve the repository's established style. Prefer `CHANGELOG.md`, or `CHANGELOG` when that is the existing file.

## Choose the scope

- **Document a specific change:** inspect the relevant diff, issue, or PR and the existing `Unreleased` entries. Update only that change, checking its same-release feature history when needed to classify or merge it correctly; a complete release-history audit is unnecessary.
- **Audit changes since a release:** compare the requested baseline, or the latest release tag (`git describe --tags --abbrev=0`), with `HEAD`. For a specified released section, compare its preceding release with that target release instead. If tags are missing or inconsistent, use release sections and history to establish the boundaries. Inspect `git log <baseline>..<target> --oneline` and relevant diffs or PRs.
- **Prepare a release:** move `Unreleased` entries into a versioned section only when the release operation is requested.

During audits and release preparation, reconcile existing entries for duplicates, superseded notes, and misclassification as well as notable omissions.

A changelog request does not authorize committing, publishing, or creating a release.

## Entry rules

- Include notable user-visible behavior, APIs, flags, bug fixes, and security changes. Exclude internal cleanup, tests, typo-only documentation edits, dependency bumps, and other changes without visible user impact.
- Describe net changes since the previous released baseline, not development chronology. Omit regressions introduced and resolved within the same release, including in existing features. Genuine changes to previously released features or integrations still warrant `Changed` or `Fixed` entries.
- Give each feature first shipped in this release one coherent `Added` description in its final form. Fold notable pre-release refinements and fixes into that description or omit them, rather than listing them separately under `Changed` or `Fixed`.
- Write concise, concrete entries matching the repository's bullet grammar. Explain user impact rather than copying commit subjects or listing implementation details. Avoid mechanically repeating section labels such as “Added”, “Fixed”, or “Removed” in bullets; write grammatical descriptions rather than merely deleting those prefixes.
- Link issues or pull requests when useful, but prefer plain prose over lists of references.
- Mark breaking changes with `**Breaking:**` within their change category, and say what breaks.
- Keep upgrade notes brief. Link substantial procedures to a migration guide or release notes.
- Add entries under `Unreleased` unless an explicitly requested release requires moving them or an audit/correction targets a released section. Preserve released content otherwise.
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
