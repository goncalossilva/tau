# Browser logging

Run commands from the browser-tools skill root. The watcher records console output, page errors/crashes, navigation, and network request/response/failure metadata as JSONL. It attaches to all existing pages and new pages, not just the active tab. Enable it only when that browser-wide capture is appropriate. URLs and console messages can contain credentials or personal data. Keep logs local and redact sensitive material before sharing.

## Start capture

```bash
"./scripts/browser-watch.js"          # Foreground watcher
"./scripts/browser-start.js" --watch  # Launch/reuse browser and start a detached watcher
```

Prefer the foreground watcher when you need to own its lifetime. Start capture before reproducing the problem and wait for the watcher's startup confirmation. It cannot recover events from before attachment.

Default log paths on macOS/Linux:

- `/tmp/agent-browser-tools/logs/YYYY-MM-DD/<targetId>.jsonl`
- Override the root with `BROWSER_TOOLS_LOG_ROOT=/some/dir` for both capture and readers.
- The date directory is chosen when the watcher starts.

One watcher per log root is tracked by `.watch.pid`. If one already exists, it is reused rather than replaced. Keep track of whether you started it. Stop your foreground watcher with Ctrl+C when done. For a detached watcher, inspect the PID file under that log root and verify it still identifies the watcher you started before sending SIGTERM. Do not stop someone else's watcher or the browser. Retain only logs the task needs and remove your temporary logs when no longer needed.

## Read capture

```bash
"./scripts/browser-logs-tail.js"                          # Dump latest log and exit
"./scripts/browser-logs-tail.js" --file /path/to/log.jsonl
"./scripts/browser-logs-tail.js" --file /path/to/log.jsonl --follow
"./scripts/browser-net-summary.js"
"./scripts/browser-net-summary.js" --file /path/to/log.jsonl
```

Without `--file`, readers choose the most recently modified JSONL file in the newest dated directory. That may belong to another tab. Use `target.attached` or `page.navigated` URLs to identify the task's capture, then pass its file explicitly. `--follow` follows that chosen file, not whichever tab becomes active later. Stop the follow process when finished.

The network summary reports request/response totals, status counts, and up to ten failures. It does not prove application success, include response bodies, or replace examination of relevant log records. Correlate the observed failure with the reproduction and visible app state.
