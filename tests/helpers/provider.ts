import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { assistantMessage } from "./pi.js";

export type Generation = { model: Model<string>; context: Context };

/** Replace generation only; Pi still owns context building, tools, queues and termination. */
export function scriptedProvider(
  model: Model<string>,
  reply: (
    request: Generation,
    signal?: AbortSignal,
  ) => Promise<AssistantMessage> | AssistantMessage,
  refreshModels?: ProviderConfig["refreshModels"],
): ExtensionFactory {
  return (pi) => {
    pi.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "fixture-only",
      models: [model],
      refreshModels,
      streamSimple: (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          let message: AssistantMessage;
          try {
            message = await reply(
              {
                model,
                context: structuredClone({
                  ...context,
                  tools: context.tools?.map(({ name, description, parameters }) => ({
                    name,
                    description,
                    parameters,
                  })),
                }),
              },
              options?.signal,
            );
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
