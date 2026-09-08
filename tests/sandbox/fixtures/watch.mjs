import assert from "node:assert/strict";
import { readFileSync, watch, writeFileSync } from "node:fs";

const [, , directory, keyFile] = process.argv;
const denied = (error) => error?.code === "EACCES" || error?.code === "EPERM";
assert.throws(() => readFileSync(keyFile), denied, "the synthetic SSH key must remain unreadable");
assert.throws(
  () => writeFileSync(".env", "INK=stolen\n"),
  denied,
  "watcher access must not open protected configuration for writing",
);
console.log("PROTECTED");

let watcher;
try {
  watcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (filename !== "nest/egg.txt") return;
    watcher.close();
    console.log("OBSERVED");
  });
  watcher.once("error", failed);
  console.log("READY");
} catch (error) {
  failed(error);
}

function failed(error) {
  watcher?.close();
  console.error(error.message);
  console.log("WATCH_FAILED");
  process.exitCode = 1;
}
