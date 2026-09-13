# Working on Tau

Tau is a private npm workspace distributing Pi. Edit source resources and `packages/*` manifests, not generated `dist/` output. This guide is for Tau development, not shipped agent configuration.

## Extension development

- Keep extensions self-contained in `extensions/<name>.ts` or `extensions/<name>/`. No cross-imports or shared production helpers. Use events for optional integrations.
- Use public APIs from the pinned Pi version and prefer native facilities. Preserve their queue, execution, authentication, and configuration semantics. Report API gaps rather than reaching into private internals.
- Keep mutable state inside the extension factory. Restore branch-specific state from the selected branch and handle reload, resume, and session changes.
- Scope asynchronous work to its operation, not just a turn. Await completion or cancellation before cleaning up resources.
- Preserve user drafts, session history, Git indexes, and working files. Persist recovery state explicitly.
- Validate configuration, model output, and external data. Distinguish errors and cancellation from successful empty results.
- Use the owning session's cwd for project work and `getAgentDir()` for agent configuration. Respect interactive/headless capabilities. Supported platforms are macOS and Linux.
- Update package manifests and README listings when resources change. Record notable user-visible changes in `CHANGELOG.md`.

## Testing

Run `npm test` for the suite or `npm test -- <extension>` for one extension. Node test options such as `--test-name-pattern=reload` can follow. Tests use `node:test`, `node:assert/strict`, and the existing TypeScript compiler.

When running the full suite (`npm test` or `npm run check`) while sandboxed, use Bash's `requestUnsandboxed: true` and obtain fresh human approval for that invocation. The test controller must run outside Tau's command sandbox so native fixtures can create their own sandboxes. macOS rejects nested Seatbelt sandboxes.

### What to test

- Prefer a few workflows covering important behavior and realistic failures, not coverage or test-count targets.
- Assert observable behavior and state, not implementation details.
- Parameterize cases sharing setup, actions, and assertions. Keep unrelated workflows separate.
- Verify exact bytes for content-preservation or protocol contracts, not incidental prose, colors, or whole-screen snapshots.
- Use playful fixtures without obscuring behavior or edge cases.

### Integration boundaries

Use real files, disposable Git repositories, and public Pi APIs, including the full interactive application when needed. Do not expose private production helpers or add test-only production branches.

Substitute only necessary external, nondeterministic, or unsafe boundaries. Keep parsing and orchestration real, and reject unexpected external work.

### Organization

Keep tests outside packaged `extensions/`: use `tests/<extension>.test.ts` or `tests/<extension>/`. Each extension owns its scenarios and fixtures.

Order files as suite and fixture state, lifecycle hooks, behavior tests, then helpers. Use `describe`, `beforeEach`, and `afterEach`, with a blank line between lifecycle hooks. Briefly document nontrivial helpers' purpose and boundaries.

Put small, genuinely shared setup in `tests/helpers/`. Use real APIs rather than a simulated Pi host or configurable testing framework. Keep workflows and assertions visible in the tests.

### Isolation and reliability

- Use the test runner's isolated home/config directories, credential-free environment, and build output. Each test owns fresh state.
- Keep tests offline and isolated from personal state, notifications, and terminal launches. Disable unrelated resource discovery and model refresh. Never use the source checkout as a fixture or inherit personal Git configuration.
- Set import-time paths before loading extensions. Restore overrides and mocks, await shutdown, and remove fixtures even on failure. Do not swallow extension errors.
- Synchronize on completion signals, not sleeps or retry-until-green loops. Use controlled clocks for timing tests and deadlines only as safety nets.
- Report platform limitations, capability skips, and substituted boundaries. Do not describe substituted integrations as end-to-end coverage.
- Retain and report product-bug reproducers. Do not weaken assertions or skip failures to make tests pass. Keep behavior fixes separately reviewable.

## Validation

Run `npm run format`, `npm run lint`, and `npm run check` before handing off changes. The last command checks compilation, tests, and packaging.
