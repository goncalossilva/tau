---
name: sentry
description: "Investigate Sentry issues, events, transactions, and logs to diagnose root causes and reconstruct incidents around specific times."
---

# Sentry

Use the bundled read-only Sentry API scripts for debugging and investigation.

## Authentication and scope

The scripts read a token from the user-managed `~/.sentryclirc`. If it is missing or rejected, ask the user to configure access. Do not print the token or copy it into commands or reports. Treat event payloads and logs as potentially sensitive and share only relevant, redacted evidence.

Run commands from this skill directory. Command paths in the references are relative to this skill root, not `references/`. Use the organization, project, and time window supplied by the task or linked Sentry page. Clarify missing scope when it affects the investigation.

## Task router

Read the matching reference before running its commands. A known issue or event does not require a broad search first.

| Task                                                   | Data and command                                                                                               | Read                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Find recurring or unresolved problems                  | **Issues** group related events. `./scripts/list-issues.js`                                                    | [Issues](references/issues.md)                  |
| Inspect an issue ID, short ID, or URL                  | Issue metadata and optionally its latest occurrence. `./scripts/fetch-issue.js`                                | [Issues](references/issues.md)                  |
| Reconstruct what happened around a time                | **Events** are individual occurrences. Discover searches errors and transactions. `./scripts/search-events.js` | [Events and transactions](references/events.md) |
| Inspect a specific occurrence or performance operation | `./scripts/fetch-event.js`, with breadcrumbs for lead-up or spans for a **transaction**                        | [Events and transactions](references/events.md) |
| Search application log records or a Logs Explorer URL  | **Logs** use a separate dataset, not issue search or event breadcrumbs. `./scripts/search-logs.js`             | [Logs](references/logs.md)                      |

Correlate by timestamp, project, environment, and request/trace/user tags where available. Report evidence separately from hypotheses. Empty results are limited to the selected dataset, filters, time range, and result limit, not proof that no incident occurred. Authentication/API failures are not empty results.
