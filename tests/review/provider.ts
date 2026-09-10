import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixtureModel } from "../helpers/pi.js";
import { scriptedProvider } from "../helpers/provider.js";

const spawn = childProcess.spawn;

export const providerPath = fileURLToPath(import.meta.url);
export const reviewModel = {
  ...fixtureModel,
  provider: "review-fixture",
  input: ["text", "image"],
} satisfies Model<string>;

/** Loaded explicitly by the pinned, real JSON CLI. IPC replaces paid generation, not Pi's wire events. */
export default function childProvider(pi: ExtensionAPI) {
  const reject = () => {
    process.send?.({ type: "unexpected", error: "Unexpected external work in review child" });
    throw new Error("Unexpected external work in review child");
  };
  mock.method(globalThis, "fetch", reject);
  for (const method of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    mock.method(childProcess, method, reject);
  }
  const shellCommand = process.env.TAU_REVIEW_TEST_BASH;
  if (shellCommand) {
    mock.method(
      childProcess,
      "spawn",
      (command: string, args: string[], options: childProcess.SpawnOptions) => {
        assert.equal(command, "/bin/bash");
        assert.deepEqual(args, ["-c", shellCommand]);
        return spawn(command, args, options);
      },
    );
  }
  syncBuiltinESMExports();
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && shellCommand && event.input.command === shellCommand) return;
    if (event.toolName !== "read" && event.toolName !== "submit_review") reject();
  });
  pi.on("session_shutdown", () => process.disconnect?.());
  return scriptedProvider(
    reviewModel,
    (request) =>
      new Promise<AssistantMessage>((resolve) => {
        process.once("message", (message) => resolve(message as AssistantMessage));
        process.send?.({ type: "generation", ...request });
      }),
  )(pi);
}
