import type { WebsearchSource } from "../types.js";
import { dedupeSources, extractMarkdownSources } from "../normalize.js";
import { buildWebsearchPrompt, WEBSEARCH_SYSTEM_PROMPT } from "./search-prompt.shared.js";
import { readEventStream, withTimeout } from "./shared.js";

export function decodeJwtAccountId(jwt: string | undefined): string | undefined {
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

export function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api"): string {
  const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

export async function runOpenAICodexSearch(options: {
  apiKey: string;
  model: string;
  query: string;
  baseUrl?: string;
  accountId?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ answer: string; sources: WebsearchSource[] }> {
  const response = await fetch(resolveCodexUrl(options.baseUrl), {
    method: "POST",
    headers: {
      ...options.headers,
      authorization: `Bearer ${options.apiKey}`,
      ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
      "content-type": "application/json",
      accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi-websearch",
    },
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

  const finalAnswer = (answer || fallbackAnswer).trim();
  if (!finalAnswer) {
    throw new Error("OpenAI Codex returned an empty response.");
  }

  return {
    answer: finalAnswer,
    sources: dedupeSources(extractMarkdownSources(finalAnswer)),
  };
}
