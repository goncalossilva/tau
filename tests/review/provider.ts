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
const fetch = globalThis.fetch;

export const providerPath = fileURLToPath(import.meta.url);
export const reviewModel = {
  ...fixtureModel,
  provider: "review-fixture",
  input: ["text", "image"],
} satisfies Model<string>;

/** The real CLI uses IPC for hosted generation or guarded localhost HTTP for native llama.cpp. */
export default function childProvider(pi: ExtensionAPI) {
  const reject = () => {
    process.send?.({ type: "unexpected", error: "Unexpected external work in review child" });
    throw new Error("Unexpected external work in review child");
  };
  const llamaUrl = process.env.TAU_REVIEW_LLAMA_URL;
  mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (llamaUrl && url.origin === llamaUrl) return fetch(input, init);
    return reject();
  });
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
    if (!["read", "submit_review"].includes(event.toolName)) reject();
  });
  pi.on("session_start", () => {
    const tools = pi.getAllTools().map((tool) => tool.name);
    const commands = pi.getCommands().map((command) => command.name);
    assert.ok(!tools.includes("codemode") && !tools.includes("tool_search"));
    assert.ok(!commands.includes("mcp"));
    process.send?.({ type: "isolation", tools, commands, activeTools: pi.getActiveTools() });
  });
  pi.on("session_shutdown", () => process.disconnect?.());
  if (process.env.TAU_REVIEW_LLAMA_DISCOVER) {
    pi.registerCommand("prime-llama", {
      description: "Populate the offline fixture catalog through native llama discovery",
      handler: async (_args, ctx) => {
        const result = await ctx.modelRegistry.refresh({
          providers: ["llama.cpp"],
          allowNetwork: true,
        });
        assert.equal(
          result.errors.size,
          0,
          [...result.errors].map(([provider, error]) => `${provider}: ${error}`).join("\n"),
        );
        const model = ctx.modelRegistry.find("llama.cpp", "cafe-llama");
        assert.ok(model);
        process.send?.({ type: "catalog", model });
      },
    });
  }
  if (llamaUrl) return;
  return scriptedProvider(
    reviewModel,
    (request) =>
      new Promise<AssistantMessage>((resolve) => {
        process.once("message", (message) => resolve(message as AssistantMessage));
        process.send?.({ type: "generation", ...request });
      }),
  )(pi);
}
