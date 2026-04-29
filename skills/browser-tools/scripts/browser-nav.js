#!/usr/bin/env node

import { connectBrowser, getActivePage } from "./utils.js";

const url = process.argv[2];
const newTab = process.argv[3] === "--new";

if (!url) {
  console.log("Usage: browser-nav.js <url> [--new]");
  console.log("\nExamples:");
  console.log("  browser-nav.js https://example.com       # Navigate current tab");
  console.log("  browser-nav.js https://example.com --new # Open in new tab");
  process.exit(1);
}

const browser = await connectBrowser();

if (newTab) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log("✓ Opened:", url);
} else {
  const page = await getActivePage(browser);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log("✓ Navigated to:", url);
}

await browser.disconnect();
