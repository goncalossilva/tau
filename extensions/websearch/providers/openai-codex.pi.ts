import type { Api, Model } from "@earendil-works/pi-ai";

import { dedupeSources, extractMarkdownSources } from "../normalize.js";
import type { WebsearchResult, WebsearchSource } from "../types.js";
import type { PiModelSelection } from "./pi-model.shared.js";
import { buildWebsearchPrompt, WEBSEARCH_SYSTEM_PROMPT } from "./search-prompt.shared.js";
import { applyResolvedHeaders, getResolvedHeader, readEventStream, withTimeout } from "./shared.js";

export async function searchWithPiOpenAICodex(
  selection: PiModelSelection,
  query: string,
  signal?: AbortSignal,
): Promise<WebsearchResult> {
  const apiKey = resolveApiKey(selection);
  if (!apiKey) {
    throw new Error("OpenAI Codex auth is not configured.");
  }

  const result = await runOpenAICodexSearch({
    apiKey,
    accountId: decodeJwtAccountId(apiKey),
    model: selection.model.id,
    query,
    baseUrl: selection.model.baseUrl,
    headers: selection.headers,
    signal,
  });

  return {
    backend: "openai-codex",
    authSource: "pi",
    answer: result.answer,
    sources: result.sources,
  };
}

export function isPiOpenAICodexModel(model: Model<Api>): boolean {
  return model.api === "openai-codex-responses" && model.provider === "openai-codex";
}

function resolveApiKey(selection: PiModelSelection): string | undefined {
  if (selection.apiKey) return selection.apiKey;

  const authorization = getResolvedHeader(selection.headers, "authorization");
  if (!authorization) return undefined;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

async function runOpenAICodexSearch(options: {
  apiKey: string;
  model: string;
  query: string;
  baseUrl?: string;
  accountId?: string;
  headers?: Record<string, string | null>;
  signal?: AbortSignal;
}): Promise<{ answer: string; sources: WebsearchSource[] }> {
  const response = await fetch(resolveCodexUrl(options.baseUrl), {
    method: "POST",
    headers: applyResolvedHeaders(
      {
        authorization: `Bearer ${options.apiKey}`,
        ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
        "content-type": "application/json",
        accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        originator: "pi-websearch",
      },
      options.headers,
    ),
    body: JSON.stringify({
      model: options.model,
      store: false,
      stream: true,
      instructions: WEBSEARCH_SYSTEM_PROMPT,
      input: [{ role: "user", content: buildWebsearchPrompt(options.query) }],
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    }),
    signal: withTimeout(options.signal, 120_000),
  });

  let answer = "";
  let fallbackAnswer = "";
  let completed = false;

  await readEventStream(response, ({ data }) => {
    if (!data.trim()) return;

    try {
      const event = JSON.parse(data) as Record<string, unknown>;

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        answer += event.delta;
      }

      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        const content = Array.isArray(item?.content) ? item.content : [];
        const fullText = content
          .filter(
            (part) =>
              part &&
              typeof part === "object" &&
              (part as Record<string, unknown>).type === "output_text",
          )
          .map((part) => (part as Record<string, unknown>).text)
          .filter((text): text is string => typeof text === "string")
          .join("\n");
        if (fullText) fallbackAnswer = fullText;
      }

      if (
        event.type === "response.completed" ||
        event.type === "response.done" ||
        event.type === "response.incomplete"
      ) {
        const result = event.response as Record<string, unknown> | undefined;
        if (event.type === "response.incomplete" || result?.status !== "completed") {
          throw new Error("OpenAI Codex search did not complete successfully.");
        }
        completed = true;
      }

      if (event.type === "response.failed" || event.type === "error") {
        const failedResponse = event.response;
        const eventMessage = typeof event.message === "string" ? event.message : undefined;
        if (failedResponse && typeof failedResponse === "object") {
          const error = (failedResponse as Record<string, unknown>).error;
          if (
            error &&
            typeof error === "object" &&
            typeof (error as Record<string, unknown>).message === "string"
          ) {
            throw new Error((error as Record<string, unknown>).message as string);
          }
        }
        throw new Error(eventMessage ?? "OpenAI Codex search failed.");
      }
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  });

  if (!completed) {
    throw new Error("OpenAI Codex stream ended before search completed.");
  }

  const finalAnswer = (answer || fallbackAnswer).trim();
  if (!finalAnswer) {
    throw new Error("OpenAI Codex returned an empty response.");
  }

  return {
    answer: finalAnswer,
    sources: dedupeSources(extractMarkdownSources(finalAnswer)),
  };
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api"): string {
  const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function decodeJwtAccountId(jwt: string | undefined): string | undefined {
  if (!jwt || typeof jwt !== "string") return undefined;

  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"];
    return auth && typeof auth === "object"
      ? ((auth as Record<string, unknown>).chatgpt_account_id as string | undefined)
      : undefined;
  } catch {
    return undefined;
  }
}
