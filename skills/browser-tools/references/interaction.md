# Browser interaction

Run commands from the browser-tools skill root, not this reference directory. Scripts select the visible, focused page, falling back to the last HTTP(S) page and then the last page. Confirm `location.href` before acting, especially with multiple tabs open.

## Navigate and inspect

```bash
"./scripts/browser-nav.js" https://example.com --new # Preserve unrelated tabs
"./scripts/browser-nav.js" https://example.com       # Reuse the selected tab
"./scripts/browser-eval.js" '({ url: location.href, title: document.title })'
"./scripts/browser-screenshot.js"
```

Navigation waits for `DOMContentLoaded`, not application readiness. Screenshots capture the current viewport and print a temporary image path to open with the image-reading tool.

Inspect what the task needs: DOM for text, controls, and structured state; screenshots for layout, styling, occlusion, and visual verification. Neither must always come first. Identify the intended target and its current state before changing it. Avoid broad HTML dumps when a focused query answers the question.

## Evaluate JavaScript

```bash
"./scripts/browser-eval.js" 'document.title'
"./scripts/browser-eval.js" 'const el = document.querySelector("textarea"); return el?.value'
"./scripts/browser-eval.js" --file ./snippet.js
printf 'return document.title\n' | "./scripts/browser-eval.js" --stdin
```

Code runs in the page's async context. Expressions and statement bodies are supported, including `await`. Use an explicit `return` for statements or multi-line bodies. Objects and arrays print as JSON. The page context is not a Puppeteer `page` object or a Node environment. `./snippet.js` is a file you supply relative to the skill root.

Batch related reads or independent, reversible interactions when no intermediate decision or verification is needed. Separate actions when navigation, validation, asynchronous updates, or consequential effects could change the next step. Do not batch clicks blindly or report success just because a handler was invoked. Apply the user's authorization to submissions and other external changes.

For an ordinary input, setting a value and dispatching events can be done together:

```javascript
const input = document.querySelector('input[name="email"]');
if (!input) throw new Error("Email input not found");
input.value = "user@example.com";
input.dispatchEvent(new Event("input", { bubbles: true }));
input.dispatchEvent(new Event("change", { bubbles: true }));
return { value: input.value };
```

This does not submit the form or prove the app accepted the value. Controlled inputs and custom widgets may need different handling. Synthetic events also do not prove real keyboard or pointer behavior. Inspect the app's response before proceeding and use real user interaction when that is the contract being tested.

## Wait for observable readiness

After an action, wait for the relevant state: a result appears, validation completes, a loading indicator clears, or a known request finishes. Use a bounded wait with an explicit failure, not a fixed sleep followed by an assumed success. For a DOM-driven app, adapt the selector and readiness predicate to the page:

```javascript
return await new Promise((resolve, reject) => {
  const observer = new MutationObserver(check);
  const timeout = setTimeout(() => {
    observer.disconnect();
    reject(new Error("Results did not become ready within 10 seconds"));
  }, 10000);

  function check() {
    const result = document.querySelector('#results[data-state="ready"]');
    if (!result) return;
    observer.disconnect();
    clearTimeout(timeout);
    resolve({ text: result.textContent });
  }

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  check();
});
```

The timeout is a failure bound, not the readiness signal. Tie readiness to the action just performed so stale results cannot satisfy it. If the action navigates, inspect the new document in a subsequent call rather than expecting an in-page eval to survive navigation.

## User-selected elements

```bash
"./scripts/browser-pick.js" "Click the submit button"
```

Use the picker when the user wants to select specific DOM elements. It requires a visible page and an available user, not a headless workflow. A normal click selects and finishes. Cmd/Ctrl+Click collects multiple selections, Enter finishes them, and Escape cancels with `null`. Treat cancellation as cancellation, not a successful empty selection. Let the user make the selection rather than simulating it.

## Readable page content

```bash
"./scripts/browser-content.js" https://example.com
```

This navigates the selected tab and extracts Markdown using Mozilla Readability and Turndown, with a main-content fallback. Use a task-owned tab to preserve user work. It is not a read-only snapshot of the current DOM, and extraction does not guarantee the requested app state finished loading. Verify the final URL and relevant content. For pages that do not need browser interaction, fetch the supplied URL directly instead.
