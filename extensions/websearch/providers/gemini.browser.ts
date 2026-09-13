import undici, { EnvHttpProxyAgent, type Dispatcher, type RequestInit } from "undici";

import type { BrowserCookie, BrowserSession, WebsearchResult } from "../types.js";
import {
  browserHeaders,
  buildCookieHeader,
  dedupeSources,
  extractMarkdownSources,
  hasCookie,
} from "../normalize.js";
import { buildWebsearchPrompt } from "./search-prompt.shared.js";
import { withTimeout } from "./shared.js";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_GENERATE_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const REQUIRED_COOKIE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

export const browserGemini = {
  backend: "gemini" as const,
  domains: ["google.com"],
  async search(
    session: BrowserSession,
    query: string,
    signal?: AbortSignal,
  ): Promise<WebsearchResult> {
    for (const cookieName of REQUIRED_COOKIE_NAMES) {
      if (!hasCookie(GEMINI_APP_URL, session.cookies, cookieName)) {
        throw new Error(`Missing required Google cookie: ${cookieName}`);
      }
    }

    const dispatcher = new EnvHttpProxyAgent({
      maxHeaderSize: 64 * 1024,
      allowH2: false,
      proxyTunnel: true,
    });
    try {
      const accessToken = await fetchAccessToken(session.cookies, dispatcher, signal);
      const answer = await queryGemini(query, session.cookies, accessToken, dispatcher, signal);
      return {
        backend: "gemini",
        authSource: session.profile.family,
        browserName: session.profile.browserName,
        profile: session.profile.profileName,
        answer,
        sources: dedupeSources(extractMarkdownSources(answer)),
      };
    } finally {
      await dispatcher.close();
    }
  },
};

async function queryGemini(
  query: string,
  cookies: BrowserCookie[],
  accessToken: string,
  dispatcher: Dispatcher,
  signal?: AbortSignal,
): Promise<string> {
  const body = new URLSearchParams();
  body.set("at", accessToken);
  body.set(
    "f.req",
    JSON.stringify([null, JSON.stringify([[buildWebsearchPrompt(query)], null, null])]),
  );

  const rawText = await fetchGeminiText(GEMINI_STREAM_GENERATE_URL, dispatcher, {
    method: "POST",
    headers: {
      ...browserHeaders({
        cookieHeader: buildCookieHeader(GEMINI_STREAM_GENERATE_URL, cookies),
        origin: "https://gemini.google.com",
        referer: "https://gemini.google.com/",
        contentType: "application/x-www-form-urlencoded;charset=utf-8",
      }),
      host: "gemini.google.com",
      "x-same-domain": "1",
    },
    body: body.toString(),
    signal: withTimeout(signal, 120_000),
  });

  return parseGeminiResponse(rawText);
}

async function fetchAccessToken(
  cookies: BrowserCookie[],
  dispatcher: Dispatcher,
  signal?: AbortSignal,
): Promise<string> {
  const html = await fetchGeminiText(GEMINI_APP_URL, dispatcher, {
    headers: browserHeaders({
      cookieHeader: buildCookieHeader(GEMINI_APP_URL, cookies),
      origin: "https://gemini.google.com",
      referer: "https://gemini.google.com/",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
    signal: withTimeout(signal, 20_000),
  });

  for (const key of ["SNlM0e", "thykhd"]) {
    const match = html.match(new RegExp(`"${key}":"([^\\"]*)"`));
    if (match?.[1]) return match[1];
  }

  throw new Error("Could not authenticate with Gemini Web.");
}

async function fetchGeminiText(
  url: string,
  dispatcher: Dispatcher,
  options: RequestInit,
): Promise<string> {
  const response = await undici.fetch(url, { ...options, dispatcher });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}${text ? `\n${text}` : ""}`);
  }
  return text;
}

function parseGeminiResponse(rawText: string): string {
  const start = rawText.indexOf("[");
  const end = rawText.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini Web returned an invalid payload.");
  }

  const responseJson = JSON.parse(rawText.slice(start, end + 1));
  const parts = Array.isArray(responseJson) ? responseJson : [];

  let answer: string | undefined;
  let completed = false;
  for (const part of parts) {
    const errorCode = getNestedValue(part, [5, 2, 0, 1, 0]);
    if (getNestedValue(part, [0]) === "er" || (typeof errorCode === "number" && errorCode !== 0)) {
      throw new Error(
        `Gemini Web request failed${typeof errorCode === "number" ? ` (code ${errorCode})` : ""}.`,
      );
    }

    const payload = getNestedValue(part, [2]);
    if (typeof payload !== "string") continue;

    const parsed: unknown = JSON.parse(payload);
    const candidate = getNestedValue(parsed, [4, 0]);
    if (!Array.isArray(candidate)) continue;

    // Candidates are cumulative snapshots. Status 1 is streaming, while 2 is complete.
    completed = getNestedValue(candidate, [8, 0]) === 2;
    const text = getNestedValue(candidate, [1, 0]);
    const alternateText = getNestedValue(candidate, [22, 0]);
    answer =
      typeof text === "string" && text.trim()
        ? text
        : typeof alternateText === "string"
          ? alternateText
          : undefined;
  }

  if (!completed) throw new Error("Gemini Web response ended before generation completed.");
  const text = answer?.trim();
  if (!text) throw new Error("Gemini Web returned no assistant text.");
  return text;
}

function getNestedValue(value: unknown, path: number[]): unknown {
  let current: unknown = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}
