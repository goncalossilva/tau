---
name: oracle
description: "Get independent reviews, second opinions, or help getting unstuck by asking a strong model from another family with a curated prompt and file set."
---

# Oracle

Use this skill when you want a second opinion from a capable model in a different family than the current session.

The oracle workflow bundles selected files into a standalone prompt, selects an alternate model with `pi --list-models`, and sends the bundle to `pi -p --no-tools`.

Discovery and generation disable extensions, skills, prompt templates, themes, and context files (`AGENTS.md` / `CLAUDE.md`). A fixed system prompt and empty append prompt replace discovered `SYSTEM.md` / `APPEND_SYSTEM.md`. The bundle supplies the task and project context. Pi retains normal authentication and configuration, but has no tools or persisted session. This isolates instructions, not the process. It is not a filesystem sandbox or a read-only guarantee.

## Model selection

The `scripts/oracle` wrapper chooses the strongest known model it can find in the first usable family from this order:

| Current family     | Oracle preference                                     |
| ------------------ | ----------------------------------------------------- |
| OpenAI / Codex     | Claude / Anthropic → Gemini / Google → OpenAI / Codex |
| Claude / Anthropic | OpenAI / Codex → Gemini / Google → Claude / Anthropic |
| Gemini / Google    | OpenAI / Codex → Claude / Anthropic → Gemini / Google |
| Unknown            | Claude / Anthropic → OpenAI / Codex → Gemini / Google |

It prefers models listed in Pi's `enabledModels`, then falls back to the best matching model shown by `pi --list-models`. Override only when needed with `--model provider/model`.

If the current model is not obvious to the script, pass it explicitly with `--current provider/model`. Otherwise it falls back to Pi's default model from `settings.json`.

## Workflow

1. Pick the smallest file set that contains the truth. Avoid secrets by default.
2. Preview selected files before sending.
3. Ask the oracle with a standalone prompt that states the task, constraints, and desired output format.
4. Treat the result as advice, not authority. Reason from first principles before applying recommendations.

## Commands

Run from the repository being reviewed, not this skill directory. Use the installed scripts' absolute paths. In the examples, replace `/absolute/path/to/oracle` with the directory containing this `SKILL.md`.

The wrapper resolves the invocation's Git root once (or uses the invocation directory outside Git) and uses it for model discovery, bundling, and generation. Relative file selectors are rooted there, even when invoked from a repository subdirectory.

```bash
# Preview selected files
/absolute/path/to/oracle/scripts/oracle-bundle --dry-run \
  -p "<task>" --file "src/**" --file "!**/*.test.*"

# Preview the full bundle
/absolute/path/to/oracle/scripts/oracle-bundle \
  -p "<task>" --file "src/**" --file "!**/*.test.*"

# Show which oracle model would be selected
/absolute/path/to/oracle/scripts/oracle --list-models --current openai-codex/gpt-6-astra

# Ask the automatically selected oracle model
/absolute/path/to/oracle/scripts/oracle --current openai-codex/gpt-6-astra \
  -p "<task>" --file "src/**" --file "!**/*.test.*"

# Override the oracle model when the automatic choice is wrong
/absolute/path/to/oracle/scripts/oracle --model anthropic/claude-fable-5-1 \
  -p "<task>" --file "src/**" --file "!**/*.test.*"
```

## Tips

- Prefer a minimal file set over the whole repo.
- If you need diffs reviewed, paste the diff into the prompt or attach the diff file via `--file`.
- Make the prompt completely standalone: include intent, goals, constraints, error text, and whether you want a plan, review, pros/cons, or patch guidance.
- Never include secrets (`.env`, tokens, key files).
- For general code review, ask for feedback on correctness, consistency with existing code, simplicity, maintainability, performance, security, and edge cases.
- Oracle can be slow while it reasons. Allow it several minutes to process.
