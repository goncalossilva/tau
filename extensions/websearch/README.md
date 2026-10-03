# websearch

Search the web with Gemini, OpenAI, or Claude using Pi credentials or existing browser sessions. The `websearch` tool tries the configured routes and falls back when a search fails.

## Configuration

Optionally create `websearch.json` in your Pi agent directory (normally `~/.pi/agent`):

```json
{
  "routes": ["pi:openai-codex", "pi:anthropic", "pi:gemini", "firefox:gemini", "chromium:gemini"],
  "profiles": {
    "firefox": "default-release",
    "chromium": "Default"
  }
}
```

The routes shown are the default order. Set `routes` to choose which routes to use and their order.

Pi routes use API keys or OAuth credentials from Pi. The `pi:openai-codex` route requires legacy `openai-codex` credentials; Pi's new `/login openai` ChatGPT authentication does not authenticate this route. Browser routes use existing Google sessions for Gemini. Browser profiles are discovered automatically unless pinned with `profiles`.

Browser access supports Firefox and Chromium-family browsers on macOS and Linux. macOS may prompt for Keychain access to decrypt cookies.

## Usage

```js
websearch({ query: "how does Pi compaction work" });
```

## Output

Output is limited to 2,000 lines or 50 KB. Longer results include a path to the full text, including sources, in a temporary file.
