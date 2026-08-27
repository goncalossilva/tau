---
name: github-pull-request
description: "Create and steward GitHub PRs. Use when opening a PR, monitoring CI, handling review feedback, resolving conflicts, or getting a PR ready to merge."
---

# GitHub Pull Request

Use this skill to create or monitor a GitHub pull request through CI and review. Once requested, proceed autonomously through routine stewardship subject to the checkpoints below. Repository instructions and explicit user direction take precedence. Requests for copy, analysis, or a proposal do not authorize a push or PR.

## Authorization

“Explicit” means explicitly requested or done manually by the user.

| Action                                                                                  | Default                                                                       |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Determine the branch, base, title, body, and commonly used descriptive labels           | Autonomous                                                                    |
| Commit, push, and open the PR                                                           | Autonomous once requested; draft by default                                   |
| Make small factual PR metadata updates                                                  | Autonomous, while preserving user edits                                       |
| Monitor CI, pending checks, and automated reviews                                       | Autonomous                                                                    |
| Request or re-request automated reviewers                                               | Autonomous when the repository workflow calls for it                          |
| Rerun clearly flaky or infrastructure-failed checks                                     | Autonomous                                                                    |
| Fix small, confident, in-scope CI or automated-review findings                          | Autonomous                                                                    |
| Reply to and resolve automated findings                                                 | Autonomous when fixed, already addressed, invalid, low-value, or out of scope |
| Resolve trivial conflicts and update the PR branch                                      | Autonomous; use `--force-with-lease` when needed                              |
| Handle findings or changes that are large, uncertain, architectural, or scope-expanding | Checkpoint: assess and wait                                                   |
| Change an existing PR's base, close or reopen it, or resolve nontrivial conflicts       | Checkpoint: explain and wait                                                  |
| Mark ready for review                                                                   | Explicit                                                                      |
| Apply review/readiness or automation-triggering labels                                  | Explicit                                                                      |
| Request human reviewers                                                                 | Explicit                                                                      |
| Address, reply to, or resolve human feedback                                            | Checkpoint: assess and wait                                                   |
| Enable auto-merge or merge                                                              | Explicit                                                                      |
| Delete the merged remote PR branch                                                      | Autonomous when safe                                                          |
| Update the base branch after merge                                                      | Explicit                                                                      |

## Phase 1: Discover conventions

1. Confirm GitHub CLI availability and authentication.
2. Read repository instructions, contribution docs, PR skills or commands, and every applicable template.
3. Identify the repository, default and current branches, remote, related issues, and any stacked PR.
4. Inspect recent relevant human-authored PRs for conventions, preferring the user’s own when comparably relevant; exclude bots and one-offs.
5. Resume any open PR associated with the current branch instead of creating a duplicate.

Repository evidence outranks generic advice; if conventions appear ambiguous, ask before proceeding.

## Phase 2: Audit the branch

1. Fetch the intended base branch.
2. For an existing PR, ensure its head branch is checked out before changing files or history.
3. Inspect the working tree, commits, and complete base-to-head diff; confirm one coherent change free of unrelated, sensitive, temporary, or accidental content.
4. For a stacked PR, verify the exact commits and diff against its parent branch.
5. Check changelog, generated-file, test, and commit-signing requirements.
6. If on the default branch, create a correctly named branch; otherwise rename it before its initial push when required.
7. Use the `git-commit` skill for new commits. Do not rewrite commits merely for cleanup; base rebases follow the conflict rules below.

If the changes belong in separate PRs, stop and explain why.

## Phase 3: Create and verify

- Match the repository's PR title style; for a single commit, consider its title as a starting point.
- Follow local PR instructions and retain required template sections. Use `N/A` when inapplicable unless conventions allow omission.
- Focus the body on what changed, why, the approach, and meaningful trade-offs.
- Omit boilerplate Summary, Testing, Demo, or file-inventory sections unless the repository or change requires them.
- A simple issue reference such as `Closes #123` may be the complete body.
- Preserve user-supplied or approved copy; append nothing to copy supplied exactly.
- Pass the body through a temporary Markdown file, never inline escaped newlines.
- Apply descriptive labels only when commonly used on comparable PRs.
- Never push the default branch. Push the PR branch and set its upstream.
- Create with an explicit base, head, title, and `--body-file`; use `--draft` unless requested otherwise.
- Re-fetch the live PR and verify its repository, branches, metadata, draft state, and rendered body. Ensure it has no literal `\n` sequences or stale placeholders.

## Phase 4: Steward CI and reviews

Track the current head; after each push, monitor the new head.

### CI and conflicts

- Monitor required and pending checks, including automated-review checks.
- Never infer success from command errors, missing status, or an earlier head.
- Rerun clearly flaky or infrastructure-failed checks once, but flag them to the user.
- Before any review feedback arrives, fold a small, clear CI fix into its originating commit when unambiguous; use `--force-with-lease` if already pushed. Otherwise create a focused fix commit.
- Assess large or unclear failures with the user before acting.
- Resolve trivial base conflicts autonomously; explain semantic or uncertain conflicts and stop.
- Run focused validation before pushing stewardship code or conflict changes.

### Automated reviews

Only clearly identified bots or GitHub Apps count as automated; otherwise feedback is human.

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

### Human reviews

Investigate each human comment and recommend an action, but do not edit, reply, or resolve without explicit direction. When authorized, apply the same focused fix and validation rules; reply or resolve only when instructions explicitly request it.

### Live metadata

Treat the live PR as authoritative. Before editing its title or body, fetch the latest content, make the smallest edit through a file, then update and verify. Never overwrite manual edits from a stale draft; beyond factual corrections, update copy only for material changes to scope or reviewer context.

## Phase 5: Stop at readiness and merge checkpoints

Report that a draft appears ready when:

- the branch is mergeable and based correctly
- current-stage checks passed on the current head, with none pending
- current-stage automated reviews are complete, with no unresolved threads
- the title and body describe the final scope

Never mark it ready automatically. If the user does, continue stewardship for newly triggered checks and reviews. Later invocations resume the current PR.

Report when repository approval rules are satisfied. Auto-merge or merge only when explicit, using the requested or repository-standard strategy.

After merge, delete the remote PR branch unless another open PR targets it. Do not delete the local branch or update the base branch unless requested.
