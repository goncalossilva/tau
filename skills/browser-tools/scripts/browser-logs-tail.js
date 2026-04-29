#!/usr/bin/env node

/**
 * Tail browser-watch JSONL logs.
 *
 * Usage:
 *   browser-logs-tail.js                # dump latest log and exit
 *   browser-logs-tail.js --follow       # keep following
 *   browser-logs-tail.js --file <path>  # explicit file
 */

import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
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
const follow = args.includes("--follow");

let filePath = null;
const fileIdx = args.indexOf("--file");
if (fileIdx !== -1) filePath = args[fileIdx + 1];
if (!filePath) filePath = findLatestFile();

if (!filePath) {
  console.error("✗ No log file found");
  process.exit(1);
}

let offset = 0;

function readAll() {
  if (!existsSync(filePath)) return;
  const data = readFileSync(filePath, "utf8");
  if (data.length > 0) process.stdout.write(data);
}

function readNew() {
  if (!existsSync(filePath)) return;
  const data = readFileSync(filePath, "utf8");
  if (data.length <= offset) return;
  const chunk = data.slice(offset);
  offset = data.length;
  process.stdout.write(chunk);
}

try {
  readAll();
  if (!follow) process.exit(0);
  offset = statSafe(filePath)?.size || 0;
  watch(filePath, { persistent: true }, () => readNew());
  console.log(`✓ tailing ${filePath}`);
} catch (e) {
  console.error("✗ tail failed:", e.message);
  process.exit(1);
}
