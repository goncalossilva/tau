import puppeteer from "puppeteer-core";

/**
 * Connect to browser with timeout, exit on failure.
 * @param {number} timeout - Connection timeout in ms (default: 5000)
 * @returns {Promise<Browser>}
 */
export async function connectBrowser(timeout = 5000) {
  const browser = await Promise.race([
    puppeteer.connect({
      browserURL: "http://127.0.0.1:9222",
      defaultViewport: null,
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeout).unref();
    }),
  ]).catch((e) => {
    console.error("✗ Could not connect to browser:", e.message);
    console.error("  Run: browser-start.js");
    process.exit(1);
  });
  return browser;
}

/**
 * Get active page, preferring http/https pages. Exit if none found.
 * @param {Browser} browser
 * @returns {Promise<Page>}
 */
export async function getActivePage(browser) {
  const pages = await browser.pages();
  const page =
    pages.filter((pg) => pg.url().startsWith("http")).at(-1) || pages.at(-1);
  if (!page) {
    console.error("✗ No active tab found");
    process.exit(1);
  }
  return page;
}

/**
 * Print result, using JSON for objects/arrays.
 * @param {any} result
 */
export function printResult(result) {
  if (typeof result === "object" && result !== null) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}
