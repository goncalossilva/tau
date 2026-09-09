import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { assistantMessage, fixtureModel } from "../helpers/pi.js";

const spawn = childProcess.spawn;

export const providerPath = fileURLToPath(import.meta.url);
export const reviewModel = {
  ...fixtureModel,
  provider: "review-fixture",
  input: ["text", "image"],
} satisfies Model<string>;
export type Generation = { model: Model<string>; context: Context };

/** Script only generation; Pi still owns context building, tool validation/execution and termination. */
export function scriptedProvider(
  reply: (request: Generation) => Promise<AssistantMessage> | AssistantMessage,
  refreshModels?: ProviderConfig["refreshModels"],
): ExtensionFactory {
  return (pi) => {
    pi.registerProvider(reviewModel.provider, {
      api: reviewModel.api,
      baseUrl: reviewModel.baseUrl,
      apiKey: "fixture-only",
      models: [reviewModel],
      refreshModels,
      streamSimple: (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          let message: AssistantMessage;
          try {
            message = await reply({
              model,
              context: structuredClone({
                ...context,
                tools: context.tools?.map(({ name, description, parameters }) => ({
                  name,
                  description,
                  parameters,
                })),
              }),
            });
          } catch (error) {
            message = {
              ...assistantMessage(""),
              stopReason: options?.signal?.aborted ? "aborted" : "error",
              errorMessage: String(error),
            };
          }
          message = { ...message, model: model.id, provider: model.provider, api: model.api };
          stream.push({ type: "start", partial: message });
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } else {
            assert.notEqual(message.stopReason, "pending");
            stream.push({
              type: "done",
              reason: message.stopReason as "stop" | "length" | "toolUse",
              message,
            });
          }
          stream.end();
        })();
        return stream;
      },
    });
  };
}

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
    (request) =>
      new Promise<AssistantMessage>((resolve) => {
        process.once("message", (message) => resolve(message as AssistantMessage));
        process.send?.({ type: "generation", ...request });
      }),
  )(pi);
}
