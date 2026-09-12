# Sentry issues

Run commands from the Sentry skill root. Issues group related events and summarize recurrence, affected users, and status. Use them to prioritize recurring problems or inspect a known group, not as a substitute for the exact event in an incident window.

## Inspect a known issue

```bash
"./scripts/fetch-issue.js" 5765604106 --latest
"./scripts/fetch-issue.js" https://sentry.io/organizations/myorg/issues/123/ --latest
"./scripts/fetch-issue.js" https://myorg.sentry.io/issues/123/ --latest
"./scripts/fetch-issue.js" MYPROJ-123 --org myorg --latest
```

Accepts a numeric issue ID, either URL format above, or a short ID such as `JAVASCRIPT-ABC`. Short IDs require `--org`.

| Option        | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `--latest`    | Include the latest event, exception stack trace, and recent breadcrumbs |
| `--org <org>` | Organization slug for short IDs                                         |
| `--json`      | Raw issue JSON, or `{ issue, event }` when combined with `--latest`     |

The latest event may be outside the requested incident window. For a specific occurrence, read `references/events.md` from the skill root and search/fetch that event instead. Formatted output abbreviates stack traces, breadcrumbs, tags, and request bodies. Use raw JSON only when the omitted detail is needed, and redact sensitive fields before reporting.

## List and search issues

```bash
# Recent unresolved errors
"./scripts/list-issues.js" --org myorg --project backend \
  --status unresolved --level error --period 24h

# High-frequency issues
"./scripts/list-issues.js" --org myorg --query "times_seen:>50" --sort freq

# Issues affecting users
"./scripts/list-issues.js" --org myorg --query "is:unresolved has:user" --sort user
```

| Option                    | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `--org, -o <org>`         | Organization slug, required                                           |
| `--project, -p <project>` | Project slug or numeric ID, repeatable                                |
| `--query, -q <query>`     | Sentry issue search query                                             |
| `--status <status>`       | `unresolved`, `resolved`, or `ignored`                                |
| `--level <level>`         | `error`, `warning`, `info`, or `fatal`                                |
| `--period, -t <period>`   | Time period, default `14d`                                            |
| `--limit, -n <n>`         | Maximum results, default 25, capped at 100                            |
| `--sort <sort>`           | `date` (last seen), `new` (first seen), `priority`, `freq`, or `user` |
| `--json`                  | Raw JSON                                                              |

Issue search examples:

```text
is:unresolved             Unresolved issues
has:user                  Has user context
user.email:*@example.com  User email pattern
lastSeen:-24h             Seen in the last 24 hours
firstSeen:>=2025-12-23     First seen on or after a date
times_seen:>50            More than 50 occurrences
error.handled:0           Unhandled errors
```

Combine filters in a quoted query and narrow by project when known. This script returns one limited result set and does not paginate automatically. Record the scope and limit before drawing conclusions about prevalence.
