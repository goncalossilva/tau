# Review

`/review` runs multi-focus code reviews. Saved reviews and HTML exports include execution time for each model and focus. `/fix` applies findings or starts a fresh review. `/triage` classifies GitHub PR feedback. See `/review help` for modes and options.

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
