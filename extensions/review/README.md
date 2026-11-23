# Review

`/review` runs multi-focus code reviews. `/fix` applies findings or starts a fresh review. `/triage` classifies GitHub PR feedback. See `/review help` for modes and options.

## Defaults

Create `review.json` in your Pi agent directory (normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR`):

```json
{
  "models": [
    "openai-codex/gpt-6.2-sol:high",
    "anthropic/claude-sonnet-5-5:medium",
    "openrouter/moonshotai/kimi-k3.1-pro:high"
  ],
  "focuses": ["general", "security", "testing"]
}
```

Use model IDs available in Pi’s `/model` picker.

- Both fields are optional: current model and all six focuses are the defaults. Model entries accept `:thinking` suffixes. `focuses`, when present, must be nonempty.
- `models=...` and `focuses=...` override independently. Use `focuses=all` to override a saved subset. Every model runs every selected focus; per-model focus selection is not supported.
- Commands and config also accept `model` and `focus` as aliases. Config values remain arrays; do not specify both names for one setting.
- Defaults are agent-global and reread on each command, without `/reload`. Invalid configuration stops the command. Explicitly supplying both models and focuses bypasses the file.
- Fresh `/fix` reviews use these defaults. Bare `/fix` still reuses the last report, and `/fix loop` keeps its initial defaults. Fix execution, deduplication, and `/triage` are unchanged.

## Lane timing in native sessions and exports

Review records `tau.review.execution.v1` in a `review-execution` custom session entry
after all lanes settle, before consolidation. Reports (including all-failed reports)
also carry the same object in `details.execution`. Native JSONL sessions and Pi HTML
exports retain it. Deduplicate these copies by `roundId`; a lane's stable identity is
`(roundId, laneId)`. A new review/fix-loop round gets a new UUID, even for the same scope.

Each lane retains its requested/status model labels, focus, distinct resolved
`executionModels` (provider/model:thinking subprocess selectors), terminal status
(`completed`, `failed`, `cancelled`) and `elapsedMs`. Elapsed milliseconds use a
monotonic clock from the first actual execution through the lane's terminal cleanup.
They exclude preparation/admission/queue delay and later consolidation, and include
temporary-session setup, subprocess startup, provider/tool calls, retries, retry
backoff, submission repair and cleanup. Retries are one lane sample, not additional
observations. Provider/reasoning fallbacks remain one requested lane: multiple
`executionModels` explicitly identify mixed execution, not a single-model speed sample.

Never-started lanes have `elapsedMs: null`, not zero. A genuinely measured zero is
valid. Historical reports have no execution object; their times remain unavailable.
Use only completed, measured lanes for successful means and disclose timed/completed
coverage. Failed/cancelled records are diagnostic, not successful samples. Cancellation
retains the custom entry without publishing findings. Abrupt process death before
settlement cannot produce a terminal measurement. A fresh slash-command-only Pi
session still follows Pi's normal persistence rules: save the session (for example,
after a normal conversational exchange) before shutdown; the extension does not force
a model call or invent a user/assistant message to flush history.
