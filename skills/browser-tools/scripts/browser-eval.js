#!/usr/bin/env node

import fs from "node:fs";

import { connectBrowser, getActivePage, printResult } from "./utils.js";

const args = process.argv.slice(2);

const usage = () => {
  console.log("Usage: browser-eval.js <code>");
  console.log("       browser-eval.js --file <path>");
  console.log("       browser-eval.js --stdin");
  console.log("\nExamples:");
  console.log('  browser-eval.js "document.title"');
  console.log(
    "  browser-eval.js \"const el = document.querySelector('textarea'); return el?.value\"",
  );
  console.log("  browser-eval.js --file ./snippet.js");
  console.log("  printf 'return document.title\\n' | browser-eval.js --stdin");
};

const readCode = () => {
  if (args[0] === "--stdin") {
    return { kind: "stdin", source: fs.readFileSync(0, "utf8") };
  }

  if (args[0] === "--file") {
    const filePath = args[1];
    if (!filePath) {
      usage();
      process.exit(1);
    }
    return { kind: "file", source: fs.readFileSync(filePath, "utf8") };
  }

  const fileArg = args.find((arg) => arg.startsWith("--file="));
  if (fileArg) {
    return {
      kind: "file",
      source: fs.readFileSync(fileArg.slice("--file=".length), "utf8"),
    };
  }

  return { kind: "argv", source: args.join(" ") };
};

const normalizeCode = ({ kind, source }) => {
  const trimmed = source.trim();
  return kind === "argv" ? trimmed.replace(/\\!/g, "!") : trimmed;
};

const code = normalizeCode(readCode());
if (!code) {
  usage();
  process.exit(1);
}

const browser = await connectBrowser();
const page = await getActivePage(browser);

const result = await page.evaluate(async (source) => {
  const AsyncFunction = (async () => {}).constructor;

  try {
    return await new AsyncFunction(`return (${source})`)();
  } catch (error) {
    if (error?.name !== "SyntaxError") throw error;
  }

  return new AsyncFunction(source)();
}, code);

printResult(result);

await browser.disconnect();
