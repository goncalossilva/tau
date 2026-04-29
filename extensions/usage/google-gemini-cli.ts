import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clampPercent,
  LiveUsageUnavailableError,
  makeMeterItem,
  parseISODate,
  readArray,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "google-gemini-cli";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

type GeminiTier = "free-tier" | "legacy-tier" | "standard-tier";

interface GeminiAuthPayload {
  token?: string;
  projectId?: string;
}

interface GeminiQuota {
  modelId: string;
  percentLeft: number;
  resetTime?: Date;
}

function readAuthPayload(value: string): GeminiAuthPayload {
  try {
    return JSON.parse(value) as GeminiAuthPayload;
  } catch {
    throw new LiveUsageUnavailableError("Gemini CLI OAuth login is required for live quota data");
  }
}

function parsePlan(tier: GeminiTier | undefined): string | undefined {
  switch (tier) {
    case "standard-tier":
      return "Paid";
    case "free-tier":
      return "Free";
    case "legacy-tier":
      return "Legacy";
    default:
      return undefined;
  }
}

function parseModelLabel(modelId: string): string {
  const value = modelId.trim();
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

function isFlashLiteModel(id: string): boolean {
  return id.includes("flash-lite");
}

function isFlashModel(id: string): boolean {
  return id.includes("flash") && !isFlashLiteModel(id);
}

function isProModel(id: string): boolean {
  return id.includes("pro");
}

function makeMeter(key: string, label: string, quota: GeminiQuota): LiveUsageItem {
  return makeMeterItem({
    key,
    label,
    usedPercent: clampPercent(100 - quota.percentLeft),
    windowLabel: "24h",
    resetsAt: quota.resetTime,
  });
}

async function fetchJson(
  url: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini CLI login expired. Re-run /login google-gemini-cli.");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      bodyText.trim()
        ? `Gemini usage request failed (${response.status}): ${bodyText.trim()}`
        : `Gemini usage request failed (${response.status}).`,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

async function loadCodeAssistStatus(
  token: string,
  signal?: AbortSignal,
): Promise<{ tier?: GeminiTier }> {
  try {
    const payload = await fetchJson(
      LOAD_CODE_ASSIST_URL,
      token,
      { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } },
      signal,
    );

    const currentTier = payload.currentTier as Record<string, unknown> | undefined;
    const tierId = readString(currentTier?.id);

    return {
      tier:
        tierId === "free-tier" || tierId === "legacy-tier" || tierId === "standard-tier"
          ? tierId
          : undefined,
    };
  } catch {
    return {};
  }
}

function parseQuotas(payload: Record<string, unknown>): GeminiQuota[] {
  const buckets = readArray<Record<string, unknown>>(payload.buckets);
  const quotaByModel = new Map<string, GeminiQuota>();

  for (const bucket of buckets) {
    const input = bucket as Record<string, unknown> | null | undefined;
    const modelId = readString(input?.modelId);
    const remainingFraction =
      typeof input?.remainingFraction === "number" ? input.remainingFraction : undefined;
    if (!modelId || remainingFraction === undefined) continue;

    const percentLeft = clampPercent(remainingFraction * 100);
    const resetTime = parseISODate(readString(input?.resetTime));
    const quota: GeminiQuota = {
      modelId,
      percentLeft,
      resetTime,
    };

    const existing = quotaByModel.get(modelId);
    if (!existing || quota.percentLeft < existing.percentLeft) {
      quotaByModel.set(modelId, quota);
    }
  }

  return [...quotaByModel.values()].sort((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
}

function buildItems(quotas: GeminiQuota[]): LiveUsageItem[] {
  const lower = quotas.map((quota) => ({ quota, modelId: quota.modelId.toLowerCase() }));
  const pro = lower.filter((entry) => isProModel(entry.modelId)).map((entry) => entry.quota);
  const flash = lower.filter((entry) => isFlashModel(entry.modelId)).map((entry) => entry.quota);
  const flashLite = lower
    .filter((entry) => isFlashLiteModel(entry.modelId))
    .map((entry) => entry.quota);

  const items: LiveUsageItem[] = [];
  const proMin = pro.sort((left, right) => left.percentLeft - right.percentLeft)[0];
  const flashMin = flash.sort((left, right) => left.percentLeft - right.percentLeft)[0];
  const flashLiteMin = flashLite.sort((left, right) => left.percentLeft - right.percentLeft)[0];

  if (proMin) items.push(makeMeter("pro", "Pro", proMin));
  if (flashMin) items.push(makeMeter("flash", "Flash", flashMin));
  if (flashLiteMin) items.push(makeMeter("flash-lite", "Flash Lite", flashLiteMin));

  if (items.length > 0) return items;

  for (const quota of quotas.slice(0, 3)) {
    items.push(makeMeter(quota.modelId, parseModelLabel(quota.modelId), quota));
  }
  return items;
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!apiKey) throw new LiveUsageUnavailableError("no auth configured");

  const auth = readAuthPayload(apiKey);
  const token = typeof auth.token === "string" ? auth.token.trim() : "";
  if (!token) {
    throw new LiveUsageUnavailableError("Gemini CLI OAuth login is required for live quota data");
  }

  const authProjectId = typeof auth.projectId === "string" ? auth.projectId.trim() : undefined;
  const statusPromise = loadCodeAssistStatus(token, signal);
  const quotaPromise = fetchJson(
    QUOTA_URL,
    token,
    authProjectId ? { project: authProjectId } : {},
    signal,
  );

  const [status, quotaPayload] = await Promise.all([statusPromise, quotaPromise]);
  const quotas = parseQuotas(quotaPayload);

  if (quotas.length === 0) {
    throw new Error("Gemini did not return any live quota data.");
  }

  return {
    plan: parsePlan(status.tier),
    fetchedAt: new Date(),
    items: buildItems(quotas),
  };
}

const googleGeminiCliProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "Gemini CLI",
  shortLabel: "gemini",
  color: { r: 171, g: 135, b: 234 },
  fetchLiveUsage: fetchUsage,
};

export default googleGeminiCliProvider;
