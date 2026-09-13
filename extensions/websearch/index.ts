import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { createBrowserSession, discoverProfiles } from "./browser/discovery.js";
import { loadConfig } from "./config.js";
import { renderSearchResultMarkdown } from "./normalize.js";
import { limitOutput } from "./output.js";
import { isPiAnthropicModel, searchWithPiAnthropic } from "./providers/anthropic.pi.js";
import { browserGemini } from "./providers/gemini.browser.js";
import { isPiGeminiModel, searchWithPiGemini } from "./providers/gemini.pi.js";
import { isPiOpenAICodexModel, searchWithPiOpenAICodex } from "./providers/openai-codex.pi.js";
import type { PiModelSelection } from "./providers/pi-model.shared.js";
import { getPiModelCandidates, selectNextPiModel } from "./providers/pi-model.shared.js";
import { isModelUnavailableError } from "./providers/shared.js";
import type {
  WebsearchAuthSource,
  WebsearchBackendId,
  WebsearchBrowserFamily,
  WebsearchConfig,
  WebsearchResult,
  WebsearchRouteId,
} from "./types.js";

type PiRouteId = `pi:${WebsearchBackendId}`;

const PI_ROUTE_HANDLERS: Record<PiRouteId, PiRouteHandler> = {
  "pi:openai-codex": {
    predicate: isPiOpenAICodexModel,
    search: searchWithPiOpenAICodex,
    fallbackModels: ["gpt-5.6-luna", "gpt-5.5"],
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

interface SearchSummary {
  result: string;
  route: WebsearchRouteId;
  backend: WebsearchBackendId;
  authSource: WebsearchAuthSource;
  browserName?: string;
  profile?: string;
  sources: number;
}

interface PiRoutePlan {
  remaining: Model<Api>[];
  attemptsLeft: number;
}

interface PiRouteHandler {
  predicate: (model: Model<Api>) => boolean;
  fallbackModels?: readonly string[];
  search: (
    selection: PiModelSelection,
    query: string,
    signal?: AbortSignal,
  ) => Promise<WebsearchResult>;
}

async function runSearch(
  ctx: ExtensionContext,
  query: string,
  signal?: AbortSignal,
): Promise<SearchSummary> {
  const config = loadConfig();
  const plans = new Map<PiRouteId, PiRoutePlan>();
  let pending = config.routes;
  let lastError: string | null = null;

  while (pending.length > 0) {
    const retries: PiRouteId[] = [];
    for (const route of pending) {
      throwIfAborted(signal);
      let selection: PiModelSelection | null = null;
      let plan: PiRoutePlan | undefined;
      try {
        if (isPiRoute(route)) {
          const handler = PI_ROUTE_HANDLERS[route];
          plan = plans.get(route);
          if (!plan) {
            const remaining = getPiModelCandidates(ctx, handler.predicate, handler.fallbackModels);
            plan = { remaining, attemptsLeft: handler.fallbackModels ? remaining.length : 2 };
            plans.set(route, plan);
          }
          selection = await selectNextPiModel(ctx, plan.remaining, signal);
          if (!selection) continue;
          throwIfAborted(signal);
          plan.attemptsLeft--;
          return toSearchSummary(route, await handler.search(selection, query, signal));
        }
        const result = await searchBrowserRoute(route, config, query, signal);
        if (result) return result;
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        if (
          isPiRoute(route) &&
          selection &&
          plan &&
          plan.attemptsLeft > 0 &&
          plan.remaining.length > 0 &&
          isModelUnavailableError(error, selection.model)
        ) {
          retries.push(route);
        }
      }
    }
    pending = retries;
  }

  throw new Error(lastError ?? "No configured websearch route is available.");
}

function isPiRoute(route: WebsearchRouteId): route is PiRouteId {
  return route.startsWith("pi:");
}

function toSearchSummary(route: WebsearchRouteId, result: WebsearchResult): SearchSummary {
  return {
    result: renderSearchResultMarkdown(result.answer, result.sources),
    route,
    backend: result.backend,
    authSource: result.authSource,
    browserName: result.browserName,
    profile: result.profile,
    sources: result.sources.length,
  };
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("The operation was aborted.");
}

async function searchBrowserRoute(
  route: WebsearchRouteId,
  config: WebsearchConfig,
  query: string,
  signal?: AbortSignal,
): Promise<SearchSummary | null> {
  const profileFamily: WebsearchBrowserFamily = route.startsWith("firefox:")
    ? "firefox"
    : "chromium";
  const configuredProfileName = config.profiles[profileFamily];
  const profiles = await discoverProfiles([profileFamily], config.profiles);
  let lastError: string | null = null;

  if (configuredProfileName && profiles.length === 0) {
    throw new Error(`Configured ${profileFamily} profile was not found: ${configuredProfileName}`);
  }

  for (const profile of profiles) {
    throwIfAborted(signal);

    try {
      const session = await createBrowserSession(profile, browserGemini.domains);
      if (!session) {
        if (configuredProfileName) {
          throw new Error(
            `Configured ${profileFamily} profile has no usable session: ${configuredProfileName}`,
          );
        }
        continue;
      }
      return toSearchSummary(route, await browserGemini.search(session, query, signal));
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (lastError) throw new Error(lastError);
  return null;
}

const COLLAPSED_RESULT_LINES = 10;

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}

function formatWebsearchCall(query: string, theme: any): string {
  let text = theme.fg("toolTitle", theme.bold("websearch"));
  if (query) {
    text += ` ${theme.fg("accent", query)}`;
  }
  return text;
}

function formatCollapsedWebsearchResult(resultText: string, theme: any): string {
  const lines = trimTrailingEmptyLines(resultText.split("\n"));
  if (lines.length === 0) {
    return `\n${theme.fg("muted", "(no output)")}`;
  }

  const displayLines = lines.slice(0, COLLAPSED_RESULT_LINES);
  const remaining = lines.length - displayLines.length;

  let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }

  return text;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "websearch",
      label: "Websearch",
      description: `Search the web for sourced answers. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first), including the truncation notice. Full truncated output is saved to a temporary file.`,
      promptSnippet: "Discover web sources for current or external information",
      promptGuidelines: [
        "Use websearch for recent facts, live service behavior, or external documentation that is not already present in the repo.",
        "When asked to read a supplied URL, fetch that page directly. Use websearch to discover sources or independently verify information.",
        "Do not use websearch when repository files or supplied context already answer the question.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "What to search for" }),
      }),
      renderShell: "self",
      renderCall(args, theme) {
        return new Text(formatWebsearchCall(args.query, theme), 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const content = result.content.find((item) => item.type === "text");
        const text = content?.type === "text" ? content.text : "";

        if (!expanded) {
          return new Text(formatCollapsedWebsearchResult(text, theme), 0, 0);
        }

        if (!text.trim()) {
          return new Text(`\n${theme.fg("muted", "(no output)")}`, 0, 0);
        }

        const container = new Container();
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(text.trim(), 0, 0, getMarkdownTheme()));
        return container;
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let result: SearchSummary;
        try {
          result = await runSearch(ctx, params.query, signal);
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          const output = await limitOutput(
            error instanceof Error ? error.message : String(error),
            signal,
          );
          throw new Error(output.text);
        }
        const output = await limitOutput(result.result, signal);
        return {
          content: [{ type: "text", text: output.text }],
          details: {
            ...output.details,
            route: result.route,
            backend: result.backend,
            authSource: result.authSource,
            browserName: result.browserName,
            profile: result.profile,
            sources: result.sources,
          },
        };
      },
    }),
  );
}
