# websearch

Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser sessions.

Current routes:

- `pi:openai-codex`
- `pi:anthropic`
- `pi:gemini`
- `firefox:gemini`
- `firefox:openai-codex`
- `chromium:gemini`
- `chromium:openai-codex`

## Config

Optional config file:

- `~/.pi/agent/websearch.json`

Example:

```json
{
  "routes": [
    "pi:openai-codex",
    "pi:anthropic",
    "pi:gemini",
    "firefox:gemini",
    "firefox:openai-codex",
    "chromium:gemini",
    "chromium:openai-codex"
  ],
  "profiles": {
    "firefox": "default-release",
    "chromium": "Default"
  }
}
```

Defaults:

- default routes match the example above
- if `routes` is set, only those routes are tried, in that order
- Pi routes try the current Pi model first within the matching provider family, then fall back to another available model from that family

`profiles` only applies to browser-backed routes. It pins which local Firefox or Chromium profile to read cookies from.

## Usage

In Pi, the extension exposes:

- tool: `websearch`

Examples:

- `websearch({ query: "latest Todoist release notes" })`
- `websearch({ query: "how does Pi compaction work" })`

## Output limits

Model-facing output, including any truncation notice, is limited to **2,000 lines or 50 KB (51,200 UTF-8 bytes)**, whichever is hit first. Results within both limits are unchanged. Pi's native head truncation keeps complete lines; if the first line alone exceeds the available byte budget, only the notice is returned.

Truncated output includes a path to the full, exact rendered text (including sources) in a temporary file. The directory is private (`0700`) and the file is owner-readable/writable (`0600`). Published files remain available after tool completion and session shutdown, until manually removed or cleaned by the operating system. Failed or cancelled writes are removed. Result details contain truncation counts and the path, not a duplicate of the output. Oversized error messages are also limited, with the full error saved separately.

## Notes

- Pi-backed API routes are preferred, with browser fallbacks after that.
- Browser routes use existing local browser sessions.
- Browser profiles are auto-discovered unless pinned in config.
- Supported Chromium-family browsers are Chromium, Chrome, Brave, and Edge.
- Browser discovery currently supports macOS and Linux, not Windows.
- On macOS, Chromium-based browsers may prompt for Keychain access so cookies can be decrypted.
- If one route fails, the extension falls through to the next one. Cancellation stops fallback attempts.
- Codex searches require a successful completed response; disconnected or incomplete streams are errors, not partial research results.
