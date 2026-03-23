import type { Api, Model } from "@mariozechner/pi-ai";

import { dedupeSources, extractMarkdownSources } from "../normalize.js";
import type { WebsearchResult } from "../types.js";
import type { PiModelSelection } from "./pi-model.shared.js";
import { buildWebsearchPrompt, WEBSEARCH_SYSTEM_PROMPT } from "./search-prompt.shared.js";
import { fetchText, withTimeout } from "./shared.js";

export async function searchWithPiAnthropic(
  selection: PiModelSelection,
  query: string,
  signal?: AbortSignal,
): Promise<WebsearchResult> {
  const payload = await fetchText(resolveAnthropicMessagesUrl(selection.model.baseUrl), {
    method: "POST",
    headers: buildAnthropicHeaders(selection),
    body: JSON.stringify({
      model: selection.model.id,
      max_tokens: 1800,
      system: buildAnthropicSystem(selection.apiKey),
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: buildWebsearchPrompt(query) }],
    }),
    signal: withTimeout(signal, 120_000),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error("Anthropic returned non-JSON response.");
  }

  const answer = (Array.isArray(parsed.content) ? parsed.content : [])
    .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text")
    .map((item) => (item as Record<string, unknown>).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n\n")
    .trim();

  if (!answer) {
    throw new Error("Anthropic returned no text content.");
  }

  return {
    backend: "anthropic",
    authSource: "pi",
    answer,
    sources: dedupeSources(extractMarkdownSources(answer)),
  };
}

function buildAnthropicHeaders(selection: PiModelSelection): Record<string, string> {
  const apiKey = selection.apiKey;

  if (isAnthropicOAuthToken(apiKey)) {
    return {
      ...(selection.model.headers ?? {}),
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
      accept: "application/json",
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.62",
    };
  }

  return {
    ...(selection.model.headers ?? {}),
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "web-search-2025-03-05",
    "content-type": "application/json",
    accept: "application/json",
  };
}

function resolveAnthropicMessagesUrl(baseUrl?: string): string {
  const normalized = String(baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  return normalized.endsWith("/v1/messages") ? normalized : `${normalized}/v1/messages`;
}

function buildAnthropicSystem(apiKey: string): string | Array<{ type: "text"; text: string }> {
  if (!isAnthropicOAuthToken(apiKey)) return WEBSEARCH_SYSTEM_PROMPT;

  return [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: WEBSEARCH_SYSTEM_PROMPT },
  ];
}

function isAnthropicOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

export function isPiAnthropicModel(model: Model<Api>): boolean {
  return model.api === "anthropic-messages" && model.provider === "anthropic";
}
