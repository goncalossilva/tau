#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
let useProfile = false;
let startWatch = false;
let browserChoice = "auto"; // auto|chromium|chrome
let executableOverride = undefined;
let profileSrcOverride = undefined;

const usage = () => {
  console.log(
    "Usage: browser-start.js [--profile] [--watch] [--browser <chromium|chrome>] [--executable <path>]",
  );
  console.log("\nOptions:");
  console.log("  --profile              Copy your browser profile (cookies, logins)");
  console.log("  --watch                Start browser-watch.js in the background (JSONL logs)");
  console.log("  --browser <name>       Select browser: chromium, chrome (default: auto)");
  console.log("  --executable <path>    Explicit browser executable path");
  console.log("\nEnv:");
  console.log("  BROWSER_TOOLS_BROWSER  chromium|chrome (overrides auto)");
  console.log("  BROWSER_TOOLS_EXECUTABLE  Explicit executable path (overrides auto)");
  console.log("  BROWSER_TOOLS_PROFILE_SRC  Profile directory to rsync from (overrides auto)");
  console.log(
    "  BROWSER_TOOLS_LOG_ROOT  Directory for browser-watch logs (defaults to /tmp/agent-browser-tools/logs)",
  );
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--profile") {
    useProfile = true;
  } else if (arg === "--watch") {
    startWatch = true;
  } else if (arg === "--browser") {
    browserChoice = args[++i] ?? "";
  } else if (arg.startsWith("--browser=")) {
    browserChoice = arg.split("=", 2)[1] ?? "";
  } else if (arg === "--executable") {
    executableOverride = args[++i];
  } else if (arg.startsWith("--executable=")) {
    executableOverride = arg.split("=", 2)[1];
  } else {
    usage();
    process.exit(1);
  }
}

browserChoice = process.env.BROWSER_TOOLS_BROWSER || browserChoice;
executableOverride = process.env.BROWSER_TOOLS_EXECUTABLE || executableOverride;
profileSrcOverride = process.env.BROWSER_TOOLS_PROFILE_SRC || profileSrcOverride;

if (!["auto", "chromium", "chrome"].includes(browserChoice)) {
  usage();
  process.exit(1);
}

const SCRAPING_DIR = `${process.env.HOME}/.cache/browser-tools`;

const startWatcher = () => {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const watcherPath = join(scriptDir, "browser-watch.js");
  spawn(process.execPath, [watcherPath], { detached: true, stdio: "ignore" }).unref();
};

const connectToRunningBrowser = async () => {
  try {
    return await puppeteer.connect({
      browserURL: "http://127.0.0.1:9222",
      defaultViewport: null,
    });
  } catch {
    return null;
  }
};

const runningBrowser = await connectToRunningBrowser();
if (runningBrowser) {
  await runningBrowser.disconnect();
  if (startWatch) startWatcher();
  console.log(`✓ Browser already running on :9222${startWatch ? " (watch enabled)" : ""}`);
  process.exit(0);
}

const findExecutable = (candidates) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes("/")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const found = execSync(`command -v "${candidate}"`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (found) return found;
    } catch {}
  }
  return null;
};

const getDefaultProfileSrc = (kind) =>
  kind === "chrome"
    ? process.platform === "darwin"
      ? `${process.env.HOME}/Library/Application Support/Google/Chrome/`
      : `${process.env.HOME}/.config/google-chrome/`
    : process.platform === "darwin"
      ? `${process.env.HOME}/Library/Application Support/Chromium/`
      : `${process.env.HOME}/.config/chromium/`;

const buildBrowserConfig = ({ label, candidates, profileSrc }) => ({
  label,
  candidates,
  executable: findExecutable(candidates),
  profileSrc,
});

