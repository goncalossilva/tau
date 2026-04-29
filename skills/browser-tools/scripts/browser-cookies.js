#!/usr/bin/env node

import { connectBrowser, getActivePage } from "./utils.js";

const args = process.argv.slice(2);
const format = args.includes("--format=netscape") ? "netscape" : "human";

const browser = await connectBrowser();
const page = await getActivePage(browser);

const cookies = await page.cookies();

if (format === "netscape") {
  for (const cookie of cookies) {
    const includeSubdomains = cookie.domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expiry = cookie.expires > 0 ? Math.floor(cookie.expires) : "0";
    console.log(
      `${cookie.domain}\t${includeSubdomains}\t${cookie.path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`,
    );
  }
} else {
  for (const cookie of cookies) {
    console.log(`${cookie.name}: ${cookie.value}`);
    console.log(`  domain: ${cookie.domain}`);
    console.log(`  path: ${cookie.path}`);
    console.log(`  httpOnly: ${cookie.httpOnly}`);
    console.log(`  secure: ${cookie.secure}`);
    console.log("");
  }
}

await browser.disconnect();
