import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createBrowserSession, discoverProfiles } from "./browser/discovery.js";
import { loadConfig } from "./config.js";
import { renderSearchResultMarkdown } from "./normalize.js";
import { isPiAnthropicModel, searchWithPiAnthropic } from "./providers/anthropic.pi.js";
import { browserGemini } from "./providers/gemini.browser.js";
import { isPiGeminiModel, searchWithPiGemini } from "./providers/gemini.pi.js";
import { browserOpenAICodex } from "./providers/openai-codex.browser.js";
import { isPiOpenAICodexModel, searchWithPiOpenAICodex } from "./providers/openai-codex.pi.js";
import type { PiModelSelection } from "./providers/pi-model.shared.js";
import { selectCurrentPiModel, selectFallbackPiModel } from "./providers/pi-model.shared.js";
import type { BrowserProfile, WebsearchAuthSource, WebsearchBackendId, WebsearchBrowserFamily, WebsearchConfig, WebsearchResult, WebsearchRouteId } from "./types.js";

interface SearchSummary {
  result: string;
  route: WebsearchRouteId;
  backend: WebsearchBackendId;
  authSource: WebsearchAuthSource;
  browserName?: string;
  profile?: string;
  accountLabel?: string;
  sources: number;
}

interface PiRouteHandler {
  predicate: (model: Model<Api>) => boolean;
  search: (selection: PiModelSelection, query: string, signal?: AbortSignal) => Promise<WebsearchResult>;
}

const PI_ROUTE_HANDLERS: Record<`pi:${WebsearchBackendId}`, PiRouteHandler> = {
  "pi:openai-codex": {
    predicate: isPiOpenAICodexModel,
    search: searchWithPiOpenAICodex,
  },
  "pi:anthropic": {
    predicate: isPiAnthropicModel,
    search: searchWithPiAnthropic,
  },
  "pi:gemini": {
    predicate: isPiGeminiModel,
    search: searchWithPiGemini,
  },
};

function toSearchSummary(route: WebsearchRouteId, result: WebsearchResult): SearchSummary {
  return {
    result: renderSearchResultMarkdown(result.answer, result.sources),
    route,
    backend: result.backend,
    authSource: result.authSource,
    browserName: result.browserName,
    profile: result.profile,
    accountLabel: result.accountLabel,
    sources: result.sources.length,
  };
}

function currentPiRoute(ctx: ExtensionContext): `pi:${WebsearchBackendId}` | null {
  if (!ctx.model) return null;

  for (const [route, handler] of Object.entries(PI_ROUTE_HANDLERS) as Array<[`pi:${WebsearchBackendId}`, PiRouteHandler]>) {
    if (handler.predicate(ctx.model)) return route;
  }

  return null;
}

async function executePiRoute(
  route: `pi:${WebsearchBackendId}`,
  ctx: ExtensionContext,
  query: string,
  mode: "current" | "fallback",
  signal?: AbortSignal,
): Promise<SearchSummary | null> {
  const handler = PI_ROUTE_HANDLERS[route];
  const selection = mode === "current"
    ? await selectCurrentPiModel(ctx, handler.predicate)
    : await selectFallbackPiModel(ctx, handler.predicate);

  return selection ? toSearchSummary(route, await handler.search(selection, query, signal)) : null;
}

async function searchPiRoute(
  route: `pi:${WebsearchBackendId}`,
  ctx: ExtensionContext,
  query: string,
  signal?: AbortSignal,
): Promise<SearchSummary | null> {
  if (route === currentPiRoute(ctx)) {
    const current = await executePiRoute(route, ctx, query, "current", signal);
    if (current) return current;
  }

  return executePiRoute(route, ctx, query, "fallback", signal);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("The operation was aborted.");
}

function getBrowserProfiles(
  cache: Partial<Record<WebsearchBrowserFamily, BrowserProfile[]>>,
  family: WebsearchBrowserFamily,
  config: WebsearchConfig,
): BrowserProfile[] {
  const cached = cache[family];
  if (cached) return cached;

  const profiles = discoverProfiles([family], config.profiles);
  cache[family] = profiles;
  return profiles;
}

async function searchBrowserRoute(
  route: WebsearchRouteId,
  config: WebsearchConfig,
  query: string,
  profileCache: Partial<Record<WebsearchBrowserFamily, BrowserProfile[]>>,
  signal?: AbortSignal,
): Promise<SearchSummary | null> {
  const profileFamily: WebsearchBrowserFamily = route.startsWith("firefox:") ? "firefox" : "chromium";
  const browserProvider = route.endsWith(":gemini") ? browserGemini : browserOpenAICodex;
  const configuredProfileName = config.profiles[profileFamily];
  const profiles = getBrowserProfiles(profileCache, profileFamily, config);
  let lastError: string | null = null;

  if (configuredProfileName && profiles.length === 0) {
    throw new Error(`Configured ${profileFamily} profile was not found: ${configuredProfileName}`);
  }

  for (const profile of profiles) {
    throwIfAborted(signal);

    try {
      const session = createBrowserSession(profile, browserProvider.domains);
      if (!session) {
        if (configuredProfileName) {
          throw new Error(`Configured ${profileFamily} profile has no usable session: ${configuredProfileName}`);
        }
        continue;
      }
      return toSearchSummary(route, await browserProvider.search(session, query, signal));
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (lastError) throw new Error(lastError);
  return null;
}

async function searchRoute(
  route: WebsearchRouteId,
  ctx: ExtensionContext,
  config: WebsearchConfig,
  query: string,
  profileCache: Partial<Record<WebsearchBrowserFamily, BrowserProfile[]>>,
  signal?: AbortSignal,
): Promise<SearchSummary | null> {
  return route.startsWith("pi:")
    ? await searchPiRoute(route as `pi:${WebsearchBackendId}`, ctx, query, signal)
    : await searchBrowserRoute(route, config, query, profileCache, signal);
}

async function runSearch(
  ctx: ExtensionContext,
  query: string,
  signal?: AbortSignal,
): Promise<SearchSummary> {
  const config = loadConfig();
  const profileCache: Partial<Record<WebsearchBrowserFamily, BrowserProfile[]>> = {};
  let lastError: string | null = null;

  for (const route of config.routes) {
    throwIfAborted(signal);

    try {
      const result = await searchRoute(route, ctx, config, query, profileCache, signal);
      if (result) return result;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError ?? "No configured websearch route is available.");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "Websearch",
    description:
      "Web search via Gemini, OpenAI, or Claude, leveraging Pi or browser sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Searching..." }],
        details: { phase: "searching" },
      });

      const result = await runSearch(ctx, params.query, signal);
      return {
        content: [{ type: "text", text: result.result }],
        details: {
          route: result.route,
          backend: result.backend,
          authSource: result.authSource,
          browserName: result.browserName,
          profile: result.profile,
          accountLabel: result.accountLabel,
          sources: result.sources,
        },
      };
    },
  });
}
