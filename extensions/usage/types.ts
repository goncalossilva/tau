import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type SupportedProviderId =
  | "openai-codex"
  | "anthropic"
  | "github-copilot"
  | "google-gemini-cli"
  | "openrouter"
  | "zai"
  | "minimax";

export interface LiveUsageMeter {
  kind: "meter";
  key: string;
  label: string;
  usedPercent: number;
  windowLabel?: string;
  resetDescription?: string;
  detail?: string;
}

export interface LiveUsageStat {
  kind: "stat";
  key: string;
  label: string;
  value: string;
  detail?: string;
}

export type LiveUsageItem = LiveUsageMeter | LiveUsageStat;

export interface LiveUsageSnapshot {
  plan?: string;
  fetchedAt: Date;
  items: LiveUsageItem[];
}

export type LiveUsageAvailability = { available: true } | { available: false; reason: string };

export interface UsageProviderDefinition {
  id: SupportedProviderId;
  label: string;
  shortLabel: string;
  color: RGB;
  getLiveUsageAvailability?(ctx: ExtensionContext): Promise<LiveUsageAvailability>;
  fetchLiveUsage(ctx: ExtensionContext, signal?: AbortSignal): Promise<LiveUsageSnapshot>;
}
