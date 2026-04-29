import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clampPercent,
  formatCount,
  formatPlan,
  formatWindowLabel,
  HttpError,
  LiveUsageUnavailableError,
  makeMeterItem,
  parseEpochDate,
  readArray,
  readNumber,
  readObject,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "minimax";
const REMAINS_URLS = [
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
] as const;

function readNestedObject(
  input: Record<string, unknown> | undefined,
  ...keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = readObject(input?.[key]);
    if (value) return value;
  }
  return undefined;
}

function parsePlanName(data: Record<string, unknown> | undefined): string | undefined {
  const comboCard = readObject(data?.current_combo_card);
  return [
    readString(data?.current_subscribe_title),
    readString(data?.plan_name),
    readString(data?.combo_title),
    readString(data?.current_plan_title),
    readString(comboCard?.title),
  ].find(Boolean);
}

function makeUsageMeter(
  totalPrompts: number | undefined,
  usedPrompts: number | undefined,
  windowMinutes: number | undefined,
  resetsAt: Date | undefined,
): LiveUsageItem {
  const remainingPrompts =
    totalPrompts !== undefined && usedPrompts !== undefined
      ? Math.max(0, totalPrompts - usedPrompts)
      : undefined;
  const usedPercent =
    totalPrompts !== undefined && totalPrompts > 0 && usedPrompts !== undefined
      ? clampPercent((usedPrompts / totalPrompts) * 100)
      : 0;

  return makeMeterItem({
    key: "prompts",
    label: "Prompts",
    usedPercent,
    windowLabel: formatWindowLabel(windowMinutes),
    resetsAt,
    detail:
      totalPrompts !== undefined && totalPrompts > 0 && remainingPrompts !== undefined
        ? `${formatCount(remainingPrompts)} / ${formatCount(totalPrompts)} remaining`
        : undefined,
  });
}

async function fetchPayload(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "Content-Type": "application/json",
      "MM-API-Source": "pi usage",
    },
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(response.status, `MiniMax usage request failed (${response.status}).`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      bodyText.trim()
        ? `MiniMax usage request failed (${response.status}): ${bodyText.trim()}`
        : `MiniMax usage request failed (${response.status}).`,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

function parseUsageSnapshot(payload: Record<string, unknown>): {
  planName?: string;
  totalPrompts?: number;
  usedPrompts?: number;
  windowMinutes?: number;
  resetsAt?: Date;
} {
  const data = readNestedObject(payload, "data") ?? payload;
  const baseResp = readNestedObject(data, "base_resp") ?? readNestedObject(payload, "base_resp");
  const statusCode = readNumber(baseResp?.status_code);
  const statusMessage = readString(baseResp?.status_msg);

  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(statusMessage ?? `status_code ${statusCode}`);
  }

  const modelRemains = readArray<Record<string, unknown>>(data.model_remains ?? data.modelRemains);
  const first = modelRemains[0];
  if (!first) {
    throw new Error("MiniMax did not return any coding plan quota data.");
  }

  const totalPrompts = readNumber(
    first.current_interval_total_count ?? first.currentIntervalTotalCount,
  );
  const usedPrompts = readNumber(
    first.current_interval_usage_count ?? first.currentIntervalUsageCount,
  );
  const startTime = parseEpochDate(readNumber(first.start_time ?? first.startTime));
  const endTime = parseEpochDate(readNumber(first.end_time ?? first.endTime));
  const remainsTime = readNumber(first.remains_time ?? first.remainsTime);

  const windowMinutes =
    startTime && endTime
      ? Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 60_000))
      : undefined;
  const resetsAt =
    endTime && endTime.getTime() > Date.now()
      ? endTime
      : remainsTime !== undefined && remainsTime > 0
        ? new Date(Date.now() + (remainsTime > 1_000_000_000 ? remainsTime : remainsTime * 1000))
        : undefined;

  return {
    planName: parsePlanName(data),
    totalPrompts,
    usedPrompts,
    windowMinutes: windowMinutes && windowMinutes > 0 ? windowMinutes : undefined,
    resetsAt,
  };
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!apiKey) throw new LiveUsageUnavailableError("no auth configured");

  let payload: Record<string, unknown> | undefined;
  let lastError: unknown;

  for (const url of REMAINS_URLS) {
    try {
      payload = await fetchPayload(url, apiKey, signal);
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
    }
  }

  if (!payload) {
    if (lastError instanceof HttpError && (lastError.status === 401 || lastError.status === 403)) {
      throw new Error("MiniMax API key is invalid or expired.");
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const snapshot = parseUsageSnapshot(payload);

  return {
    plan: formatPlan(snapshot.planName),
    fetchedAt: new Date(),
    items: [
      makeUsageMeter(
        snapshot.totalPrompts,
        snapshot.usedPrompts,
        snapshot.windowMinutes,
        snapshot.resetsAt,
      ),
    ],
  };
}

const minimaxProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "MiniMax",
  shortLabel: "mini",
  color: { r: 254, g: 96, b: 60 },
  fetchLiveUsage: fetchUsage,
};

export default minimaxProvider;
