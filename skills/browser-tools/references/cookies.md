# Consent dialogs and cookies

Run commands from the browser-tools skill root. These scripts act on the selected tab. Confirm the URL before changing consent or accessing session data.

## Blocking consent dialogs

```bash
"./scripts/browser-dismiss-cookies.js"          # Accept cookies
"./scripts/browser-dismiss-cookies.js" --reject # Reject where possible
```

Use only when a cookie dialog blocks the task, not automatically after every navigation. Honor the user's consent preference. The default accepts cookies, so do not use it as a neutral close operation. If the choice is consequential and unspecified, clarify it rather than granting consent silently.

The script uses heuristic selectors and text matches across the page and likely consent frames. Inspect an ambiguous dialog directly instead of trusting a generic match. Verify the resulting dialog state and consent choice. A reported click is not proof that consent was saved, and “no dialog found” does not prove none exists. Do not add fixed sleeps as a substitute for observing the dialog or its dismissal.

## Inspect or export cookies

```bash
"./scripts/browser-cookies.js"
```

Prints cookies for the current tab, including values, domain, path, httpOnly, and secure flags. This exposes session secrets. Inspect only when needed for the authorized task. Do not paste cookie values into reports, logs, source control, or unrelated services.

`--format=netscape` produces cookie-file output for curl/wget. If the task requires authenticated retrieval outside the browser, keep the export private and temporary:

```bash
(
  umask 077
  cookie_file=$(mktemp) || exit 1
  trap 'rm -f "$cookie_file"' EXIT
  "./scripts/browser-cookies.js" --format=netscape > "$cookie_file" || exit 1
  curl -b "$cookie_file" https://example.com/protected-page
)
```

Replace the URL with the authorized destination. The subshell owns the cookie file until the request completes, then removes it. The export still contains credentials. Do not clear cookies, log out, or reset the user's profile as diagnostic cleanup.
