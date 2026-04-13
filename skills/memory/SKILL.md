---
name: memory
description: "Project-local memory with core blocks, wiki, raw artifacts, and manual sleep-based consolidation."
---

# Memory

Use this skill when a repo contains a `.memory/` directory.

## Layout

- `core/` — short, high-signal memory that should stay in immediate context.
- `wiki/` — longer-lived knowledge, reflections, and the current brief.
- `raw/` — large artifacts and media referenced by memory. This folder is gitignored.
- `log.md` — append-only markdown log.
- `.state.json` — local sleep counters and timestamps.

## Core blocks

The four core files are:

- `.memory/core/directives.md` — stable rules, behavioral constraints, tool usage, user preferences.
- `.memory/core/context.md` — codebase knowledge, architecture decisions, known gotchas.
- `.memory/core/focus.md` — current task, active guidance, immediate next steps.
- `.memory/core/pending.md` — unfinished work, TODOs, follow-ups, open questions.

Hard rule: the total line count across all four core files must stay at or below 300.

## Write rules

- If work is left unfinished, update `.memory/core/pending.md`.
- If architecture or behavior changes, update `.memory/core/context.md`.
- If a non-trivial decision or discovery occurs, append to `.memory/log.md`.
- If the user provides a substantial brief, write it to `.memory/wiki/current_brief.md` before acting.
- Keep long-form knowledge in `.memory/wiki/`, not in core.

## Sleep

Sleep is the only consolidation mechanism.

Use sleep to:
- compress and refresh core memory,
- move durable knowledge into `.memory/wiki/reflections/`,
- surface drift against `.memory/wiki/current_brief.md`.

Drift correction happens during sleep, not ad hoc.

If Pi is available, use `/memory sleep` for manual consolidation. Otherwise, follow the same rules manually with normal file tools.
