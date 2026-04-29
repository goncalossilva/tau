import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clampPercent,
  formatCount,
  formatPlan,
  makeMeterItem,
  parseISODate,
  readNumber,
  readString,
} from "./shared.js";
import type { LiveUsageItem, LiveUsageSnapshot, UsageProviderDefinition } from "./types.js";

const PROVIDER_ID = "github-copilot";

interface QuotaSnapshot {
  entitlement: number;
  remaining: number;
  percentRemaining: number;
}

function normalizeDomain(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

function parseQuotaSnapshot(value: unknown): QuotaSnapshot | undefined {
  const input = value as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== "object") return undefined;

  const entitlement = readNumber(input.entitlement) ?? 0;
  const remaining = readNumber(input.remaining) ?? 0;
  const explicitPercent = readNumber(input.percent_remaining);
  const derivedPercent = entitlement > 0 ? (remaining / entitlement) * 100 : undefined;
  const percentRemaining = explicitPercent ?? derivedPercent ?? 0;
  const quotaId = readString(input.quota_id) ?? "";

  if (explicitPercent === undefined && derivedPercent === undefined) return undefined;
  if (entitlement === 0 && remaining === 0 && percentRemaining === 0 && !quotaId) return undefined;

  return {
    entitlement,
    remaining,
    percentRemaining: clampPercent(percentRemaining),
  };
}

function parseQuotaSnapshots(payload: Record<string, unknown>): {
  premiumInteractions?: QuotaSnapshot;
  chat?: QuotaSnapshot;
} {
  const quotaSnapshots = payload.quota_snapshots as Record<string, unknown> | undefined;
  let premiumInteractions = parseQuotaSnapshot(quotaSnapshots?.premium_interactions);
  let chat = parseQuotaSnapshot(quotaSnapshots?.chat);

  if ((!premiumInteractions || !chat) && quotaSnapshots && typeof quotaSnapshots === "object") {
    let firstUsable: QuotaSnapshot | undefined;
    for (const [key, rawValue] of Object.entries(quotaSnapshots)) {
      const snapshot = parseQuotaSnapshot(rawValue);
      if (!snapshot) continue;
      const lowerKey = key.toLowerCase();
      if (!firstUsable) firstUsable = snapshot;
      if (!chat && lowerKey.includes("chat")) {
        chat = snapshot;
        continue;
      }
      if (
        !premiumInteractions &&
        (lowerKey.includes("premium") ||
          lowerKey.includes("completion") ||
          lowerKey.includes("code"))
      ) {
        premiumInteractions = snapshot;
      }
    }
    if (!premiumInteractions && !chat) chat = firstUsable;
  }

  const monthlyQuotas = payload.monthly_quotas as Record<string, unknown> | undefined;
  const limitedUserQuotas = payload.limited_user_quotas as Record<string, unknown> | undefined;

  if (!premiumInteractions) {
    const entitlement = readNumber(monthlyQuotas?.completions);
    const remaining = readNumber(limitedUserQuotas?.completions);
    if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
      premiumInteractions = {
        entitlement,
        remaining,
        percentRemaining: clampPercent((remaining / entitlement) * 100),
      };
    }
  }

  if (!chat) {
    const entitlement = readNumber(monthlyQuotas?.chat);
    const remaining = readNumber(limitedUserQuotas?.chat);
    if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
      chat = {
        entitlement,
        remaining,
        percentRemaining: clampPercent((remaining / entitlement) * 100),
      };
    }
  }

  return { premiumInteractions, chat };
}

function makeQuotaMeter(
  key: string,
  label: string,
  quota: QuotaSnapshot,
  resetsAt?: Date,
): LiveUsageItem {
  const usedPercent = clampPercent(100 - quota.percentRemaining);
  return makeMeterItem({
    key,
    label,
    usedPercent,
    resetsAt,
    detail:
      quota.entitlement > 0
        ? `${formatCount(quota.remaining)} / ${formatCount(quota.entitlement)} remaining`
        : undefined,
  });
}

function buildUsageUrl(enterpriseUrl?: string): string {
  const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : undefined;
  const host = domain && domain !== "github.com" ? `api.${domain}` : "api.github.com";
  return `https://${host}/copilot_internal/user`;
}

async function fetchUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot> {
  const credential = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
  if (
    credential?.type !== "oauth" ||
    typeof credential.refresh !== "string" ||
    !credential.refresh.trim()
  ) {
    throw new Error("Not logged in to GitHub Copilot.");
  }

  const enterpriseUrl =
    typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : undefined;
  const response = await fetch(buildUsageUrl(enterpriseUrl), {
    method: "GET",
    headers: {
      Authorization: `token ${credential.refresh}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "X-Github-Api-Version": "2025-04-01",
    },
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub Copilot login expired. Re-run /login.");
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      bodyText.trim()
        ? `GitHub Copilot usage request failed (${response.status}): ${bodyText.trim()}`
        : `GitHub Copilot usage request failed (${response.status}).`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const { premiumInteractions, chat } = parseQuotaSnapshots(payload);
  const resetsAt = parseISODate(readString(payload.quota_reset_date));

  const items: LiveUsageItem[] = [];
  if (premiumInteractions)
    items.push(makeQuotaMeter("premium", "Premium", premiumInteractions, resetsAt));
  if (chat) items.push(makeQuotaMeter("chat", "Chat", chat, resetsAt));

  if (items.length === 0) {
    throw new Error("GitHub Copilot did not return premium or chat quota data.");
  }

  return {
    plan: formatPlan(readString(payload.copilot_plan)),
    fetchedAt: new Date(),
    items,
  };
}

const githubCopilotProvider: UsageProviderDefinition = {
  id: PROVIDER_ID,
  label: "GitHub Copilot",
  shortLabel: "copilot",
  color: { r: 168, g: 85, b: 247 },
  fetchLiveUsage: fetchUsage,
};

export default githubCopilotProvider;
