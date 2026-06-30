import { REVIEW_FOCUS_NAMES, type ReviewFocus } from "./schema.js";

type FocusDefinition = { suffix: string; qualifier: string; context: string };

export const REVIEW_RUBRIC_PROMPT = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed and related to the original intent, not adjacent cleanup or opportunistic refactoring.
5. The author would likely fix if aware of them.
6. Have provable impact. It is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
7. Are clearly not intentional changes by the author.
8. Call out newly added dependencies explicitly and explain why they're needed.
9. Apply system-level thinking; flag changes that increase operational risk or on-call burden.

If an issue is valid and worth tracking but out of scope for the reviewed change, pre-existing, or merely adjacent, report it only as P3 and clearly frame it as follow-up work. Omit unrelated issues that are speculative, vague, or not worth tracking.

## Finding field guidelines

1. Explain why the issue matters and the concrete scenario/environment where it fails.
2. Keep each finding brief, matter-of-fact, and easy to understand.
3. Keep suggestions specific and actionable.
4. Avoid flattery or filler phrases like "Great job...".

## Priority levels

- P0: critical/blocking.
- P1: urgent.
- P2: normal.
- P3: low/nice-to-have/out-of-scope.

If an issue is valid but out of scope for the reviewed change, pre-existing, or merely adjacent, report it as P3 and frame it as follow-up work.`;

export const REVIEW_FOCUSES: Record<ReviewFocus, FocusDefinition> = {
  general: {
    suffix: "",
    qualifier: "",
    context: REVIEW_RUBRIC_PROMPT,
  },
  security: {
    suffix: " specializing in security analysis",
    qualifier: " security",
    context: `Review the changes for potential security issues, such as:
1. Auth and permissions: changed routes, commands, jobs, or data access must preserve required authentication, authorization, tenant isolation, and ownership checks.
2. Untrusted input: SQL or command construction must be parameterized; path, URL, shell, and HTML output must be escaped or encoded for the target context.
3. Filesystem and process boundaries: user-controlled paths and process arguments must not allow traversal, arbitrary file access, command injection, or unsafe environment changes.
4. Server-side fetches: server requests to user-controlled URLs must block localhost, private/link-local IP ranges, cloud metadata endpoints, and internal hostnames, including after DNS resolution and redirects.
5. Redirects and navigation: user-controlled destinations must be same-origin relative paths or explicitly allowlisted origins.
6. Secrets: new logging, errors, telemetry, files, or API responses must not expose tokens, keys, credentials, cookies, or sensitive identifiers.
7. Serialization and parsing: avoid unsafe deserialization, dynamic code execution, prototype pollution, XML external entities, YAML custom object construction, and parser modes that load external resources.
8. Dependencies: newly added dependencies that touch input parsing, networking, auth, crypto, secrets, or code execution need an explicit security reason.
Only flag issues with a concrete exploit path or trust-boundary failure introduced by the reviewed changes.`,
  },
  reuse: {
    suffix: " specializing in reuse analysis",
    qualifier: " reuse",
    context: `Review the changes for potential reuse issues, such as:
1. Search for existing capabilities that could replace newly written code: standard library APIs, native platform features, already-installed dependencies, and existing utilities/helpers. Start with ripgrep-style searches (use the grep tool first), then inspect utility directories, shared modules, and adjacent files.
2. Flag any new function that duplicates existing functionality. Suggest the existing function, API, or feature to use instead.
3. Flag any inline logic that could use an existing capability — hand-rolled standard-library behavior, string manipulation, manual path handling, custom environment checks, ad-hoc type guards, native platform features, and similar patterns are common candidates.
4. Flag new dependencies when the standard library, runtime/platform, or an already-installed dependency provides the same capability or behavior.
5. Flag duplicate modules, thin pass-through wrappers, and manual registries when they duplicate an existing source of truth or local pattern. Prefer deleting, consolidating, or reusing the existing path.`,
  },
  quality: {
    suffix: " specializing in quality analysis",
    qualifier: " quality",
    context: `Review the changes for potential quality issues, such as:
