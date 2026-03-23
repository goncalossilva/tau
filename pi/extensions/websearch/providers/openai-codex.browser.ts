import type { BrowserSession, WebsearchResult } from "../types.js";
import { browserHeaders, buildCookieHeader } from "../normalize.js";
import { fetchJson, withTimeout } from "./shared.js";
import { decodeJwtAccountId, runOpenAICodexSearch } from "./openai-codex.shared.js";

const CHATGPT_BASE_URL = "https://chatgpt.com";
const SESSION_URL = `${CHATGPT_BASE_URL}/api/auth/session`;
const PREFERRED_MODELS = ["gpt-5.4", "gpt-5.3-codex-spark", "gpt-5.1-codex-mini"];

interface ChatGptSessionPayload {
  accessToken?: string;
  user?: {
    email?: string;
    name?: string;
  };
}

export const browserOpenAICodex = {
  backend: "openai-codex" as const,
  domains: ["chatgpt.com"],
  async search(session: BrowserSession, query: string, signal?: AbortSignal): Promise<WebsearchResult> {
    const cookieHeader = buildCookieHeader(SESSION_URL, session.cookies);
    if (!cookieHeader) {
      throw new Error("No ChatGPT session cookies found in browser profile.");
    }

    const chatSession = await fetchJson<ChatGptSessionPayload>(SESSION_URL, {
      headers: browserHeaders({
        cookieHeader,
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
      }),
      signal: withTimeout(signal, 20_000),
    });

    if (!chatSession.accessToken) {
      throw new Error("No ChatGPT access token found in session.");
    }

    const result = await searchWithPreferredModel(chatSession.accessToken, query, signal);

    return {
      backend: "openai-codex",
      authSource: session.profile.family,
      browserName: session.profile.browserName,
      profile: session.profile.profileName,
      accountLabel: chatSession.user?.email ?? chatSession.user?.name,
      answer: result.answer,
      sources: result.sources,
    };
  },
};

async function searchWithPreferredModel(accessToken: string, query: string, signal?: AbortSignal) {
  let lastError: string | null = null;

  for (const model of PREFERRED_MODELS) {
    try {
      return await runOpenAICodexSearch({
        apiKey: accessToken,
        accountId: decodeJwtAccountId(accessToken),
        model,
        query,
        baseUrl: `${CHATGPT_BASE_URL}/backend-api`,
        signal,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError ?? "ChatGPT Codex search failed.");
}