const getBrowserSelection = () => {
  if (executableOverride) {
    const label =
      browserChoice === "chrome" ? "Chrome" : browserChoice === "chromium" ? "Chromium" : "Browser";

    return {
      selected: buildBrowserConfig({
        label,
        candidates: [executableOverride],
        profileSrc:
          profileSrcOverride ||
          (browserChoice === "auto" ? null : getDefaultProfileSrc(browserChoice)),
      }),
    };
  }

  const chromium = buildBrowserConfig({
    label: "Chromium",
    candidates:
      process.platform === "darwin"
        ? [
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            `${process.env.HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`,
          ]
        : ["chromium", "chromium-browser"],
    profileSrc: profileSrcOverride || getDefaultProfileSrc("chromium"),
  });

  const chrome = buildBrowserConfig({
    label: "Chrome",
    candidates:
      process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
          ]
        : ["google-chrome", "google-chrome-stable", "chrome"],
    profileSrc: profileSrcOverride || getDefaultProfileSrc("chrome"),
  });

  return {
    selected:
      browserChoice === "chromium"
        ? chromium
        : browserChoice === "chrome"
          ? chrome
          : chromium.executable
            ? chromium
            : chrome,
    all: { chromium, chrome },
  };
};

const printMissingBrowserError = ({ selected, all }) => {
  if (executableOverride) {
    console.error(`✗ ${selected.label} executable not found: ${executableOverride}`);
    console.error("  Pass a valid path or command via --executable or BROWSER_TOOLS_EXECUTABLE.");
    return;
  }

  if (browserChoice === "auto" && all) {
    console.error("✗ No Chromium or Chrome executable found.");
    console.error(`  Chromium checked: ${all.chromium.candidates.join(", ")}`);
    console.error(`  Chrome checked: ${all.chrome.candidates.join(", ")}`);
    console.error("  Install one of them or pass --executable <path>.");
    return;
  }

  console.error(`✗ ${selected.label} executable not found.`);
  console.error(`  Checked: ${selected.candidates.join(", ")}`);
  console.error("  Install it, use --browser auto, or pass --executable <path>.");
};

const browserSelection = getBrowserSelection();
const browserConfig = browserSelection.selected;
if (!browserConfig.executable) {
  printMissingBrowserError(browserSelection);
  process.exit(1);
}

// Setup profile directory
execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });

// Remove SingletonLock to allow new instance
try {
  execSync(
    `rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`,
    { stdio: "ignore" },
  );
} catch {}

if (useProfile) {
  if (!browserConfig.profileSrc) {
    console.error("✗ Cannot infer a profile directory for --executable in auto mode.");
    console.error("  Also pass --browser <chromium|chrome> or set BROWSER_TOOLS_PROFILE_SRC.");
    process.exit(1);
  }

  console.log("Syncing profile...");
  try {
    execSync(
      `rsync -a --delete \
			--exclude='SingletonLock' \
			--exclude='SingletonSocket' \
			--exclude='SingletonCookie' \
			--exclude='*/Sessions/*' \
			--exclude='*/Current Session' \
			--exclude='*/Current Tabs' \
			--exclude='*/Last Session' \
			--exclude='*/Last Tabs' \
			"${browserConfig.profileSrc}" "${SCRAPING_DIR}/"`,
      { stdio: "pipe" },
    );
  } catch {
    console.error(`✗ Failed to sync profile from: ${browserConfig.profileSrc}`);
    process.exit(1);
  }
}

// Start browser with flags to force new instance
spawn(
  browserConfig.executable,
  [
    "--remote-debugging-port=9222",
    `--user-data-dir=${SCRAPING_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  { detached: true, stdio: "ignore" },
).unref();

// Wait for the browser to be ready
let connected = false;
for (let i = 0; i < 30; i++) {
  try {
    const browser = await puppeteer.connect({
      browserURL: "http://127.0.0.1:9222",
      defaultViewport: null,
    });
    await browser.disconnect();
    connected = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (!connected) {
  console.error("✗ Failed to connect to browser");
  process.exit(1);
}

if (startWatch) startWatcher();

console.log(
  `✓ ${browserConfig.label} started on :9222${useProfile ? " with your profile" : ""}${startWatch ? " (watch enabled)" : ""}`,
);