1. Redundant state: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls.
2. Parameter sprawl: adding new parameters to a function instead of generalizing or restructuring existing ones.
3. Copy-paste with slight variation: near-duplicate code blocks that should be unified with a shared abstraction.
4. Leaky abstractions: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries.
5. Stringly-typed code: using raw strings where constants, enums (string unions), or branded types already exist in the codebase.
6. Simplicity/YAGNI: prefer simple, direct solutions over wrappers, abstractions, configuration, options, extensibility, or scaffolding without clear reuse value or explicit need. Prefer deletion or direct code until the second use appears.
7. Shrinkage: flag code that preserves behavior with fewer branches, lines, moving parts, or custom helpers. Do not shrink away input validation at trust boundaries, data-loss error handling, security measures, or accessibility basics.
8. Nested conditionals: ternary chains, deeply nested if/else blocks, or nested switches should be simplified when they obscure distinct cases, duplicate branches, or make error/edge paths easy to miss.
9. Over-defensive code: broad try/catch blocks, fallback/null guard/logging paths, or safe wrappers that are not tied to a real trust boundary or documented failure mode.
10. Fail-fast: favor explicit failures over logging-and-continue patterns that hide errors. Prefer predictable failure modes over silent degradation.
11. Error classification: ensure errors are checked against codes or stable identifiers, never error message strings.
12. Band-aid code: broad any/type-ignore casts, sleeps/timeouts, fake success returns, removed checks, or path mutation that hides a real failure.`,
  },
  testing: {
    suffix: " specializing in test analysis",
    qualifier: " testing",
    context: `Review the changes for potential testing issues, such as:
1. High-signal suite: favor a smaller test suite over exhaustive coverage. Treat tests as carrying maintenance cost. Each test should protect important behavior, a realistic failure mode, or a stable shared contract.
2. Low-value coverage: flag tests added only to cover implementation trivia. Examples include trivial getters/wrappers/constants, exact internal formatting, incidental telemetry/log details or events, timer internals, framework wiring with no behavior of its own, synthetic edge cases with no realistic breakage story, or behavior already covered by a higher-value test.
3. Test bloat: redundant cases, copy-paste matrices, excessive or repeated setup that should use or extract a fixture/helper, gratuitous snapshots, or unparameterized variations that increase maintenance cost without clear regression signal. Suggest consolidation or deletion in these cases.
4. Missing coverage: important behavior that can break without a test failing. Only ask for new tests when you can name the public/user-visible contract, security/privacy boundary, data-loss risk, serialization/wire contract, state transition, permission check, concurrency issue, or prior regression being protected.
5. Weak assertions: tests that do not check observable behavior or invariants.
6. Implementation-coupled tests: tests that assert private details, internal calls, or branch structure instead of behavior. Logs are worth testing only when logging itself is required behavior.
7. Over-mocking: mocks that erase the behavior under test, hide integration behavior, or only prove mocks were called/configured. Prefer real fixtures or recorded external-service interactions when local practice supports them.
8. Flaky patterns: time, random data, network calls, ordering, concurrency, or shared state that is not controlled by fixtures, clocks, cleanup, or deterministic assertions.
Do not ask for tests just because code changed. Only flag a missing test when you can name the important behavior or failure mode that could break. Only flag test removal/simplification when the remaining suite still protects the important intended behavior.`,
  },
  efficiency: {
    suffix: " specializing in efficiency analysis",
    qualifier: " efficiency",
    context: `Review the changes for potential efficiency issues, such as:
