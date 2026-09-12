# Home Assistant commands

Run these commands from the skill directory, or resolve `scripts/ha_ops.js` there and use its absolute path. Live commands use `HA_URL` and `HA_TOKEN` from the environment as described in [setup](../SKILL.md#setup). Read the relevant [playbook](playbook.md) section before any mutation. Apply examples assume the plan and scope are authorized.

```bash
node scripts/ha_ops.js --help
node scripts/ha_ops.js cleanup --help
```

Keep outputs in a working folder. Preserve a timestamped Markdown log with before/after values for each change run. Some commands write logs by default; retain output yourself when they do not.

## Cleanup

`cleanup` previews changes unless `--apply` is given. Its default steps reflect a particular instance's naming and sync-automation patterns. Inspect candidates and choose steps that fit the target instance instead of applying those conventions universally.

Available steps:

- `rename-switch-suffix`: change friendly names from "Lights ... Switch" to "Lights ...".
- `create-groups`: create/update switch groups for sync automations. Use `--blueprint-pattern` when needed to select the intended blueprints.
- `prefix-lights-cove`: prefix Lights/Cove friendly names with area.
- `prefix-generic`: prefix friendly names matching repeatable `--pattern "category:regex"` options with area.

Friendly-name cleanup is not a general entity-ID migration command. Use the [rename checklist](playbook.md#renamemigrate-checklist-entity_id-or-helper-id) for ID changes.

```bash
# Preview default steps: rename-switch-suffix,create-groups,prefix-lights-cove
node scripts/ha_ops.js cleanup

# Preview only the intended steps
node scripts/ha_ops.js cleanup --steps rename-switch-suffix,prefix-lights-cove

# Apply those steps after reviewing the plan
node scripts/ha_ops.js cleanup --apply \
  --steps rename-switch-suffix,prefix-lights-cove

# Preview custom patterns. Add --apply only after review and authorization.
node scripts/ha_ops.js cleanup --steps prefix-generic \
  --pattern "Thermometer:^Thermometer" \
  --pattern "Blinds:^Blinds"

# Output proposed changes as JSON (cannot combine with --apply)
node scripts/ha_ops.js cleanup --json
```

## Snapshot

Capture registries and key configurations for comparison. Read warnings to identify missing sections. A snapshot is not a full backup, and the rollback command restores only selected entity-registry data.

```bash
node scripts/ha_ops.js snapshot --out snapshot_before.json

# Skip sections only when they are not needed for this change
node scripts/ha_ops.js snapshot --no-lovelace --no-scenes

# Runtime states are optional and noisy for diffs
node scripts/ha_ops.js snapshot --include-states
```

After applying and verifying changes:

```bash
node scripts/ha_ops.js snapshot --out snapshot_after.json
diff -u snapshot_before.json snapshot_after.json
```

## Find references

Search before and after ID migrations. A mapping file is a JSON object such as `{"switch.old": "switch.new"}`; the finder searches its old-ID keys. Inspect scan warnings and ensure YAML/templates and other relevant configuration sources are covered before calling the scan clean.

```bash
node scripts/ha_ops.js find-references --needle "switch.bedroom_lights"

node scripts/ha_ops.js find-references \
  --map-json rename_map.json --backup-root /path/to/backup \
  --json-out ha_refs.json

# Offline only: no live API scan or credentials needed
node scripts/ha_ops.js find-references \
  --map-json rename_map.json --backup-root /path/to/backup --no-live
```

## Update groups

Entity-ID renames do **not** propagate to config entry–based group helpers. This command uses the rename map to rewrite member lists. Keep the original memberships in the change plan, inspect the proposed updates, and verify persisted memberships afterward. An empty plan alone is not proof that every group is correct.

```bash
# Preview (default, no apply flag)
node scripts/ha_ops.js update-groups --map-json rename_map.json

# Output the plan as JSON
node scripts/ha_ops.js update-groups --map-json rename_map.json --json

# Apply reviewed changes
node scripts/ha_ops.js update-groups --map-json rename_map.json --apply
```

## Traces and tail-events

Use traces to inspect automation/script runs and events to observe affected entities. Stop event subscriptions when the observation is complete, or use `--seconds` to bound them.

```bash
node scripts/ha_ops.js traces --entity-id automation.doorbell_announce
node scripts/ha_ops.js traces --item-id 1757182154251 --run-id '<run-id>'

# Tail state changes, optionally filtering entities
node scripts/ha_ops.js tail-events
node scripts/ha_ops.js tail-events \
  --entity switch.bedroom_lights --entity switch.bedroom_lights_2 --seconds 60

# Include ZHA events when relevant
node scripts/ha_ops.js tail-events \
  --event-type state_changed --event-type zha_event --seconds 60
```

## Name review from backup

Offline naming analysis needs an extracted backup, not a live connection:

```bash
node scripts/ha_ops.js name-review-from-backup --backup-root /path/to/backup
```

Consult the [naming conventions](id_conventions.md) when reviewing the instance.

## Rollback

Read the [rollback strategy](playbook.md#8-rollback-strategy) first. The command restores entity IDs and `name`, `area_id`, `disabled_by`, `hidden_by`, and `icon` for matched existing entity-registry entries. It does not restore other configuration, group memberships, device/area registries, or missing entities, and does not remove newly created helpers.

```bash
# Explicitly preview. Without --dry-run, rollback asks for confirmation.
node scripts/ha_ops.js rollback snapshot_before.json --dry-run

# Apply the reviewed rollback without an interactive confirmation
node scripts/ha_ops.js rollback snapshot_before.json --yes
```

If a run fails partway, inspect logs and current state to identify what actually applied. Fix the cause (network, permissions, ID conflicts), preview recovery, and restore affected configuration and references separately where registry rollback is insufficient. Reconcile current state before rerunning; do not assume a failed run was atomic or that every operation is safely repeatable. Verify recovery with reference scans, behavior checks, and a new snapshot.
