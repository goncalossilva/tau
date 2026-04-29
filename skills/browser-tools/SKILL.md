---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to a Chromium-based browser (Chromium/Chrome) running on `:9222` with remote debugging enabled.

## Requirements

Chromium or Google Chrome with remote debugging support. The scripts auto-detect common installs; set `BROWSER_TOOLS_BROWSER` or `BROWSER_TOOLS_EXECUTABLE` if auto-detection picks the wrong browser.

## Setup

When hacking on this skill from a source checkout:

```bash
npm install
```

## Tools

Important: Always run commands from this skill directory.

### Start Chromium / Chrome

```bash
"./scripts/browser-start.js"              # Dedicated tool profile
"./scripts/browser-start.js" --profile    # Seed from your browser profile (cookies, logins)
"./scripts/browser-start.js" --watch      # Start background JSONL logging
"./scripts/browser-start.js" --browser chromium
"./scripts/browser-start.js" --browser chrome
```

Launch a browser with remote debugging on `:9222`. Use `--profile` to preserve your authentication state. If a browser is already running on `:9222`, it is reused; launch options like `--browser`, `--executable`, and `--profile` only affect new browser instances.

If the auto-detection picks the wrong browser, set:

- `BROWSER_TOOLS_BROWSER=chromium` (or `chrome`)
- `BROWSER_TOOLS_EXECUTABLE=/absolute/path/to/browser`
- `BROWSER_TOOLS_PROFILE_SRC=/absolute/path/to/profile/dir` (optional; useful with `--executable --profile`)

### Navigate

```bash
"./scripts/browser-nav.js" https://example.com
"./scripts/browser-nav.js" https://example.com --new
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing current tab.

### Evaluate JavaScript

```bash
"./scripts/browser-eval.js" 'document.title'
"./scripts/browser-eval.js" 'document.querySelectorAll("a").length'
"./scripts/browser-eval.js" 'const el = document.querySelector("textarea"); return el?.value'
"./scripts/browser-eval.js" --file ./snippet.js
printf 'return document.title\n' | "./scripts/browser-eval.js" --stdin
```

Execute JavaScript in the active tab. Code runs in async context. Expressions and statement bodies are both supported. Use `return` when passing statements or multi-line code.

### Screenshot

```bash
"./scripts/browser-screenshot.js"
```

Capture current viewport and return temporary file path. Use this to visually inspect page state or verify UI changes.

### Pick Elements

```bash
"./scripts/browser-pick.js" "Click the submit button"
```

Use this when the user wants to select specific DOM elements on the page. This launches an interactive picker: click elements to select them, Cmd/Ctrl+Click for multi-select, Enter to finish.

### Dismiss cookie banners

```bash
"./scripts/browser-dismiss-cookies.js"          # Accept cookies
"./scripts/browser-dismiss-cookies.js" --reject # Reject (where possible)
```

Run after navigation if cookie dialogs interfere with interaction.

### Cookies

```bash
"./scripts/browser-cookies.js"
"./scripts/browser-cookies.js" --format=netscape > cookies.txt
```

Display all cookies for the current tab including domain, path, httpOnly, and secure flags.

The `--format=netscape` option outputs cookies in Netscape format for use with curl/wget (`curl -b cookies.txt`).

### Extract Page Content

```bash
"./scripts/browser-content.js" https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction and Turndown for HTML-to-markdown conversion.

### Background logging (console + errors + network)

Start the watcher:

```bash
"./scripts/browser-watch.js"
```

Or launch the browser with logging enabled:

```bash
"./scripts/browser-start.js" --watch
```

Logs are written as JSONL to a temp directory by default:

- Default: `/tmp/agent-browser-tools/logs/YYYY-MM-DD/<targetId>.jsonl`
- Override: `BROWSER_TOOLS_LOG_ROOT=/some/dir`

Tail the most recent log:

```bash
"./scripts/browser-logs-tail.js"           # dump and exit
"./scripts/browser-logs-tail.js" --follow  # follow
```

Summarize network responses (status codes, failures):

```bash
"./scripts/browser-net-summary.js"
"./scripts/browser-net-summary.js" --file /path/to/log.jsonl
```

### When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution

## Efficiency Guide

### DOM Inspection Over Screenshots

**Don't** lead with screenshots to inspect page state. **Do** prefer parsing the DOM directly first, and use screenshots when you need visual/layout verification:

```javascript
// Get page structure
document.body.innerHTML.slice(0, 5000);

// Find interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map((e) => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className,
}));
```

### Complex Scripts in Single Calls

Use one eval call for multi-step workflows. `browser-eval.js` supports statement bodies, `return`, and `await`:

```javascript
const data = document.querySelector("#target")?.textContent;
const buttons = document.querySelectorAll("button");

buttons[0]?.click();

return {
  data,
  buttonCount: buttons.length,
};
```

### Batch Interactions

**Don't** make separate calls for each click. **Do** batch them:

```javascript
const actions = ["btn1", "btn2", "btn3"];
actions.forEach((id) => document.getElementById(id)?.click());
return "Done";
```

### Typing/Input Sequences

For normal form inputs, set the value and dispatch events in one call:

```javascript
const input = document.querySelector('input[name="email"]');
if (!input) return "Input not found";

input.value = "user@example.com";
input.dispatchEvent(new Event("input", { bubbles: true }));
input.dispatchEvent(new Event("change", { bubbles: true }));

document.querySelector('button[type="submit"]')?.click();
return "Submitted";
```

### Reading App/Game State

Extract structured state in one call:

```javascript
const state = {
  score: document.querySelector(".score")?.textContent,
  status: document.querySelector(".status")?.className,
  items: Array.from(document.querySelectorAll(".item")).map((el) => ({
    text: el.textContent,
    active: el.classList.contains("active"),
  })),
};
return state;
```

### Waiting for Updates

If DOM updates after actions, wait inside the same eval call:

```javascript
document.querySelector("#submit")?.click();
await new Promise((resolve) => setTimeout(resolve, 500));

return {
  status: document.querySelector(".status")?.textContent,
};
```

### Investigate Before Interacting

Always start by understanding the page structure:

```javascript
return {
  title: document.title,
  forms: document.forms.length,
  buttons: document.querySelectorAll("button").length,
  inputs: document.querySelectorAll("input").length,
  mainContent: document.body.innerHTML.slice(0, 3000),
};
```

Then target specific elements based on what you find.
