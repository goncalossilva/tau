import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  formatCurrency,
  HttpError,
  LiveUsageUnavailableError,
  makeMeterItem,
  makeStatItem,
  readNumber,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "openrouter";
const API_BASE_URL = "https://openrouter.ai/api/v1";

interface CreditsPayload {
  data?: {
    total_credits?: unknown;
    total_usage?: unknown;
  };
}

interface KeyPayload {
  data?: {
    limit?: unknown;
    usage?: unknown;
    rate_limit?: {
      requests?: unknown;
      interval?: unknown;
    };
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchJson(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "X-Title": "pi usage",
    },
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(response.status, "OpenRouter API key is invalid or expired.");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new HttpError(
      response.status,
      bodyText.trim()
        ? `OpenRouter usage request failed (${response.status}): ${bodyText.trim()}`
        : `OpenRouter usage request failed (${response.status}).`,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!apiKey) throw new LiveUsageUnavailableError("no auth configured");

  const [creditsResult, keyResult] = await Promise.allSettled([
    fetchJson(`${API_BASE_URL}/credits`, apiKey, signal),
    fetchJson(`${API_BASE_URL}/key`, apiKey, signal),
  ]);

  if (creditsResult.status === "rejected") {
    throw creditsResult.reason;
  }

  const creditsPayload = creditsResult.value as CreditsPayload;
  let keyPayload: KeyPayload | undefined;
  if (keyResult.status === "fulfilled") {
    keyPayload = keyResult.value as KeyPayload;
  } else if (isAbortError(keyResult.reason)) {
    throw keyResult.reason;
  } else if (
    !(keyResult.reason instanceof HttpError) ||
    (keyResult.reason.status !== 403 &&
      keyResult.reason.status !== 404 &&
      keyResult.reason.status !== 405)
  ) {
    throw keyResult.reason;
  }

  const totalCredits = readNumber(creditsPayload.data?.total_credits) ?? 0;
  const totalUsage = readNumber(creditsPayload.data?.total_usage) ?? 0;
  const balance = Math.max(0, totalCredits - totalUsage);

  const keyLimit = readNumber(keyPayload?.data?.limit);
  const keyUsage = readNumber(keyPayload?.data?.usage);
  const rateLimitRequests = readNumber(keyPayload?.data?.rate_limit?.requests);
  const rateLimitInterval = readString(keyPayload?.data?.rate_limit?.interval);

  const items: LiveUsageItem[] = [];
  if (totalCredits > 0) {
    items.push(
      makeMeterItem({
        key: "credits",
        label: "Credits",
        usedPercent: totalCredits > 0 ? (totalUsage / totalCredits) * 100 : 0,
        detail: `${formatCurrency(balance)} / ${formatCurrency(totalCredits)} remaining`,
      }),
    );
  } else {
    items.push(
      makeStatItem({
        key: "balance",
        label: "Balance",
        value: formatCurrency(balance),
        detail: totalUsage > 0 ? `${formatCurrency(totalUsage)} used` : undefined,
      }),
    );
  }

  if (keyLimit !== undefined && keyLimit > 0 && keyUsage !== undefined && keyUsage >= 0) {
    const keyRemaining = Math.max(0, keyLimit - keyUsage);
    items.push(
      makeMeterItem({
        key: "key-quota",
        label: "Key quota",
        usedPercent: keyLimit > 0 ? (keyUsage / keyLimit) * 100 : 0,
        detail: `${formatCurrency(keyRemaining)} / ${formatCurrency(keyLimit)} remaining`,
      }),
    );
  }

  if (rateLimitRequests !== undefined && rateLimitInterval) {
    items.push(
      makeStatItem({
        key: "rate-limit",
        label: "Rate limit",
        value: `${Math.round(rateLimitRequests)} / ${rateLimitInterval}`,
      }),
    );
  }

  if (items.length === 0) {
    throw new Error("OpenRouter did not return any live usage data.");
  }

  return {
    fetchedAt: new Date(),
    items,
  };
}

const openRouterProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "OpenRouter",
  shortLabel: "router",
  color: { r: 100, g: 103, b: 242 },
  fetchLiveUsage: fetchUsage,
};

export default openRouterProvider;
