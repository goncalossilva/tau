import type { Api, Model } from "@earendil-works/pi-ai";

import { dedupeSources, extractMarkdownSources } from "../normalize.js";
import type { WebsearchResult, WebsearchSource } from "../types.js";
import type { PiModelSelection } from "./pi-model.shared.js";
import { buildWebsearchPrompt, WEBSEARCH_SYSTEM_PROMPT } from "./search-prompt.shared.js";
import { applyResolvedHeaders, getResolvedHeader, readEventStream, withTimeout } from "./shared.js";

export async function searchWithPiOpenAI(
  selection: PiModelSelection,
  query: string,
  signal?: AbortSignal,
): Promise<WebsearchResult> {
  const apiKey = resolveApiKey(selection);
  if (!apiKey) {
    throw new Error("OpenAI auth is not configured.");
  }

  const backend = selection.model.provider === "openai-codex" ? "openai-codex" : "openai";
  const result = await runOpenAISearch({
    apiKey,
    backend,
    model: selection.model.id,
    query,
    baseUrl: selection.model.baseUrl,
    headers: selection.headers,
    signal,
  });

  return {
    backend,
    authSource: "pi",
    answer: result.answer,
    sources: result.sources,
  };
}

export function isPiOpenAIModel(model: Model<Api>): boolean {
  return model.api === "openai-responses" && model.provider === "openai";
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

async function runOpenAISearch(options: {
  apiKey: string;
  backend: "openai" | "openai-codex";
  model: string;
  query: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
  signal?: AbortSignal;
}): Promise<{ answer: string; sources: WebsearchSource[] }> {
  const codex = options.backend === "openai-codex";
  const accountId = codex ? decodeJwtAccountId(options.apiKey) : undefined;
  const url = codex ? resolveCodexUrl(options.baseUrl) : resolveResponsesUrl(options.baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: applyResolvedHeaders(
      {
        authorization: `Bearer ${options.apiKey}`,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(codex ? { "OpenAI-Beta": "responses=experimental", originator: "pi-websearch" } : {}),
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

  const sources: WebsearchSource[] = [];
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
        sources.push(...extractAnnotationSources(content));
      }

      if (
        event.type === "response.completed" ||
        event.type === "response.done" ||
        event.type === "response.incomplete"
      ) {
        const result = event.response as Record<string, unknown> | undefined;
        if (event.type === "response.incomplete" || result?.status !== "completed") {
          throw new Error("OpenAI search did not complete successfully.");
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
        throw new Error(eventMessage ?? "OpenAI search failed.");
      }
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  });

  if (!completed) {
    throw new Error("OpenAI stream ended before search completed.");
  }

  const finalAnswer = (answer || fallbackAnswer).trim();
  if (!finalAnswer) {
    throw new Error("OpenAI returned an empty response.");
  }

  return {
    answer: finalAnswer,
    sources: dedupeSources([...sources, ...extractMarkdownSources(finalAnswer)]),
  };
}

function extractAnnotationSources(content: unknown[]): WebsearchSource[] {
  const sources: WebsearchSource[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || !("annotations" in part)) continue;
    if (!Array.isArray(part.annotations)) continue;
    for (const annotation of part.annotations) {
      if (
        annotation?.type !== "url_citation" ||
        typeof annotation.url !== "string" ||
        !/^https?:\/\//i.test(annotation.url)
      )
        continue;
      sources.push({
        url: annotation.url,
        title: typeof annotation.title === "string" ? annotation.title : "",
      });
    }
  }
  return sources;
}

function resolveResponsesUrl(baseUrl?: string): string {
  const normalized = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
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
