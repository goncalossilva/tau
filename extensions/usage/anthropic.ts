import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clampPercent,
  formatCurrency,
  formatPlan,
  formatWindowLabel,
  LiveUsageUnavailableError,
  makeMeterItem,
  parseISODate,
  readNumber,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "anthropic";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";
const SESSION_WINDOW_MINUTES = 5 * 60;
const WEEK_WINDOW_MINUTES = 7 * 24 * 60;

interface UsageWindow {
  usedPercent: number;
  resetsAt?: Date;
}

function makeWindowMeter(
  key: string,
  label: string,
  window: UsageWindow,
  windowMinutes: number,
): LiveUsageItem {
  return makeMeterItem({
    key,
    label,
    usedPercent: window.usedPercent,
    windowLabel: formatWindowLabel(windowMinutes),
    resetsAt: window.resetsAt,
  });
}

function parseWindow(value: unknown): UsageWindow | undefined {
  const input = value as Record<string, unknown> | null | undefined;
  const utilization = readNumber(input?.utilization);
  if (utilization === undefined) return undefined;

  const resetsAt = parseISODate(readString(input?.resets_at));
  return {
    usedPercent: clampPercent(utilization),
    resetsAt,
  };
}

function parseExtraUsage(value: unknown): LiveUsageItem | undefined {
  const input = value as Record<string, unknown> | null | undefined;
  if (!input || input.is_enabled !== true) return undefined;

  const monthlyLimitMinor = readNumber(input.monthly_limit);
  const usedCreditsMinor = readNumber(input.used_credits);
  const utilization = readNumber(input.utilization);
  const currency = readString(input.currency) ?? "USD";

  if (
    monthlyLimitMinor === undefined &&
    usedCreditsMinor === undefined &&
    utilization === undefined
  ) {
    return undefined;
  }

  const usedMajor = (usedCreditsMinor ?? 0) / 100;
  const limitMajor = (monthlyLimitMinor ?? 0) / 100;
  const usedPercent = clampPercent(
    utilization ??
      (monthlyLimitMinor && monthlyLimitMinor > 0
        ? ((usedCreditsMinor ?? 0) / monthlyLimitMinor) * 100
        : 0),
  );

  let detail: string | undefined;
  if (monthlyLimitMinor !== undefined && monthlyLimitMinor > 0) {
    detail = `${formatCurrency(usedMajor, currency)} / ${formatCurrency(limitMajor, currency)} used · monthly`;
  }

  return makeMeterItem({
    key: "extra-usage",
    label: "Extra usage",
    usedPercent,
    detail,
  });
}

function extractErrorMessage(status: number, bodyText: string): string {
  const defaultMessage = `Claude usage request failed (${status}).`;
  if (status === 401 || status === 403) {
    return "Claude login expired. Re-run /login anthropic.";
  }
  if (!bodyText.trim()) return defaultMessage;

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const message = readString(error?.message) ?? readString(parsed.message);
    return message ? `${defaultMessage} ${message}` : defaultMessage;
  } catch {
    return `${defaultMessage} ${bodyText.trim()}`;
  }
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!token) throw new LiveUsageUnavailableError("no auth configured");

  const credential = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
  if (credential?.type === "api_key") {
    throw new LiveUsageUnavailableError("API-key auth does not expose Claude subscription quota");
  }

  const response = await fetch(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": BETA_HEADER,
      "User-Agent": USER_AGENT,
    },
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(extractErrorMessage(response.status, bodyText));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const fiveHour = parseWindow(payload.five_hour);
  const sevenDay = parseWindow(payload.seven_day);
  const sevenDaySonnet = parseWindow(payload.seven_day_sonnet);
  const sevenDayOpus = parseWindow(payload.seven_day_opus);
  const sevenDayOAuthApps = parseWindow(payload.seven_day_oauth_apps);

  const items: LiveUsageItem[] = [];
  if (fiveHour) items.push(makeWindowMeter("session", "Session", fiveHour, SESSION_WINDOW_MINUTES));
  if (sevenDay) items.push(makeWindowMeter("week", "Week", sevenDay, WEEK_WINDOW_MINUTES));
  if (sevenDaySonnet) {
    items.push(makeWindowMeter("sonnet", "Sonnet", sevenDaySonnet, WEEK_WINDOW_MINUTES));
  } else if (sevenDayOpus) {
    items.push(makeWindowMeter("opus", "Opus", sevenDayOpus, WEEK_WINDOW_MINUTES));
  } else if (sevenDayOAuthApps) {
    items.push(makeWindowMeter("apps", "Apps", sevenDayOAuthApps, WEEK_WINDOW_MINUTES));
  }

  const extraUsage = parseExtraUsage(payload.extra_usage);
  if (extraUsage) items.push(extraUsage);

  if (items.length === 0) {
    throw new Error("Claude did not return any live quota data.");
  }

  const rateLimitTier =
    credential?.type === "oauth" && typeof credential.rateLimitTier === "string"
      ? credential.rateLimitTier
      : undefined;

  return {
    plan: formatPlan(rateLimitTier),
    fetchedAt: new Date(),
    items,
  };
}

async function getLiveUsageAvailability(ctx: ExtensionContext) {
  if (!ctx.modelRegistry.authStorage.hasAuth(PROVIDER_ID)) {
    return { available: false as const, reason: "no auth configured" };
  }

  const credential = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
  if (credential?.type === "oauth") {
    return { available: true as const };
  }

  return {
    available: false as const,
    reason: "API-key auth does not expose Claude subscription quota",
  };
}

const anthropicProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "Claude",
  shortLabel: "claude",
  color: { r: 204, g: 124, b: 94 },
  getLiveUsageAvailability,
  fetchLiveUsage: fetchUsage,
};

export default anthropicProvider;
