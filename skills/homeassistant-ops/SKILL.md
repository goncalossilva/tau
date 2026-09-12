---
name: homeassistant-ops
description: "Operate a Home Assistant instance via the official REST/WebSocket APIs and backups, with safe plan/apply workflows for bulk, reviewable changes."
---

# Home Assistant Ops

Inspect and change Home Assistant through its official APIs and backups, without SSHing into the host. Choose the route that matches the request. Analysis and dry runs do not authorize applying changes.

## Task router

| Task                                                           | Read / use                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect runtime state, registries, or configuration            | [API reference](references/api.md). For a baseline or diff, use [snapshot](references/commands.md#snapshot).                                                                        |
| Analyze naming offline                                         | [Backup analysis](references/commands.md#name-review-from-backup) and [naming conventions](references/id_conventions.md).                                                           |
| Diagnose automation or device behavior                         | [Traces and events](references/commands.md#traces-and-tail-events). Read the playbook's Zigbee section only when relevant.                                                          |
| Plan or apply cleanup, renames, groups, or configuration edits | Read the applicable [ops playbook](references/playbook.md) sections **before any mutation**, then the needed [command](references/commands.md) or [API](references/api.md) details. |
| Recover from a partial or incorrect change                     | Read the playbook's [rollback strategy](references/playbook.md#8-rollback-strategy) and [rollback command](references/commands.md#rollback) before acting.                          |

## Setup

The CLI, [scripts/ha_ops.js](scripts/ha_ops.js), requires Node.js 22+ with built-in `fetch` and `WebSocket`. Commands in the references run from this skill directory. Use an absolute script path when keeping outputs in a separate working folder.

Live commands read credentials only from environment variables. Never pass tokens as command-line arguments or include them in logs or reports:

```bash
export HA_URL="http://<home-assistant-host>:8123"
export HA_TOKEN="<long-lived-access-token>"
node scripts/ha_ops.js --help
```

Help and offline backup analysis do not require live credentials.

## Clarify only what the task needs

Use available configuration and supplied context first. Ask about missing information when it changes the plan:

- HA version and deployment type when API availability or deployment behavior matters.
- ZHA vs Zigbee2MQTT and affected devices for Zigbee work, not unrelated naming or backup analysis.
- YAML-managed vs UI-managed configuration before editing automations, scripts, scenes, or dashboards.
- A recent backup and its coverage before risky or bulk changes.
- The intended outcome (UI clarity, automation correctness, latency) when the goal is ambiguous.

Use the target instance's established naming conventions unless a migration is requested.

## Safety and completion

- Read the applicable [playbook](references/playbook.md) section before live mutations, including direct API calls and rollback. Prefer APIs, or configuration YAML when explicitly YAML-managed. Never edit live `.storage/*` files.
- Plan first. `cleanup` and `update-groups` are dry-run by default. Use `--apply` only for authorized, reviewed changes. Preview rollback with `--dry-run`; `--yes` applies it without confirmation.
- Keep a before-snapshot and a timestamped Markdown log for bulk or risky changes. Record affected entities/configurations and before/after values. Inspect snapshot warnings and retain a suitable backup where broader recovery is needed.
- Before ID migrations, record an `old -> new` map, scan references, and check target-ID conflicts. Renames do **not** propagate to config entry–based group helper memberships. Update groups and other references, then scan again.
- Verify applied changes through current configuration, traces/events as relevant, and an after-snapshot diff. Report warnings, partial application, and unverified behavior rather than treating command completion as proof of success.
- Rollback is **entity-registry-only**, not a full restore. It can restore IDs and selected registry fields for matched existing entities. It does not restore group memberships, automations, scripts, scenes, dashboards, YAML, or device/area registries, recreate missing entities, or remove newly created helpers. Plan separate recovery for those changes.
