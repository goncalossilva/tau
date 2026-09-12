# Sentry logs

Run commands from the Sentry skill root. Logs Explorer records are a separate dataset from Discover events and grouped issues. Event breadcrumbs are not a replacement for searching application logs.

## Search logs or use a Logs Explorer URL

```bash
"./scripts/search-logs.js" "level:error" --org myorg --project backend
"./scripts/search-logs.js" "message:*timeout*" --org myorg --period 7d
"./scripts/search-logs.js" "trace:abc123" --org myorg --project backend
"./scripts/search-logs.js" "https://myorg.sentry.io/explore/logs/?project=123&statsPeriod=7d"
```

Quote queries and URLs so the shell does not interpret wildcards or `&`. URLs can use `https://myorg.sentry.io/explore/logs/` or `https://sentry.io/organizations/myorg/explore/logs/`.

The script extracts organization, the first `project` parameter, `statsPeriod`, and `logsQuery` from a URL. It does not preserve every UI filter, absolute `start`/`end`, or multiple project selections. Put explicit option overrides after the URL and check the resulting scope before relying on it.

### Options

```bash
"./scripts/search-logs.js" [query|url] [options]
```

| Option                    | Meaning                                                 |
| ------------------------- | ------------------------------------------------------- |
| `--org, -o <org>`         | Organization slug, required unless extracted from a URL |
| `--project, -p <project>` | Project slug or ID, added as a `project:` query filter  |
| `--period, -t <period>`   | Relative time range, default `24h`                      |
| `--limit, -n <n>`         | Maximum results, default 100, capped at 1000            |
| `--json`                  | Raw JSON                                                |

There are no `--start`, `--end`, or `--query` options on this script. Supply the query positionally. For an incident at a specific time, choose a relative period that includes it and verify returned timestamps. If this cannot represent the required scope, report the limitation instead of silently treating a different time range as equivalent.

Query examples supported by the script's help:

```text
level:error                     Log severity
message:*timeout*               Message text
trace:abc123                    Trace ID
project:backend                 Project filter
level:error message:*failed*    Combined filters
```

Results are newest first and contain `sentry.item_id`, `trace`, `sentry.severity`, `timestamp`, and `message`. Formatted output shows timestamp, severity, message, and trace when present. Use `--json` for the returned item ID and structured fields.

The script fetches one limited result set, without automatic pagination. Narrow the query or period to investigate busy streams. Correlate traces and timestamps with events as needed by reading `references/events.md` from the skill root. Empty logs do not rule out an error event, an issue, or missing log instrumentation.
