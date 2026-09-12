# Working on Tau

Tau is a Pi distribution, maintained as a private npm workspace. Edit source resources and `packages/*` manifests, not generated `dist/` output. This guide is for developing Tau; it is not shipped as user agent configuration.

## Extension development

- Keep each extension self-contained: one `extensions/<name>.ts` or an `extensions/<name>/` directory with local helpers. No cross-imports or shared production helpers between extensions. Optional integrations should use events, not require another extension to be installed.
- Use public APIs from the pinned Pi version. Prefer native session, tool, provider, and TUI facilities over recreating them. Preserve their queue, execution, authentication, and configuration semantics when composing or wrapping them; surface API gaps rather than reaching into private internals.
- Keep mutable extension/session state inside the factory, not module globals. Restore branch-specific state from the selected session branch, and handle reload, resume, and session changes deliberately.
- Own asynchronous work, timers, dialogs, subprocesses, and temporary files through completion or cancellation. Await work before cleaning up its resources. Match cancellation to the operation's lifetime; a turn-scoped signal or stale-result guard is not lifetime cleanup.
- Preserve user-owned drafts, session history, Git indexes, and working files. Make persistence explicit where recovery depends on it. Validate configuration, model responses, and external data at boundaries; distinguish errors and cancellation from successful empty results. Never silently weaken security guarantees.
- Resolve project work against the owning session's cwd and agent configuration through `getAgentDir()`, not hardcoded home paths. Respect interactive/headless capabilities; do not wait for unavailable UI input. macOS and Linux are the supported targets, not Windows/PowerShell.
- When adding or removing resources, update the relevant package manifests and README listings. Keep `CHANGELOG.md` for notable user-visible changes, not tests, cleanup, or minor edge cases.

## Testing

Run `npm test` for the suite or `npm test -- <extension>` for one extension. Node test options can follow, for example `--test-name-pattern=reload`. Tests use `node:test`, `node:assert/strict`, and the existing TypeScript compiler. `npm run check` includes the suite.

Run the required checks and fix in-scope issues during implementation. Report but defer unrelated issues.

### What to test

- Prefer a few high-signal workflows. Choose priorities according to each extension's purpose, not coverage percentages or test counts. Every test should protect important behavior or a realistic failure against its maintenance cost.
- Assert observable results, visible output, persisted state, and important invariants—not private fields, helper calls, registration order, or implementation structure.
- Prefer parameterization when cases share setup, actions, and assertions. Keep unrelated workflows separate.
- Verify exact bytes when they are the content-preservation or protocol contract, not for incidental prose, colors, or whole-screen snapshots.
- Prefer playful fixture text without obscuring the behavior or meaningful edge cases.

### Integration boundaries

Use real files, disposable Git repositories, and public Pi APIs. Choose the level that best verifies the contract, including the full interactive application when appropriate. Do not expose private production helpers or add test-only production branches.

Replace only necessary external, nondeterministic, or unsafe boundaries with scripted replies, local services, or narrow UI adapters. Keep parsing and orchestration real, reject unexpected external work, and state what the test does not prove. A substituted integration is not end-to-end coverage.

### Organization

Keep tests outside packaged `extensions/`: use `tests/<extension>.test.ts`, or `tests/<extension>/` when multiple files are warranted. Each extension owns its scenarios and domain fixtures.

Keep files top-down: suite and fixture state, setup/cleanup hooks, behavior tests, then local helpers. Use `describe`, `beforeEach`, and `afterEach` to make structure and ownership clear, with a blank line between lifecycle hooks. Give nontrivial helpers a one- or two-sentence doc explaining their purpose and boundaries; skip obvious comments on trivial helpers.

Small shared helpers belong in `tests/helpers/` for genuinely repeated setup using real APIs—not a simulated Pi host or configurable testing framework. Keep the workflow and assertions visible in the test.

### Isolation and reliability

- Use the test runner, which provides disposable home/config directories, no inherited credentials, and isolated build output. Each test still owns fresh state and must run independently.
- Stay offline: no live accounts, paid calls, personal state, real notifications, or terminal launches. Disable unrelated resource discovery and model refresh. Never mutate the source checkout as a fixture or inherit personal Git configuration.
- Set import-time paths before loading affected extensions. Restore overrides and mocks, await shutdown, and remove fixtures even on failure. Do not swallow extension errors.
- Synchronize on completion signals, not arbitrary sleeps or retry-until-green loops. Use controlled clocks when dates or timing are the contract; deadlines are safety nets, not assertions.
- Report platform limitations and capability skips honestly. Retain and report reproducers for product bugs; do not weaken assertions, bless defective output, or permanently skip cases to make the suite pass. Keep behavior fixes separately reviewable.

## Validation

Run `npm run format`, `npm run lint`, and `npm run check` before handing off changes. The last command checks compilation, tests, and packaging; it does not establish untested live-service or platform behavior.
