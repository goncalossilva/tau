import type { Api, Model } from "@mariozechner/pi-ai";

import { dedupeSources, extractMarkdownSources, normalizeSourceTitle } from "../normalize.js";
import type { WebsearchResult, WebsearchSource } from "../types.js";
import type { PiModelSelection } from "./pi-model.shared.js";
import { buildWebsearchPrompt } from "./search-prompt.shared.js";
import { fetchJson, withTimeout } from "./shared.js";

export async function searchWithPiGemini(
  selection: PiModelSelection,
  query: string,
  signal?: AbortSignal,
): Promise<WebsearchResult> {
  const interaction = await fetchJson<Record<string, unknown>>(
    resolveGeminiInteractionsUrl(selection.model.baseUrl),
    {
      method: "POST",
      headers: buildGeminiHeaders(selection),
      body: JSON.stringify({
        model: selection.model.id,
        input: buildWebsearchPrompt(query),
        tools: [{ googleSearch: {} }],
      }),
      signal: withTimeout(signal, 120_000),
    },
  );

  const textOutputs = (Array.isArray(interaction.outputs) ? interaction.outputs : []).filter(
    (output) => {
      return Boolean(
        output &&
        typeof output === "object" &&
        (output as { type?: unknown }).type === "text" &&
        typeof (output as { text?: unknown }).text === "string",
      );
    },
  ) as Array<{ text: string; annotations?: Array<{ source?: string }> }>;

  const answer = textOutputs
    .map((output) => output.text)
    .join("\n\n")
    .trim();

  if (!answer) {
    throw new Error("Gemini API returned no text content.");
  }

  const annotationSources = textOutputs.flatMap((output) =>
    extractAnnotationSources(output as { annotations?: Array<{ source?: string }> }),
  );
  return {
    backend: "gemini",
    authSource: "pi",
    answer,
    sources: dedupeSources([...annotationSources, ...extractMarkdownSources(answer)]),
  };
}

function resolveGeminiInteractionsUrl(baseUrl?: string): string {
  const normalized = String(baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  return normalized.endsWith("/interactions") ? normalized : `${normalized}/interactions`;
}

function buildGeminiHeaders(selection: PiModelSelection): Record<string, string> {
  const headers = { ...selection.headers };

  return {
    ...headers,
    ...(hasHeader(headers, "x-goog-api-key") || !selection.apiKey
      ? {}
      : { "x-goog-api-key": selection.apiKey }),
    "content-type": "application/json",
    accept: "application/json",
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function extractAnnotationSources(output: {
  annotations?: Array<{ source?: string; url?: string; title?: string }>;
}): WebsearchSource[] {
  const sources: WebsearchSource[] = [];

  for (const annotation of output.annotations ?? []) {
    const url =
      typeof annotation?.url === "string"
        ? annotation.url
        : typeof annotation?.source === "string"
          ? annotation.source
          : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    sources.push({
      title: normalizeSourceTitle(url, annotation.title),
      url,
    });
  }

  return sources;
}

export function isPiGeminiModel(model: Model<Api>): boolean {
  return model.api === "google-generative-ai" && model.provider === "google";
}
