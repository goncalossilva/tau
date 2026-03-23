import type { BrowserCookie, BrowserSession, WebsearchResult } from "../types.js";
import { browserHeaders, buildCookieHeader, dedupeSources, extractMarkdownSources, hasCookie } from "../normalize.js";
import { buildWebsearchPrompt } from "./search-prompt.shared.js";
import { fetchText, withTimeout } from "./shared.js";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_GENERATE_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GOOGLE_LIST_ACCOUNTS_URL =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&laf=b64bin&json=standard";
const REQUIRED_COOKIE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

export const browserGemini = {
  backend: "gemini" as const,
  domains: ["google.com"],
  async search(session: BrowserSession, query: string, signal?: AbortSignal): Promise<WebsearchResult> {
    for (const cookieName of REQUIRED_COOKIE_NAMES) {
      if (!hasCookie(GEMINI_APP_URL, session.cookies, cookieName)) {
        throw new Error(`Missing required Google cookie: ${cookieName}`);
      }
    }

    const accessToken = await fetchAccessToken(session.cookies, signal);
    let accountLabel: string | null | undefined;
    void getActiveGoogleEmail(session.cookies, signal)
      .then((value) => {
        accountLabel = value;
      })
      .catch(() => {
        accountLabel = null;
      });

    const answer = await queryGemini(query, session.cookies, accessToken, signal);

    return {
      backend: "gemini",
      authSource: session.profile.family,
      browserName: session.profile.browserName,
      profile: session.profile.profileName,
      accountLabel: accountLabel ?? undefined,
      answer,
      sources: dedupeSources(extractMarkdownSources(answer)),
    };
  },
};

async function queryGemini(
  query: string,
  cookies: BrowserCookie[],
  accessToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = new URLSearchParams();
  body.set("at", accessToken);
  body.set("f.req", JSON.stringify([null, JSON.stringify([[buildWebsearchPrompt(query)], null, null])]));

  const rawText = await fetchText(GEMINI_STREAM_GENERATE_URL, {
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

  const parsed = parseGeminiResponse(rawText);
  if (!parsed.trim()) {
    throw new Error("Gemini Web returned an empty response.");
  }

  return parsed.trim();
}

async function fetchAccessToken(cookies: BrowserCookie[], signal?: AbortSignal): Promise<string> {
  const html = await fetchText(GEMINI_APP_URL, {
    headers: browserHeaders({
      cookieHeader: buildCookieHeader(GEMINI_APP_URL, cookies),
      origin: "https://gemini.google.com",
      referer: "https://gemini.google.com/",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
    signal: withTimeout(signal, 20_000),
  });

  for (const key of ["SNlM0e", "thykhd"]) {
    const match = html.match(new RegExp(`\"${key}\":\"([^\\\"]*)\"`));
    if (match?.[1]) return match[1];
  }

  throw new Error("Could not authenticate with Gemini Web.");
}

async function getActiveGoogleEmail(cookies: BrowserCookie[], signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetchText(GOOGLE_LIST_ACCOUNTS_URL, {
      headers: browserHeaders({
        cookieHeader: buildCookieHeader(GOOGLE_LIST_ACCOUNTS_URL, cookies),
        origin: "https://accounts.google.com",
        referer: "https://accounts.google.com/",
      }),
      signal: withTimeout(signal, 10_000),
    });

    return findFirstEmail(response);
  } catch {
    return null;
  }
}

function parseGeminiResponse(rawText: string): string {
  const start = rawText.indexOf("[");
  const end = rawText.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini Web returned an invalid payload.");
  }

  const responseJson = JSON.parse(rawText.slice(start, end + 1));
  const parts = Array.isArray(responseJson) ? responseJson : [];

  for (const part of parts) {
    const payload = getNestedValue(part, [2]);
    if (typeof payload !== "string") continue;

    try {
      const parsed = JSON.parse(payload);
      const candidateList = getNestedValue(parsed, [4]);
      const firstCandidate = Array.isArray(candidateList) ? candidateList[0] : undefined;
      const text = getNestedValue(firstCandidate, [1, 0]);
      if (typeof text === "string" && text.trim().length > 0) {
        return text;
      }

      const alternateText = getNestedValue(firstCandidate, [22, 0]);
      if (typeof alternateText === "string" && alternateText.trim().length > 0) {
        return alternateText;
      }
    } catch {
      // Ignore non-message chunks.
    }
  }

  throw new Error("Gemini Web returned no assistant text.");
}

function getNestedValue(value: unknown, path: number[]): unknown {
  let current: unknown = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function findFirstEmail(value: string): string | null {
  const normalized = value
    .replace(/\\u0040/gi, "@")
    .replace(/\\x40/gi, "@")
    .replace(/&#64;/gi, "@")
    .replace(/&commat;/gi, "@");
  const match = normalized.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match?.[0] ?? null;
}
