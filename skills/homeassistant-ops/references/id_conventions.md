# Entity ID naming conventions

Use the target instance's established conventions unless a naming migration is requested. See the [ops playbook](playbook.md#2-naming-and-ids) before changing IDs.

## Basic grammar

`<domain>.<object_id>`

- `domain` is the entity type (`switch`, `sensor`, `cover`, `automation`, ...).
- `object_id` is lowercase, with tokens separated by underscores.

Example object_id shape:

`<location>[_<sub_location>...]_<kind>[_<n>]`

Where:

- `<location>` is usually the area slug (e.g., `bedroom`, `livingroom`, `storageroom`).
- `<kind>` is the thing (`lights`, `cove`, `blind`, `thermometer_temperature`, ...).
- `<n>` is a numeric suffix when there are multiple similar entities.

## Area/location slugs

Example mappings:

- Multi-word areas are usually concatenated: `Living Room` → `livingroom`, `Storage Room` → `storageroom`.
- Apostrophes are dropped: `Leonardo's Room` → `leonardosroom`.
- Floor/range areas use semantic tokens:
  - `Hall -1` → `hallminus1`
  - `Stairs -1-0` → `stairsminus10`
  - `Stairs 0-1` → `stairs01`, `Stairs 1-2` → `stairs12`, `Stairs 2-3` → `stairs23`

## Lights / Cove switch circuits

Switch-controlled lighting circuits use `switch.*` entities:

- Circuit (main): `switch.<location>_lights` or `switch.<location>_cove`
- Additional switches (multi-control): `switch.<location>_lights_2`, `switch.<location>_lights_3`, ...

Within this scheme:

- The “main” physical switch has the suffix-less id.
- Extra physical switches use numeric suffixes.

## Helper groups

This scheme uses `_group` to distinguish helpers from physical entities and reduce naming collisions:

- Switch group helper: `switch.<location>_lights_group` / `switch.<location>_cove_group`

Example helper options, to review against the intended UI and behavior:

- “Hide members” ON (so Overview shows only the group)
- “All entities” OFF
- Area set explicitly to the intended area (usually the area of the primary member)

## Examples

- Multi-switch lighting circuit:
  - Members: `switch.bedroom_lights`, `switch.bedroom_lights_2`, `switch.bedroom_lights_3`
  - Helper: `switch.bedroom_lights_group`
- Shared circuit across areas:
  - `switch.diningroom_livingroom_lights`
- Stairs segment controlling another area:
  - `switch.stairsminus10_hall_lights` (stairs segment is part of the id; “Hall Lights” is the controlled circuit)

## When to rename entity_ids (and when not to)

- Rename early (right after adding a device) if the entity_id is ugly/vendor-ish.
- Avoid renaming stable ids unless you also have a plan to update references.
- Always use a reference finder before/after large id migrations (automations, scripts, scenes, dashboards, templates).
