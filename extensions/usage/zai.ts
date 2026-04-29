import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clampPercent,
  formatCount,
  formatPlan,
  formatWindowLabel,
  LiveUsageUnavailableError,
  makeMeterItem,
  parseEpochDate,
  readArray,
  readNumber,
  readObject,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "zai";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

type LimitType = "TIME_LIMIT" | "TOKENS_LIMIT";

interface LimitEntry {
  type: LimitType;
  windowMinutes?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  usedPercent: number;
  nextResetTime?: Date;
}

function windowMinutes(unit: number | undefined, count: number | undefined): number | undefined {
  if (!unit || !count || count <= 0) return undefined;
  switch (unit) {
    case 5:
      return count;
    case 3:
      return count * 60;
    case 1:
      return count * 24 * 60;
    case 6:
      return count * 7 * 24 * 60;
    default:
      return undefined;
  }
}

function parseLimitEntry(value: unknown): LimitEntry | undefined {
  const input = readObject(value);
  const rawType = readString(input?.type);
  if (rawType !== "TIME_LIMIT" && rawType !== "TOKENS_LIMIT") return undefined;

  const usage = readNumber(input?.usage);
  const currentValue = readNumber(input?.currentValue);
  const remaining = readNumber(input?.remaining);
  const explicitPercent = readNumber(input?.percentage);
  const resolvedWindowMinutes = windowMinutes(readNumber(input?.unit), readNumber(input?.number));
  const nextResetTime = parseEpochDate(readNumber(input?.nextResetTime));

  let usedPercent = explicitPercent;
  if ((usedPercent === undefined || usedPercent <= 0) && usage !== undefined && usage > 0) {
    if (remaining !== undefined) {
      usedPercent = ((usage - remaining) / usage) * 100;
    } else if (currentValue !== undefined) {
      usedPercent = (currentValue / usage) * 100;
    }
  }

  if (usedPercent === undefined) return undefined;

  return {
    type: rawType,
    windowMinutes: resolvedWindowMinutes,
    usage,
    currentValue,
    remaining,
    usedPercent: clampPercent(usedPercent),
    nextResetTime:
      nextResetTime && Number.isFinite(nextResetTime.getTime()) ? nextResetTime : undefined,
  };
}

function makeLimitMeter(key: string, label: string, entry: LimitEntry): LiveUsageItem {
  let detail: string | undefined;
  if (entry.usage !== undefined && entry.usage > 0 && entry.remaining !== undefined) {
    detail = `${formatCount(entry.remaining)} / ${formatCount(entry.usage)} remaining`;
  } else if (entry.usage !== undefined && entry.usage > 0 && entry.currentValue !== undefined) {
    detail = `${formatCount(entry.currentValue)} / ${formatCount(entry.usage)} used`;
  }

  if (!detail && entry.type === "TIME_LIMIT" && entry.windowMinutes) {
    const windowLabel = formatWindowLabel(entry.windowMinutes);
    if (windowLabel) detail = `${windowLabel} window`;
  }

  return makeMeterItem({
    key,
    label,
    usedPercent: entry.usedPercent,
    windowLabel: entry.type === "TOKENS_LIMIT" ? formatWindowLabel(entry.windowMinutes) : undefined,
    resetsAt: entry.nextResetTime,
    detail,
  });
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!apiKey) throw new LiveUsageUnavailableError("no auth configured");

  const response = await fetch(QUOTA_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("z.ai API key is invalid or expired.");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      bodyText.trim()
        ? `z.ai usage request failed (${response.status}): ${bodyText.trim()}`
        : `z.ai usage request failed (${response.status}).`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (payload.success !== true || readNumber(payload.code) !== 200) {
    throw new Error(readString(payload.msg) ?? "z.ai usage request failed.");
  }

  const data = readObject(payload.data);
  const rawLimits = readArray<unknown>(data?.limits);
  const limits = rawLimits
    .map(parseLimitEntry)
    .filter((entry): entry is LimitEntry => Boolean(entry));

  const tokenLimits = limits
    .filter((entry) => entry.type === "TOKENS_LIMIT")
    .sort(
      (left, right) =>
        (left.windowMinutes ?? Number.MAX_SAFE_INTEGER) -
        (right.windowMinutes ?? Number.MAX_SAFE_INTEGER),
    );
  const timeLimit = limits.find((entry) => entry.type === "TIME_LIMIT");

  const items: LiveUsageItem[] = [];
  const sessionTokenLimit = tokenLimits[0];
  const longTokenLimit = tokenLimits.length > 1 ? tokenLimits[tokenLimits.length - 1] : undefined;

  if (sessionTokenLimit) items.push(makeLimitMeter("session-tokens", "Tokens", sessionTokenLimit));
  if (longTokenLimit && longTokenLimit !== sessionTokenLimit) {
    items.push(makeLimitMeter("tokens", "Tokens", longTokenLimit));
  }
  if (timeLimit) items.push(makeLimitMeter("time", "Time", timeLimit));

  if (items.length === 0) {
    throw new Error("z.ai did not return any live quota data.");
  }

  return {
    plan: formatPlan(
      readString(data?.planName) ??
        readString(data?.plan) ??
        readString(data?.plan_type) ??
        readString(data?.packageName),
    ),
    fetchedAt: new Date(),
    items,
  };
}

const zaiProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "z.ai",
  shortLabel: "zai",
  color: { r: 232, g: 90, b: 106 },
  fetchLiveUsage: fetchUsage,
};

export default zaiProvider;