1. Unnecessary work: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns.
2. Missed concurrency: independent operations run sequentially when they could run in parallel.
3. Hot-path bloat: new blocking work added to startup or per-request/per-render hot paths.
4. Unnecessary existence checks: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error.
5. Memory: unbounded data structures, missing cleanup, event listener leaks.
6. Overly broad operations: reading entire files when only a portion is needed, loading all items when filtering for one.
7. Accidental indirection: wrapper chains, adapters, or registries that add repeated runtime work without hiding real complexity. Prefer deletion or consolidation when the local code shows the extra work.
8. Backpressure: treat backpressure handling as critical to system stability; flag unbounded queues, missing flow control, or producer-consumer imbalances.`,
  },
};

export const ADDITIONAL_CONTEXT_SECTION_PROMPT = `Additional context from user:
{ADDITIONAL_CONTEXT}
`;

export const REVIEW_PROJECT_GUIDELINES_SECTION_PROMPT = `Project-specific review guidelines:
{PROJECT_GUIDELINES}
`;

export function buildAdditionalContextSection(additionalContext: string | undefined): string {
  const trimmed = additionalContext?.trim();
  if (!trimmed) return "";
  return ADDITIONAL_CONTEXT_SECTION_PROMPT.replace("{ADDITIONAL_CONTEXT}", () => trimmed);
}

export function buildProjectReviewGuidelinesSection(projectGuidelines: string | null): string {
  return projectGuidelines
    ? REVIEW_PROJECT_GUIDELINES_SECTION_PROMPT.replace(
        "{PROJECT_GUIDELINES}",
        () => projectGuidelines,
      )
    : "";
}

export const SUBMIT_TOOL_RETRY_PROMPT = `You did not call {SUBMIT_TOOL} as instructed. You must call that tool exactly once with the final payload. Do not output any text, only call the {SUBMIT_TOOL} when you're done.`;

export const REVIEW_OUTPUT_CONTRACT_PROMPT = `Requirements:
- Never output findings or notes as text or write them to files.
- Always call submit_review exactly once as your final action.
- If no issues are found, pass an empty array of findings to submit_review.
- If uncertain, pass a note to submit_review.`;

export const REVIEW_FOCUS_PROMPT = `You are an expert code reviewer{FOCUS_SUFFIX}.

Objective:
- Find concrete, high-confidence{FOCUS_QUALIFIER} issues introduced by the scoped changes.
- Submit every finding the author would fix if they were made aware of it. Do not stop at the first qualifying finding — continue until you have listed every qualifying finding.
- Do not flag issues the author would not fix. If there is no finding that a person would definitely want to see and fix, prefer outputting no findings.

{SCOPE_INSTRUCTIONS}

{FOCUS_CONTEXT}

Important:
- Submit only issues introduced by the scoped changes, locally provable from the repository or diff, discrete, actionable, and likely worth fixing. Do not report speculative, stylistic, or pre-existing issues.
- This is a read-only review focus. Do not modify files or repository state; do not run mutating commands.

{ADDITIONAL_CONTEXT_SECTION}{PROJECT_GUIDELINES_SECTION}
{OUTPUT_CONTRACT}`;

