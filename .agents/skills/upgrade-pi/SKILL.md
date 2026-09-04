---
name: upgrade-pi
description: Audit and upgrade Tau across Pi releases. Use when bumping Tau's @earendil-works/pi packages, checking extension compatibility, or evaluating useful APIs introduced by newer Pi versions.
compatibility: Requires Node.js 24+, npm, tar, git, and a POSIX environment.
---

# Upgrade Pi

Upgrade Tau deliberately: inspect every intervening Pi release, audit every Tau integration, distinguish compatibility work from optional improvements, and verify the result against the target Pi runtime.

## Guardrails

- Do not substitute a general second-opinion tool for the direct Pi audit fan-out. Use independent review after the primary audit.
- Do not attach the whole repository to every agent. Build a concise source inventory first, then give each agent only its own source unit and shared audit context.
- Do not trust compilation alone. Verify claimed API behavior in target declarations, documentation, and runtime implementation.
- Do not implement opportunities before presenting the complete plan.
- Keep extensions independent. Do not introduce extension-to-extension dependencies or shared helpers merely to remove trivial duplication.
- Do not introduce Tau's first test harness during an upgrade. Use existing tests when present and focused smoke tests otherwise.
- Do not add minimum Pi-version prose to READMEs; package metadata already expresses compatibility.
- Keep user-visible changelog entries in the same commits as their behavior.
- Follow Tau's scoped commit style, for example `deps: Upgrade Pi to <version>`.
- Never update the global Pi installation, commit, push, or release without explicit approval.

## Workflow

### 1. Preflight

Read the repository instructions and inspect, without modifying:

- `git status --short --branch`
- root and workspace package manifests
- recent Pi upgrade commits and changelog entries
- available skills or tools that can provide an independent review

Confirm that the four root Pi development dependencies use one exact version:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

Treat existing working-tree changes and branch divergence as user-owned. If they make the upgrade baseline ambiguous, stop and ask how to proceed.

Use the latest npm version by default. Honor an explicit target version from the user. If the target is not newer than the current version, report that and stop.

### 2. Prepare the audit workspace

Run the preparation script from the Tau repository, resolving the script path from this skill directory:

```bash
node .agents/skills/upgrade-pi/scripts/prepare.mjs --repo "$PWD"
node .agents/skills/upgrade-pi/scripts/prepare.mjs --repo "$PWD" --target <version>
```

The script writes only to a new temporary directory. It creates:

- unpacked target Pi packages;
- exact combined and per-minor changelog slices;
- a Tau source and Pi-API usage inventory;
- resource-unit listings;
- a scratch Tau copy with target dependencies;
- scratch install, target CLI help, and compile results;
- independently installed Tau tarballs with explicit extension, skill, prompt, theme, and diagnostic counts;
- `summary.md`, the entry point for the audit.

A failed scratch compile is evidence, not a failed preparation. Preserve its complete diagnostics for the audit.

Read the generated `summary.md`, changelog slices, source inventory, compile output, and package validation log before spawning agents.

### 3. Run the primary audit

Before launching potentially costly subprocesses, tell the user how many agents you propose and ask before materially expensive fan-out. Keep concurrency modest.

Use Pi's configured defaults for the model and thinking level unless the user asks otherwise or the defaults fail. Keep subprocesses ephemeral and isolated from installed extensions, skills, prompts, themes, and context files. Give them no mutation tools. Run them from the Tau repository and use absolute paths for temporary-workspace inputs so every tool target is unambiguous. A typical invocation is:

```bash
pi --no-session \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
  --no-approve --tools read,grep,find,ls \
  -p @<absolute-audit-file> @<absolute-source-context-file> "<standalone prompt>"
```

Save every report under the temporary audit workspace. Never ask audit agents to edit Tau.

Use the prompt templates in [audit-prompts.md](references/audit-prompts.md).

### Release-series pass

Run one agent per intervening minor series. Each agent must:

- inspect every release entry in its slice;
- classify each entry as relevant, no-op, or requiring verification;
- map relevant changes to concrete Tau resources;
- follow referenced target documentation;
- identify compile-time and runtime compatibility risks;
- record useful new capabilities separately from required migration work.

The combined reports must account for every release in the requested range.

### Resource pass

Run one agent per Tau extension entry point or extension directory. Do not group unrelated extensions merely to reduce agent count. Add separate units for:

- package manifests, packaging script, and distribution behavior;
- Pi-dependent skills or scripts;
- themes and other Pi resources affected by the release reports.

Give every resource agent the shared release findings and source inventory for system-wide awareness, but only its own complete source unit for deep inspection. Require explicit no-op conclusions when no change is needed.

### 4. Synthesize and independently review

Verify agent claims yourself against target changelog entries, complete referenced docs, public declarations, and runtime code. Agents are evidence gatherers, not authorities.

Produce a coverage ledger in the audit workspace and a concise plan for the user:

1. **Required upgrade work**
2. **Proposed improvements**
3. **Deferred opportunities**
4. **Confirmed no-ops**
5. **Validation plan**

Mark unresolved decisions in the relevant section. Then obtain an independent review of both:

- the entire upstream version delta and coverage ledger;
- the proposed choices, including what will be adopted or deferred.

Use an available independent-review mechanism or an isolated read-only Pi subprocess. If no review mechanism is available, tell the user and ask whether to continue without it.

Reconcile the review from first principles. Present the final plan and stop. Do not edit until the user approves it.

### 5. Implement the approved plan

After approval:

1. Update all four root Pi development dependencies to the same exact target version and regenerate `package-lock.json`.
2. Implement required compatibility fixes.
3. Implement only the optional improvements the user approved.
4. Remove obsolete compatibility code rather than retaining speculative fallbacks.
5. Keep each extension self-contained.
6. Preserve existing dependency ranges unless the target Pi release requires a change.
7. Update `CHANGELOG.md` only for the Pi upgrade and notable user-visible behavior. Do not add Pi-version requirements to READMEs.

Avoid unrelated cleanup. If investigation exposes a worthwhile but separate change, report it rather than silently broadening the upgrade.

### 6. Validate against the target runtime

Run the repository's existing checks, normally:

```bash
npm run format
npm run lint
npm run check
```

Also:

- search for APIs removed or deprecated in the intervening releases;
- run focused behavioral smoke tests for runtime-sensitive migrations;
- compare new dependency audit findings with the pre-upgrade baseline when relevant;
- confirm the required flags against the generated `target-cli-help.log`;
- load both Tau packages with the target local Pi CLI and an isolated agent directory.

Use the locally installed target CLI explicitly:

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

Do not treat successful type-checking or package loading as proof of runtime correctness. Exercise credential, lifecycle, provider, TUI, or tool behavior directly when the migration changes it.

If the global `pi --version` differs from the target, report it. Do not update it automatically.

### 7. Final review and commits

Obtain an independent review of the complete migration diff using whatever review mechanism is available. Validate each finding and address only findings within the approved scope.

Show the final diff summary, validation results, remaining live-test needs, and proposed commit breakdown. Pause before committing.

When the user asks to commit:

- put the dependency bump and inseparable compatibility work in `deps: Upgrade Pi to <version>`;
- put independent improvements in separate scoped commits;
- include each changelog entry in the commit that introduces its behavior;
- do not push or release unless separately requested.

Keep the generated audit workspace while review or implementation is active. Once it is no longer needed, remove only the exact temporary path printed by `prepare.mjs`; never clean temporary files with a broad glob.
