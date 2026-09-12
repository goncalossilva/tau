---
name: github-pull-request
description: "Create and steward GitHub PRs. Use when opening a PR, monitoring CI, handling review feedback, resolving conflicts, or getting a PR ready to merge."
---

# GitHub Pull Request

Create or steward a GitHub pull request through CI and review. Once requested, continue routine stewardship under the checkpoints below. Repository instructions and explicit user direction take precedence. Requests for copy, analysis, a proposal, or status-only monitoring do not authorize commits, pushes, PR creation, or publishing metadata changes.

## Task router

| Request                                             | Route                                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open a PR                                           | [Create a PR](references/create.md): discover conventions, audit the branch, create and verify, then steward. Resume an existing open PR for the branch instead of creating a duplicate. |
| Monitor or steward an existing PR                   | [Existing-PR stewardship](references/stewardship.md): start with its live state, current head, CI, and feedback. Do not repeat creation phases or create another PR.                     |
| Analyze status, assess feedback, or draft copy only | Use the relevant reference for context, then return the requested analysis or copy without publishing or changing code/history.                                                          |

## Authorization

“Explicit” means explicitly requested or done manually by the user. Autonomous actions below remain limited to the authorized task. Only clearly identified bots or GitHub Apps count as automated reviewers; otherwise treat feedback as human.

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

For human feedback, investigate and recommend an action, but do not edit, reply, or resolve without explicit direction. Authorization to make a code fix does not itself authorize replying or resolving. For large or uncertain automated findings, assess with the user and leave the feedback untouched.

## Completion, readiness, and merge boundaries

For authorized stewardship, continue until the current-stage readiness criteria are met or a checkpoint/blocker requires user input. A bounded analysis or copy request ends with that requested output, not publication.

Report that a draft appears ready when:

- the branch is mergeable and based correctly
- current-stage checks passed on the current head, with none pending
- current-stage automated reviews are complete, with no unresolved threads
- the title and body describe the final scope

Never infer success from command errors, missing status, or results for an earlier head. Track the new head after every push. Treat live PR metadata as authoritative and preserve user-supplied or approved copy.

Never mark ready automatically. If the user does, continue stewardship for newly triggered checks and reviews. Later invocations resume the current PR. Report when repository approval rules are satisfied. Enable auto-merge or merge only when explicit, using the requested or repository-standard strategy.

After merge, delete the remote PR branch unless another open PR targets it. Do not delete the local branch or update the base branch unless requested.
