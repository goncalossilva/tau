import type { Api, Model } from "@mariozechner/pi-ai";

import type { WebsearchResult } from "../types.js";
import { decodeJwtAccountId, runOpenAICodexSearch } from "./openai-codex.shared.js";
import type { PiModelSelection } from "./pi-model.shared.js";

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

function resolveApiKey(selection: PiModelSelection): string | undefined {
  if (selection.apiKey) return selection.apiKey;

  const authorization = Object.entries(selection.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  if (!authorization) return undefined;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function isPiOpenAICodexModel(model: Model<Api>): boolean {
  return model.api === "openai-codex-responses" && model.provider === "openai-codex";
}
