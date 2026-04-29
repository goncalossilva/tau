import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clampPercent,
  formatCurrency,
  formatPlan,
  formatWindowLabel,
  makeMeterItem,
  makeStatItem,
  parseEpochDate,
  readNumber,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SESSION_WINDOW_MINUTES = 5 * 60;
const WEEK_WINDOW_MINUTES = 7 * 24 * 60;

interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: Date;
}

function decodeWindow(value: unknown): UsageWindow | undefined {
  const input = value as Record<string, unknown> | null | undefined;
  const usedPercent = readNumber(input?.used_percent);
  const resetAt = readNumber(input?.reset_at);
  const windowSeconds = readNumber(input?.limit_window_seconds);
  if (usedPercent === undefined || windowSeconds === undefined) return undefined;

  return {
    usedPercent: clampPercent(usedPercent),
    windowMinutes: Math.round(windowSeconds / 60),
    resetsAt: parseEpochDate(resetAt),
  };
}

function windowRole(window: UsageWindow): "session" | "week" | "unknown" {
  if (window.windowMinutes === SESSION_WINDOW_MINUTES) return "session";
  if (window.windowMinutes === WEEK_WINDOW_MINUTES) return "week";
  return "unknown";
}

function normalizeWindows(
  primary?: UsageWindow,
  secondary?: UsageWindow,
): { session?: UsageWindow; week?: UsageWindow } {
  const windows = [primary, secondary];
  const normalized: { session?: UsageWindow; week?: UsageWindow } = {};

  for (const window of windows) {
    if (!window) continue;

    const role = windowRole(window);
    if (role === "session" && !normalized.session) {
      normalized.session = window;
      continue;
    }
    if (role === "week" && !normalized.week) {
      normalized.week = window;
    }
  }

  return normalized;
}

function makeWindowMeter(key: string, label: string, window: UsageWindow): LiveUsageItem {
  return makeMeterItem({
    key,
    label,
    usedPercent: window.usedPercent,
    windowLabel: formatWindowLabel(window.windowMinutes),
    resetsAt: window.resetsAt,
  });
}

function extractErrorMessage(status: number, bodyText: string): string {
  const defaultMessage = `OpenAI Codex usage request failed (${status}).`;
  if (status === 401 || status === 403) {
    return "OpenAI Codex login expired. Re-run /login.";
  }
  if (!bodyText.trim()) return defaultMessage;

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const errorMessage = readString(error?.message) ?? readString(parsed.message);
    const errorCode = readString(error?.code) ?? readString(error?.type);
    const resetsAt = readNumber(error?.resets_at);

    if (
      status === 429 ||
      errorCode === "usage_limit_reached" ||
      errorCode === "rate_limit_exceeded"
    ) {
      if (resetsAt !== undefined) {
        const mins = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
        return `OpenAI Codex usage limit reached. Try again in ~${mins}m.`;
      }
      return "OpenAI Codex usage limit reached.";
    }

    return errorMessage ? `${defaultMessage} ${errorMessage}` : defaultMessage;
  } catch {
    return `${defaultMessage} ${bodyText.trim()}`;
  }
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!apiKey) throw new Error("Not logged in to OpenAI Codex.");

  const credential = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
  const accountId =
    credential?.type === "oauth" && typeof credential.accountId === "string"
      ? credential.accountId
      : undefined;

  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "pi usage",
  });
  if (accountId) headers.set("ChatGPT-Account-Id", accountId);

  const response = await fetch(USAGE_URL, { headers, signal });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(extractErrorMessage(response.status, bodyText));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const rateLimit = payload.rate_limit as Record<string, unknown> | undefined;
  const credits = payload.credits as Record<string, unknown> | undefined;
  const { session, week } = normalizeWindows(
    decodeWindow(rateLimit?.primary_window),
    decodeWindow(rateLimit?.secondary_window),
  );

  const items: LiveUsageItem[] = [];
  if (session) items.push(makeWindowMeter("session", "Session", session));
  if (week) items.push(makeWindowMeter("week", "Week", week));

  const unlimitedCredits = credits?.unlimited === true;
  const creditBalance = readNumber(credits?.balance);
  if (unlimitedCredits) {
    items.push(makeStatItem({ key: "credits", label: "Credits", value: "Unlimited" }));
  } else if (creditBalance !== undefined) {
    items.push(
      makeStatItem({
        key: "credits",
        label: "Credits",
        value: formatCurrency(creditBalance),
        detail: credits?.has_credits === false ? "remaining" : undefined,
      }),
    );
  }

  if (items.length === 0) {
    throw new Error("OpenAI Codex did not return any session, weekly, or credit usage data.");
  }

  return {
    plan: formatPlan(readString(payload.plan_type)),
    fetchedAt: new Date(),
    items,
  };
}

const openAICodexProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "OpenAI Codex",
  shortLabel: "codex",
  color: { r: 73, g: 163, b: 176 },
  fetchLiveUsage: fetchUsage,
};

export default openAICodexProvider;
