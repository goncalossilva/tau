#!/usr/bin/env node

/**
 * Summarize network activity from browser-watch JSONL logs.
 *
 * Usage:
 *   browser-net-summary.js              # summarize latest log
 *   browser-net-summary.js --file <path>
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TMP = process.platform === "win32" ? tmpdir() : "/tmp";

const LOG_ROOT =
  process.env.BROWSER_TOOLS_LOG_ROOT || join(DEFAULT_TMP, "agent-browser-tools", "logs");

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function findLatestFile() {
  if (!existsSync(LOG_ROOT)) return null;

  const dirs = readdirSync(LOG_ROOT)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .map((name) => join(LOG_ROOT, name))
    .filter((p) => statSafe(p)?.isDirectory())
    .sort();

  if (dirs.length === 0) return null;

  const latestDir = dirs[dirs.length - 1];
  const files = readdirSync(latestDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(latestDir, name))
    .map((p) => ({ path: p, mtime: statSafe(p)?.mtimeMs || 0 }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.path || null;
}

const args = process.argv.slice(2);
let filePath = null;
const fileIdx = args.indexOf("--file");
if (fileIdx !== -1) filePath = args[fileIdx + 1];
if (!filePath) filePath = findLatestFile();

if (!filePath) {
  console.error("✗ No log file found");
  process.exit(1);
}

const statusCounts = new Map();
const failures = [];
let totalResponses = 0;
let totalRequests = 0;

try {
  const data = readFileSync(filePath, "utf8");
  const lines = data.split("\n").filter(Boolean);

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "network.request") {
      totalRequests += 1;
    } else if (entry.type === "network.response") {
      totalResponses += 1;
      const status = String(entry.status ?? "unknown");
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    } else if (entry.type === "network.failure") {
      failures.push({
        requestId: entry.requestId,
        errorText: entry.errorText,
        url: entry.url,
      });
    }
  }
} catch (e) {
  console.error("✗ summary failed:", e.message);
  process.exit(1);
}

console.log(`file: ${filePath}`);
console.log(`requests: ${totalRequests}`);
console.log(`responses: ${totalResponses}`);

const statuses = Array.from(statusCounts.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));
for (const [status, count] of statuses) {
  console.log(`status ${status}: ${count}`);
}

if (failures.length > 0) {
  console.log("failures:");
  for (const failure of failures.slice(0, 10)) {
    console.log(
      `- ${failure.errorText || "unknown"} (${failure.requestId || "?"}) ${failure.url || ""}`.trim(),
    );
  }
  if (failures.length > 10) {
    console.log(`- ... ${failures.length - 10} more`);
  }
}
