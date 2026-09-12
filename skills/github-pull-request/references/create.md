# Create a PR

Use this route when PR creation is requested, subject to the [authorization matrix](../SKILL.md#authorization). For copy or analysis alone, use only the relevant reading and drafting steps. Do not stage, commit, push, or publish as a side effect.

## Discover conventions

1. Confirm GitHub CLI availability and authentication.
2. Read repository instructions, contribution docs, local PR guidance, and every applicable template.
3. Identify the repository, default and current branches, remote, related issues, and any stacked PR.
4. Inspect recent relevant human-authored PRs for conventions, preferring the user's own when comparably relevant; exclude bots and one-offs.
5. Resume any open PR associated with the current branch through [stewardship](stewardship.md) instead of creating a duplicate.

Repository evidence outranks generic advice. If conventions appear ambiguous, ask before proceeding.

## Audit the branch

1. Fetch the intended base branch.
2. Inspect the working tree, commits, and complete base-to-head diff. Confirm one coherent change free of unrelated, sensitive, temporary, or accidental content.
3. For a stacked PR, verify the exact commits and diff against its parent branch.
4. Check changelog, generated-file, test, commit-hook, and commit-signing requirements.
5. If on the default branch, create a correctly named branch. Otherwise rename it before its initial push when required.
6. Use the `git-commit` skill for new commits. Do not rewrite commits merely for cleanup; base rebases follow the [conflict rules](stewardship.md#ci-and-conflicts).

If the changes belong in separate PRs, stop and explain why.

## Create and verify

- Match the repository's PR title style. For a single commit, consider its title as a starting point.
- Follow local PR instructions and retain required template sections. Use `N/A` when inapplicable unless conventions allow omission.
- Focus the body on what changed, why, the approach, and meaningful trade-offs.
- Omit boilerplate Summary, Testing, Demo, or file-inventory sections unless the repository or change requires them.
- A simple issue reference such as `Closes #123` may be the complete body.
- Preserve user-supplied or approved copy. Append nothing to copy supplied exactly.
- Pass the body through a temporary Markdown file, never inline escaped newlines.
- Apply descriptive labels only when commonly used on comparable PRs. Review/readiness or automation-triggering labels still require explicit authorization.
- Never push the default branch. Push the PR branch and set its upstream.
- Create with an explicit base, head, title, and `--body-file`. Use `--draft` unless requested otherwise.
- Re-fetch the live PR and verify its repository, branches, metadata, draft state, and rendered body. Ensure it has no literal `\n` sequences or stale placeholders.

Continue with [CI and review stewardship](stewardship.md), stopping at the root skill's [readiness and merge checkpoints](../SKILL.md#completion-readiness-and-merge-boundaries).