export const FIX_PROMPT = `You are an expert software engineer applying fixes and improvements from a completed code review.

Use ONLY the findings in the review payload below as your worklist.

You are the decision-maker:

- For each finding that is valid, worthwhile, and within the reviewed change's intent, fix it.
- For each finding that is valid but fixing it would broaden the changeset beyond the reviewed change's goal and scope, defer with a brief explainer.
- For each finding that is invalid, duplicate, too risky, speculative, vague, or not worth tracking, skip it with a brief reason.

Process:

1) Work findings one by one in priority order: P0, P1, P2, P3.
2) For each finding:
   - Validate against current code.
   - If valid, worthwhile, and within scope, implement the minimal correct fix.
   - If valid but outside scope, defer with a short explainer.
   - If invalid, skip with a short reason.
3) Run relevant verification for touched code (targeted tests/checks preferred; avoid unnecessary full-suite runs).
4) Keep changes focused; avoid unrelated refactors, adjacent cleanup, pre-existing issues, and low-value tests.
5) Do not stop at first fix; continue through the whole list.

Output formatting requirements:

- In Verification, prefer plain text. If you cite executed commands, append them after a semicolon and wrap only the command snippet in inline backticks.
- In Notes, use plain prose. Use inline backticks sparingly when they improve clarity, such as for exact identifiers, paths, or command snippets.
- Do not use code fences.
- Do not include the pipe character in any cell text (including inside backticks). Avoid regex alternation patterns like (a|b); rewrite checks without pipes and separate multiple checks with semicolons.
- Decision values must be exactly fixed, deferred, or skipped.

{FIX_ADDITIONAL_CONTEXT_SECTION}Review findings:

{REVIEW_FINDINGS_JSON}

At the end, output only this table (no section headings, no summary):

| # | Location | Finding | Decision | Verification | Notes |
|---|---|---|---|---|---|`;

export const TRIAGE_PROMPT = `You are an expert code reviewer triaging pull request feedback.

Your job is to classify each feedback item into exactly one of these decisions:
- address: the feedback is correct or worthwhile enough to handle in this PR.
- push_back: the feedback seems incorrect, inapplicable, or not worth changing.
- research: you cannot decide yet without external docs, repo conventions, or further verification.
- ignore: the item is non-actionable noise, already-resolved chatter, or has no remaining ask.

Process:
1) Review the scoped PR diff and relevant files before deciding.
2) Use the diff command in the scope instructions as mandatory context.
3) Triage every feedback item exactly once. Do not omit any id.
4) If a review thread contains back-and-forth, focus on the latest remaining ask.
5) Resolved or outdated threads often become ignore, but verify before deciding.
6) This is a read-only triage. Do not modify files or repository state; do not run mutating commands.

{SCOPE_INSTRUCTIONS}

{PROJECT_GUIDELINES_SECTION}

PR feedback payload (authoritative JSON):
{TRIAGE_INPUT_JSON}

Requirements:
- Never output triage items as text or write them to files.
- Always call submit_triage exactly once as your final action.
- Pass exactly one item per input feedback id to submit_triage.
- Keep summary, rationale, and action concise and specific.`;

export const REVIEW_DEDUP_PROMPT = `You are identifying duplicate findings from multiple independent code review passes.

This is a pure deduplication step. Do not inspect the repository, do not use tools, and do not rewrite findings.

Input findings JSON (authoritative):
{REVIEW_FINDINGS_JSON}

Output JSON only, with this exact shape:
{
  "groups": [
    {
      "ids": [1, 2],
      "reason": "same underlying issue"
    }
  ]
}

Requirements:
- Only group findings that are truly duplicates: same underlying issue and materially the same fix.
- Treat wording differences, overlapping line ranges in the same file, and different reviewer terminology as duplicates when the root cause is the same.
- Do not group related but distinct issues with different root causes, impacts, or fixes.
- ids must reference input finding ids.
- Do not include singleton groups. Every group must contain at least two ids.
- Each finding id may appear in at most one group total.
- Input findings are already ordered by review priority. The host will keep the lowest id in each group.
- Keep reason very short.
- If there are no duplicates, return { "groups": [] }.
- Before sending, self-check that JSON.parse(output) would succeed.`;

export const TRIAGE_METADATA_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      title
      body
      baseRefName
      headRefName
      author {
        login
      }
      comments(first: 100) {
        nodes {
          id
          body
          url
          createdAt
          author {
            login
          }
        }
      }
      reviews(first: 100) {
        nodes {
          id
          body
          state
          url
          submittedAt
          author {
            login
          }
        }
      }
    }
  }
}`;

export const TRIAGE_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          comments(first: 100) {
            nodes {
              id
              body
              url
              createdAt
              author {
                login
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

export { REVIEW_FOCUS_NAMES };
