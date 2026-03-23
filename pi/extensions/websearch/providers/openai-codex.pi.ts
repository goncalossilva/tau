import type { Api, Model } from "@mariozechner/pi-ai";

import type { WebsearchResult } from "../types.js";
import { decodeJwtAccountId, runOpenAICodexSearch } from "./openai-codex.shared.js";
import type { PiModelSelection } from "./pi-model.shared.js";

export async function searchWithPiOpenAICodex(
  selection: PiModelSelection,
  query: string,
  signal?: AbortSignal,
): Promise<WebsearchResult> {
  const result = await runOpenAICodexSearch({
    apiKey: selection.apiKey,
    accountId: decodeJwtAccountId(selection.apiKey),
    model: selection.model.id,
    query,
    baseUrl: selection.model.baseUrl,
    headers: selection.model.headers,
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
