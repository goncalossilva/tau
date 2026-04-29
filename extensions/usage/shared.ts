import type { LiveUsageMeter, LiveUsageStat } from "./types.js";

export class LiveUsageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveUsageUnavailableError";
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isLiveUsageUnavailableError(error: unknown): error is LiveUsageUnavailableError {
  return error instanceof LiveUsageUnavailableError;
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPlan(plan?: string): string | undefined {
  if (!plan) return undefined;
  return plan
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatCurrency(value: number, currency = "USD"): string {
  if (!Number.isFinite(value)) value = 0;

  const minimumFractionDigits = Math.abs(value) >= 1 ? 2 : 4;
  const maximumFractionDigits = Math.abs(value) >= 1_000 ? 2 : minimumFractionDigits;

  return value.toLocaleString("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits,
    maximumFractionDigits,
  });
}

export function parseISODate(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function parseEpochDate(value: number | undefined): Date | undefined {
  if (value === undefined) return undefined;

  const epoch = value > 1_000_000_000_000 ? value : value * 1000;
  const parsed = new Date(epoch);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function formatRelativeResetDescription(resetsAt?: Date): string | undefined {
  if (!resetsAt) return undefined;

  const deltaMs = resetsAt.getTime() - Date.now();
  if (deltaMs <= 0) return "reset imminent";

  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `resets in ~${minutes}m`;

  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 48) return `resets in ~${hours}h`;

  const days = Math.round(deltaMs / 86_400_000);
  return `resets in ~${days}d`;
}

export function formatWindowLabel(windowMinutes?: number): string | undefined {
  if (!windowMinutes || windowMinutes <= 0) return undefined;
  if (windowMinutes % (24 * 60) === 0) return `${windowMinutes / (24 * 60)}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

export function formatUsedPercent(usedPercent: number): string {
  return `${Math.round(clampPercent(usedPercent))}% used`;
}

export function makeMeterItem(options: {
  key: string;
  label: string;
  usedPercent: number;
  windowLabel?: string;
  resetsAt?: Date;
  resetDescription?: string;
  detail?: string;
}): LiveUsageMeter {
  const usedPercent = clampPercent(options.usedPercent);
  return {
    kind: "meter",
    key: options.key,
    label: options.label,
    usedPercent,
    windowLabel: options.windowLabel,
    resetDescription: options.resetDescription ?? formatRelativeResetDescription(options.resetsAt),
    detail: options.detail,
  };
}

export function makeStatItem(options: {
  key: string;
  label: string;
  value: string;
  detail?: string;
}): LiveUsageStat {
  return {
    kind: "stat",
    key: options.key,
    label: options.label,
    value: options.value,
    detail: options.detail,
  };
}
