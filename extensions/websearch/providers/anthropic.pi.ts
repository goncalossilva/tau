import type { Api, Model } from "@earendil-works/pi-ai";

import { dedupeSources, extractMarkdownSources } from "../normalize.js";
import type { WebsearchResult } from "../types.js";
import type { PiModelSelection } from "./pi-model.shared.js";
import { buildWebsearchPrompt, WEBSEARCH_SYSTEM_PROMPT } from "./search-prompt.shared.js";
import { applyResolvedHeaders, fetchText, getResolvedHeader, withTimeout } from "./shared.js";

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
      system: buildAnthropicSystem(getAnthropicCredential(selection)),
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
    .filter(
      (item) =>
        item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
    )
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
  const credential = getAnthropicCredential(selection);
  if (isAnthropicOAuthToken(credential)) {
    return applyResolvedHeaders(
      {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        "anthropic-version": "2023-06-01",
        "anthropic-beta":
          "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
        accept: "application/json",
        "x-app": "cli",
        "user-agent": "claude-cli/2.1.62",
      },
      selection.headers,
    );
  }

  return applyResolvedHeaders(
    {
      ...(credential ? { "x-api-key": credential } : {}),
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
      "content-type": "application/json",
      accept: "application/json",
    },
    selection.headers,
  );
}

function resolveAnthropicMessagesUrl(baseUrl?: string): string {
  const normalized = String(baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  return normalized.endsWith("/v1/messages") ? normalized : `${normalized}/v1/messages`;
}

function buildAnthropicSystem(apiKey?: string): string | Array<{ type: "text"; text: string }> {
  if (!isAnthropicOAuthToken(apiKey)) return WEBSEARCH_SYSTEM_PROMPT;

  return [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: WEBSEARCH_SYSTEM_PROMPT },
  ];
}

function getAnthropicCredential(selection: PiModelSelection): string | undefined {
  return (
    selection.apiKey ??
    getBearerToken(selection.headers) ??
    getResolvedHeader(selection.headers, "x-api-key")
  );
}

function getBearerToken(headers?: Record<string, string | null>): string | undefined {
  const authorization = getResolvedHeader(headers, "authorization");
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function isAnthropicOAuthToken(apiKey?: string): boolean {
  return Boolean(apiKey?.includes("sk-ant-oat"));
}

export function isPiAnthropicModel(model: Model<Api>): boolean {
  return model.api === "anthropic-messages" && model.provider === "anthropic";
}
