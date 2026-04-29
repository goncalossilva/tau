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

- `~/.pi/websearch.json`

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

## Notes

- Pi-backed API routes are preferred, with browser fallbacks after that.
- Browser routes use existing local browser sessions.
- Browser profiles are auto-discovered unless pinned in config.
- Supported Chromium-family browsers are Chromium, Chrome, Brave, and Edge.
- Browser discovery currently supports macOS and Linux, not Windows.
- On macOS, Chromium-based browsers may prompt for Keychain access so cookies can be decrypted.
- If one route fails, the extension falls through to the next one.
