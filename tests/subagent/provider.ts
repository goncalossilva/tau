import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { assistantMessage, fixtureModel } from "../helpers/pi.js";
import { scriptedProvider, type Generation } from "../helpers/provider.js";

const spawn = childProcess.spawn;
export const parentModel = { ...fixtureModel, reasoning: true };
export const workerModel = {
  ...parentModel,
  id: "quick",
  provider: "worker-fixture",
  api: "worker-fixture",
};

/** Loaded by real RPC children. Only paid generation and explicitly requested UI are scripted. */
export default function childProvider(pi: ExtensionAPI): void {
  const reject = (...args: unknown[]): never => {
    const message = `Unexpected subagent external work: ${String(args[0])}`;
    process.send?.({ type: "unexpected", message });
    throw new Error(message);
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
  const shellCommand = process.env.TAU_SUBAGENT_TEST_SHELL;
  if (shellCommand)
    mock.method(
      childProcess,
      "spawn",
      (command: string, args: string[], options: childProcess.SpawnOptions) => {
        assert.equal(command, "/bin/bash");
        assert.deepEqual(args, ["-c", shellCommand]);
        return spawn(command, args, options);
      },
    );
  syncBuiltinESMExports();
  if (process.env.TAU_SUBAGENT_TEST_SANDBOX === "1") {
    mock.method(SandboxManager, "checkDependencies", () => ({ warnings: [], errors: [] }));
    mock.method(
      SandboxManager,
      "initialize",
      async (...[config]: Parameters<typeof SandboxManager.initialize>) => {
        SandboxManager.updateConfig(config);
      },
    );
    pi.on("session_start", () => {
      process.send?.({ type: "sandbox", config: SandboxManager.getConfig() });
    });
  }
  pi.on("session_start", (_event, ctx) => {
    process.send?.({ type: "trust", trusted: ctx.isProjectTrusted() });
  });
  pi.on("tool_call", (event) => {
    if (["read", "write", "ask"].includes(event.toolName)) return;
    if (event.toolName === "bash" && event.input.command === shellCommand && shellCommand) return;
    reject(event.toolName);
  });
  pi.registerTool({
    name: "ask",
    label: "Fixture approval",
    description: "Ask the user",
    parameters: Type.Object({ name: Type.String(), select: Type.Boolean() }),
    async execute(_id, args, signal, _update, ctx) {
      const answer = args.select
        ? await ctx.ui.select(args.name, ["Allow", "Deny"], { signal })
        : await ctx.ui.confirm(args.name, "Allow this child only?", { signal });
      return { content: [{ type: "text", text: JSON.stringify(answer ?? false) }], details: {} };
    },
  });
  let sequence = 0;
  for (const model of [parentModel, workerModel]) {
    scriptedProvider(
      model,
      (request: Generation, signal) =>
        new Promise<AssistantMessage>((resolve) => {
          const id = ++sequence;
          const finish = (message: AssistantMessage) => {
            process.off("message", receive);
            signal?.removeEventListener("abort", abort);
            resolve(message);
          };
          const receive = (data: unknown) => {
            const message = data as { type: string; id: number; message: AssistantMessage };
            if (message.type === "reply" && message.id === id) finish(message.message);
          };
          const abort = () => finish({ ...assistantMessage(""), stopReason: "aborted" });
          process.on("message", receive);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          else process.send?.({ type: "generation", id, ...request });
        }),
    )(pi);
  }
  if (process.env.TAU_SUBAGENT_TEST_STARTUP === "1") {
    pi.on(
      "session_start",
      () =>
        new Promise<void>((resolve) => {
          process.once("message", () => resolve());
          process.send?.({ type: "startup" });
        }),
    );
  }
  pi.on("session_shutdown", () => {
    process.disconnect?.();
  });
}
