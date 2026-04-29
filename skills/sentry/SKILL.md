---
name: sentry
description: "Fetch and analyze Sentry issues, events, transactions, and logs. Helps agents debug errors, find root causes, and understand what happened at specific times."
---

# Sentry

Access Sentry data via the Sentry API for debugging and investigation.

## Requirements

A Sentry auth token available to the scripts (by default they read `~/.sentryclirc`).

## Quick reference

Run these scripts from this skill directory.

| Task                  | Command                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| Find errors on a date | `"./scripts/search-events.js" --org X --start 2025-12-23T15:00:00 --level error` |
| List open issues      | `"./scripts/list-issues.js" --org X --status unresolved`                         |
| Get issue details     | `"./scripts/fetch-issue.js" <issue-id-or-url> --latest`                          |
| Get event details     | `"./scripts/fetch-event.js" <event-id> --org X --project Y`                      |
| Search logs           | `"./scripts/search-logs.js" --org X --project Y "level:error"`                   |

## Common debugging workflows

### “What went wrong at this time?”

Find events around a specific timestamp:

```bash
# Find all events in a 2-hour window
"./scripts/search-events.js" --org myorg --project backend \
  --start 2025-12-23T15:00:00 --end 2025-12-23T17:00:00

# Filter to just errors
"./scripts/search-events.js" --org myorg --start 2025-12-23T15:00:00 \
  --level error

# Find a specific transaction type
"./scripts/search-events.js" --org myorg --start 2025-12-23T15:00:00 \
  --transaction process-incoming-email
```

### “What errors have occurred recently?”

```bash
# List unresolved errors from last 24 hours
"./scripts/list-issues.js" --org myorg --status unresolved --level error --period 24h

# Find high-frequency issues
"./scripts/list-issues.js" --org myorg --query "times_seen:>50" --sort freq

# Issues affecting users
"./scripts/list-issues.js" --org myorg --query "is:unresolved has:user" --sort user
```

### “Get details about a specific issue/event”

```bash
# Get issue with latest stack trace
"./scripts/fetch-issue.js" 5765604106 --latest
"./scripts/fetch-issue.js" https://sentry.io/organizations/myorg/issues/123/ --latest
"./scripts/fetch-issue.js" MYPROJ-123 --org myorg --latest

# Get specific event with all breadcrumbs
"./scripts/fetch-event.js" abc123def456 --org myorg --project backend --breadcrumbs
```

### “Find events with a specific tag”

```bash
# Find by custom tag (e.g., thread_id, user_id)
"./scripts/search-events.js" --org myorg --tag thread_id:th_abc123

# Find by user email
"./scripts/search-events.js" --org myorg --query "user.email:*@example.com"
```

---

## Fetch issue

```bash
"./scripts/fetch-issue.js" <issue-id-or-url> [options]
```

Get details about a specific issue (grouped error).

**Accepts:**

- Issue ID: `5765604106`
- Issue URL: `https://sentry.io/organizations/sentry/issues/5765604106/`
- New URL format: `https://myorg.sentry.io/issues/5765604106/`
- Short ID: `JAVASCRIPT-ABC` (requires `--org`)

**Options:**

- `--latest` include the latest event with full stack trace
- `--org <org>` organization slug (for short IDs)
- `--json` output raw JSON

---

## Fetch event

```bash
"./scripts/fetch-event.js" <event-id> --org <org> --project <project> [options]
```

**Options:**

- `--org, -o <org>` organization slug (required)
- `--project, -p <project>` project slug (required)
- `--breadcrumbs, -b` show all breadcrumbs (default: last 30)
- `--spans` show span tree for transactions
- `--json` output raw JSON

---

## Search events (Discover)

```bash
"./scripts/search-events.js" [options]
```

**Time range options:**

- `--period, -t <period>` relative time (24h, 7d, 14d)
- `--start <datetime>` start time (ISO 8601: 2025-12-23T15:00:00)
- `--end <datetime>` end time (ISO 8601)

**Filter options:**

- `--org, -o <org>` organization slug (required)
- `--project, -p <project>` project slug or ID
- `--query, -q <query>` Discover search query
- `--transaction <name>` transaction name filter
- `--tag <key:value>` tag filter (repeatable)
- `--level <level>` level filter (error, warning, info)
- `--limit, -n <n>` max results (default: 25, max: 100)
- `--fields <fields>` comma-separated fields to include

**Query syntax (Discover):**

```
transaction:process-*     Wildcard transaction match
level:error               Filter by level
user.email:foo@bar.com    Filter by user
environment:production    Filter by environment
has:stack.filename        Has stack trace
```

---

## List issues

```bash
"./scripts/list-issues.js" [options]
```

**Options:**

- `--org, -o <org>` organization slug (required)
- `--project, -p <project>` project slug (repeatable)
- `--query, -q <query>` issue search query
- `--status <status>` unresolved, resolved, ignored
- `--level <level>` error, warning, info, fatal
- `--period, -t <period>` time period (default: 14d)
- `--limit, -n <n>` max results (default: 25)
- `--sort <sort>` date, new, priority, freq, user
- `--json` output raw JSON

---

## Search logs (Logs Explorer)

```bash
"./scripts/search-logs.js" [query|url] [options]
```

**Options:**

- `--org, -o <org>` organization slug (required unless URL provided)
- `--project, -p <project>` filter by project slug or ID
- `--period, -t <period>` time period (default: 24h)
- `--limit, -n <n>` max results (default: 100, max: 1000)
- `--json` output raw JSON

---

## Tips

1. Start broad (time window + simple query), then drill into a single event/issue.
2. Use `--breadcrumbs` on `fetch-event.js` for the full lead-up to an error.
3. Use `list-issues.js --sort freq` to find recurring problems.
4. Use tags (`request_id`, `user_id`, etc.) to correlate events.
