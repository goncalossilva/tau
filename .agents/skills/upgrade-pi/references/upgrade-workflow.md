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

The script creates a temporary workspace with target Pi packages, complete and per-minor changelog slices, Tau source/API inventories and resource units, and a scratch Tau copy using the target dependencies. It records install, target CLI help, compile, and independently installed Tau tarball validation results, including resource and diagnostic counts for both packages.

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

Confirm flags against `target-cli-help.log`. In addition to validating both generated tarballs, load both source packages with the local target CLI and an isolated agent directory:

```bash
(
  agent_dir="$(mktemp -d)"
  trap 'rm -rf "$agent_dir"' EXIT

  PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 \
    ./node_modules/.bin/pi \
    --approve -e ./packages/tau-coding-agent --list-models

  PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 \
    ./node_modules/.bin/pi \
    --approve -e ./packages/tau-all-agent --list-models
)
```

Package loading does not establish runtime correctness. Report untested behavior and any global Pi version mismatch. Do not update the global installation as part of the repository upgrade.

## 7. Review and hand off

Obtain an independent review of the complete migration diff and reconcile its findings. Report the change summary, validation results, and remaining gaps.

If commits were requested, put the dependency bump and inseparable compatibility work in `deps: Upgrade Pi to <version>`. Keep independent improvements in separate scoped commits.

Keep the audit workspace while review or implementation is active. When it is no longer needed, remove only the exact temporary path printed by `prepare.mjs`, never a broad temporary-file glob.
