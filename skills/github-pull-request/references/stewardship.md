# Existing-PR stewardship

Resume the existing PR within the requested scope and the [authorization matrix](../SKILL.md#authorization). Monitoring does not require repeating PR creation, and status-only or analysis requests do not authorize changes or publication.

## Establish live context

- Confirm GitHub CLI availability/authentication and identify the repository and PR. Fetch its current base, head SHA, draft state, metadata, checks, and review state.
- Read applicable repository instructions and CI/review conventions. Consult templates and metadata conventions when changing copy, not as a prerequisite to every status check.
- Track the current head. After each push, monitor the new head rather than carrying forward earlier results.
- Before changing files or history, ensure the PR's actual head branch is checked out. Inspect the working tree, commits, and complete base-to-head diff, including the parent diff for a stacked PR. Preserve unrelated user work and honor changelog, generated-file, test, hook, and signing requirements.
- Use the `git-commit` skill for new commits. Do not rewrite commits merely for cleanup. Never push the default branch.

## CI and conflicts

- Monitor required and pending checks, including automated-review checks.
- Never infer success from command errors, missing status, or an earlier head.
- Rerun clearly flaky or infrastructure-failed checks once, but flag them to the user.
- Before any review feedback arrives, fold a small, clear CI fix into its originating commit when unambiguous. Use `--force-with-lease` if already pushed. Otherwise create a focused fix commit.
- Assess large or unclear failures with the user before acting.
- Resolve trivial base conflicts autonomously. Explain semantic or uncertain conflicts and stop. Changing an existing PR's base, closing it, or reopening it also requires a checkpoint.
- Run focused validation before pushing stewardship code or conflict changes. Use `--force-with-lease` when an authorized branch update requires a force push.

## Automated reviews

Only clearly identified bots or GitHub Apps count as automated; otherwise feedback is human. Request or re-request automated reviewers when the repository workflow calls for it, not human reviewers without explicit authorization.

Inspect review summaries and conversation comments. Fetch every unresolved inline thread, paginating when needed. Classify each automated finding:

- **Valid**: correct, in scope, and worth fixing.
- **Already addressed**: fixed by an existing branch commit.
- **Deferred**: valid but out of scope for this PR.
- **Dismissed**: incorrect, duplicate, or too low-value.
- **Unclear**: needs judgment or more information.

For valid or deferred findings requiring large, architectural, or scope-expanding changes—or any uncertain finding or fix—assess with the user and leave the feedback untouched.

For small, clearly valid findings:

1. Make one focused commit per finding, including any tests.
2. Comments with one root cause may share a commit.
3. Batch commits into one push to limit CI cycles.
4. After pushing, reply briefly inline, link the fixing commit when useful, and resolve the thread.

For remaining already addressed, deferred, or dismissed inline findings, reply briefly with the reason and resolve the thread.

Avoid top-level responses unless strictly needed or expected by the repository. Never replace inline replies with a top-level summary.

## Human reviews

Investigate each human comment and recommend an action, but do not edit, reply, or resolve without explicit direction. When authorized, apply the same focused fix and validation rules. Reply or resolve only when instructions explicitly request it; authorization to implement a fix alone is insufficient.

## Live metadata

Treat the live PR as authoritative. Before editing its title or body, fetch the latest content, make the smallest edit through a file, then update and verify. Never overwrite manual edits from a stale draft. Beyond factual corrections, update copy only for material changes to scope or reviewer context, preserving user-supplied or approved copy. Append nothing to copy supplied exactly.

Use descriptive labels only when commonly used on comparable PRs. Review/readiness or automation-triggering labels and human reviewer requests remain explicit-authorization actions.

## Finish the current stage

Continue authorized stewardship until the [readiness criteria](../SKILL.md#completion-readiness-and-merge-boundaries) are met or a checkpoint/blocker needs user input. Report pending or failed checks, unresolved feedback, or unavailable status honestly. Do not mark ready, enable auto-merge, or merge automatically. After the user marks ready, monitor newly triggered checks and reviews on the current head.
