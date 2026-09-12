# Sentry events and transactions

Run commands from the Sentry skill root. An event is an individual occurrence. Discover can search error events and transactions. Transactions describe performance operations and can carry spans. Neither search is a Logs Explorer query.

## Investigate a time window

Start with the relevant project and a bounded window, then narrow by transaction, level, or correlation tags. Use explicit ISO 8601 timezone offsets or `Z` to avoid an ambiguous incident time.

```bash
# Events in a two-hour window
"./scripts/search-events.js" --org myorg --project backend \
  --start 2025-12-23T15:00:00Z --end 2025-12-23T17:00:00Z

# Errors since a known time
"./scripts/search-events.js" --org myorg --start 2025-12-23T15:00:00Z --level error

# A transaction name
"./scripts/search-events.js" --org myorg --project backend \
  --period 24h --transaction process-incoming-email

# Correlate by custom tag or user
"./scripts/search-events.js" --org myorg --tag thread_id:th_abc123
"./scripts/search-events.js" --org myorg --query "user.email:*@example.com"
```

Retain event IDs and project context, then fetch the occurrences that support the incident timeline. Matching a transaction name does not by itself establish whether a returned record is an error or transaction. Inspect the event details. For application log records, read `references/logs.md` from the skill root.

### Search options

```bash
"./scripts/search-events.js" [options]
```

| Option                    | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `--org, -o <org>`         | Organization slug, required                                                              |
| `--project, -p <project>` | Project slug or numeric ID                                                               |
| `--period, -t <period>`   | Relative range such as `1h`, `24h`, `7d`, or `14d`. Defaults to `24h` without `--start`. |
| `--start <datetime>`      | Absolute start. Takes precedence over `--period`.                                        |
| `--end <datetime>`        | Absolute end with `--start`. If omitted, end is now. Do not use `--end` alone.           |
| `--query, -q <query>`     | Discover search query                                                                    |
| `--transaction <name>`    | Transaction name filter                                                                  |
| `--tag <key:value>`       | Tag filter, repeatable                                                                   |
| `--level <level>`         | Level filter such as `error`, `warning`, or `info`                                       |
| `--limit, -n <n>`         | Maximum results, default 25, capped at 100                                               |
| `--fields <fields>`       | Comma-separated field names                                                              |
| `--json`                  | Raw JSON                                                                                 |

Default fields are `id,title,timestamp,transaction,message`. The request also includes `project.name`. Use `--json` to inspect returned project context or add fields explicitly, for example `--fields "id,title,timestamp,project.name,user.email"`.

Discover query examples:

```text
transaction:process-*     Wildcard transaction match
level:error               Filter by event level
user.email:foo@bar.com     Filter by user
environment:production    Filter by environment
has:stack.filename        Has a stack trace
```

Results are newest first. The script fetches one limited result set without automatic pagination. Narrow a busy time window rather than treating the first page as a complete timeline.

## Fetch an exact event

```bash
"./scripts/fetch-event.js" abc123def456 --org myorg --project backend --breadcrumbs
"./scripts/fetch-event.js" abc123def456 --org myorg --project backend --spans
```

| Option                    | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| `<event-id>`              | Required positional event ID, not an issue ID or trace ID |
| `--org, -o <org>`         | Organization slug, required                               |
| `--project, -p <project>` | Project slug, required                                    |
| `--breadcrumbs, -b`       | All available breadcrumbs instead of the last 30          |
| `--spans`                 | Display transaction spans, up to 50 in formatted output   |
| `--json`                  | Raw event JSON                                            |

Use breadcrumbs for the lead-up to an error and spans for transaction operations. Formatted output is selective, including abbreviated stack traces. Use `--json` when needed for omitted details, and share only relevant, redacted fields. Timestamp rendering differs between search and detail output, so normalize to a stated timezone when assembling a timeline.
