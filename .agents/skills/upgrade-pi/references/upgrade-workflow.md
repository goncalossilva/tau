# Full Pi upgrade workflow

Use this workflow for a distribution-wide audit or upgrade. Run commands from the Tau repository. Resolve script paths from the skill directory if it lives elsewhere.

## 1. Establish the starting version and target

Read repository instructions, `git status --short --branch`, root and workspace manifests, and recent Pi upgrade commits and changelog entries. Identify the root `@earendil-works/pi-*` development dependencies and confirm they use one exact version.

If uncommitted work or differing Pi dependency versions prevent identifying the starting version or separating existing changes from upgrade work, ask which version and changes to use as the starting point. Leave user work in place. Do not stash or revert it.

Use the latest npm version unless the user specifies a target. If the target is not newer than the starting version, report that and stop.

## 2. Prepare the audit workspace

Run one of:

```bash
node .agents/skills/upgrade-pi/scripts/prepare.mjs --repo "$PWD"
node .agents/skills/upgrade-pi/scripts/prepare.mjs --repo "$PWD" --target <version>
```

The script creates a temporary workspace with target Pi packages, complete and per-minor changelog slices, Tau source/API inventories and resource units, and a scratch Tau copy using the target dependencies. It records installation, target CLI help, compilation, and validation of both source packages and independently installed Tau tarballs.

Runtime validation uses the target's public SDK for exact resource counts and zero diagnostics. It separately validates every declared theme against that target installation's published `schemas/theme.schema.json`, including an unsupported-property negative control. Each help, SDK, and CLI smoke probe starts with a fresh HOME, XDG paths, agent directory, and credential-free allowlisted environment before Pi imports. Help disables unrelated resource discovery. Model refreshes and telemetry are disabled. npm downloads, installation, and builds are separate work and retain their normal network/configuration access.

This is configuration isolation, not a security sandbox. The caller's Node environment and executable search path remain trusted bootstrap inputs.

`--list-models` is only a CLI smoke check. It can report startup diagnostics, but its successful exit cannot establish theme or resource validity.

Start with `summary.md`. Read the changelog slices, inventories, compile diagnostics, and package validation log before delegating. A failed scratch compile is audit evidence. Keep its complete diagnostics.

## 3. Audit releases and resources

Keep audit subprocesses ephemeral, read-only, and isolated from installed extensions, skills, prompts, themes, and context files. Run from the Tau repository with absolute workspace input paths:

```bash
pi --no-session \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
  --no-approve --tools read,grep,find,ls \
  -p @<absolute-audit-file> @<absolute-source-context-file> "<standalone prompt>"
```

Save reports under the audit workspace. Use the [audit prompt templates](audit-prompts.md).

### Release pass

Use one agent per intervening minor series. Account for every release and changelog entry as relevant, no-op, or needing verification. Map relevant entries to concrete Tau resources and verify changed contracts against target docs, public declarations, and runtime.

Look beyond compatibility: identify new Pi features or APIs that could improve Tau behavior, simplify implementation, improve ergonomics, or enable genuinely useful capabilities. Connect each opportunity to a Tau resource, upstream API, benefit, and trade-offs or verification needed. Keep optional improvements separate from migration requirements.

### Resource pass

Assign each extension entry point or directory its own agent. Add units for package manifests and distribution behavior, Pi-dependent skills and scripts, themes, and other resources. Account for every resource in the inventory, including explicit no-ops.

Give each resource agent its complete source unit, the shared release findings, and source/API inventories, not the whole repository. Read skill-local references and scripts as part of their owning skill. This pass checks how Tau actually uses Pi, not just what the release notes mention.

## 4. Synthesize and independently review

Verify findings against target changelog entries, referenced docs, public declarations, and runtime. Produce a release/resource coverage summary and a plan separating required migration work, proposed improvements, deferred opportunities, confirmed no-ops, and validation gaps.

Obtain an independent review of the complete upstream changes, coverage, and plan using an available review mechanism or isolated read-only Pi subprocess. A general second opinion does not replace the primary release and resource passes. If independent review is unavailable, report the gap and ask whether to proceed without it.

Reconcile findings and present the reviewed plan. Stop here for an audit-only request. For an authorized upgrade, continue with required migration work. Resolve optional improvements and open scope or behavior decisions before implementing those portions.

## 5. Implement the upgrade

Update the root `@earendil-works/pi-*` development dependencies to one exact target version and regenerate `package-lock.json`. Change workspace dependency ranges only where the target requires it.

Implement required compatibility fixes and approved improvements using public target APIs. Remove compatibility code made obsolete by the target. Keep extensions and skills independently usable, including no skill-to-skill dependencies.

Describe notable user-visible changes in `CHANGELOG.md`. Include each entry in the commit that introduces the behavior it describes.

## 6. Validate against the target runtime

Run repository-required checks:

```bash
npm run format
npm run lint
npm run check
```

Search for removed or deprecated APIs from intervening releases. Extend existing tests and exercise affected runtime behavior directly, especially credential, lifecycle, provider, TUI, or tool changes. Compare dependency audit findings with the baseline when relevant.

Compare Tool Display Mode's background indicator with Pi's native Working presentation, including animation, colors, narrow borders, and lifecycle priority. Shared `Loader` and `CustomEditor` behavior carries through upstream changes, but the border adapter must follow any native presentation changes.

Confirm flags against `target-cli-help.log`. Revalidate the final source and rebuilt tarballs, not only the initial scratch copy. The root dependencies must now be the exact target version. Run the skill-local probe CLI, which creates a separate disposable runtime environment for each invocation:

```bash
(
  set -e
  repo="$PWD"
  probe="$repo/.agents/skills/upgrade-pi/scripts/runtime.mjs"
  validation_dir="$(mktemp -d)"
  trap 'rm -rf "$validation_dir"' EXIT

  npm run package
  for package in tau-coding-agent tau-all-agent; do
    node "$probe" resources --target-root "$repo" --package-dir "$repo/packages/$package"
    node "$probe" smoke --target-root "$repo" --package-dir "$repo/packages/$package"

    archive="$(cd "$repo/dist/$package" && npm pack --silent --pack-destination "$validation_dir")"
    install_dir="$validation_dir/$package"
    mkdir -p "$install_dir"
    printf '{"private":true}\n' > "$install_dir/package.json"
    (cd "$install_dir" && npm install --ignore-scripts --legacy-peer-deps \
      --package-lock=false --no-audit --no-fund "$validation_dir/$archive")

    installed_package="$install_dir/node_modules/$package"
    node "$probe" resources --target-root "$repo" --package-dir "$installed_package"
    node "$probe" smoke --target-root "$repo" --package-dir "$installed_package"
  done
)
```

The `resources` probe must pass exact manifest resource counts, zero diagnostics, and explicit target-schema theme validation with negative controls for all four package loads. The `smoke` probe runs `--list-models` without a model request. Its exit status is not resource-validation evidence.

These checks do not establish interactive lifecycle correctness or native sandbox enforcement. Report untested behavior and any global Pi version mismatch. Do not update the global installation as part of the repository upgrade.

## 7. Review and hand off

Obtain an independent review of the complete migration diff and reconcile its findings. Report the change summary, validation results, and remaining gaps.

If commits were requested, put the dependency bump and inseparable compatibility work in `deps: Upgrade Pi to <version>`. Keep independent improvements in separate scoped commits.

Keep the audit workspace while review or implementation is active. When it is no longer needed, remove only the exact temporary path printed by `prepare.mjs`, never a broad temporary-file glob.
