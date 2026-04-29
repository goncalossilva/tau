import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { getSupportedProvider, SUPPORTED_PROVIDERS } from "./providers.js";
import {
  formatCount,
  formatUsedPercent,
  isLiveUsageUnavailableError,
  readNumber,
} from "./shared.js";
import type {
  LiveUsageAvailability,
  LiveUsageItem,
  LiveUsageMeter,
  LiveUsageSnapshot,
  RGB,
  SupportedProviderId,
  UsageProviderDefinition,
} from "./types.js";

const ALL_TAB_ID = "all";
const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const RANGE_DAYS = [7, 30, 90] as const;
const FILE_PARSE_CONCURRENCY = 16;

const DOW_NAMES: DowKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TOD_BUCKETS: { key: TodKey; label: string; from: number; to: number }[] = [
  { key: "after-midnight", label: "After midnight (0–5)", from: 0, to: 5 },
  { key: "morning", label: "Morning (6–11)", from: 6, to: 11 },
  { key: "afternoon", label: "Afternoon (12–16)", from: 12, to: 16 },
  { key: "evening", label: "Evening (17–21)", from: 17, to: 21 },
  { key: "night", label: "Night (22–23)", from: 22, to: 23 },
];

const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };
const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };
const ERROR_COLOR: RGB = { r: 244, g: 67, b: 54 };
const MUTED_COLOR: RGB = { r: 160, g: 160, b: 160 };

const PALETTE: RGB[] = [
  { r: 54, g: 179, b: 166 },
  { r: 82, g: 146, b: 247 },
  { r: 171, g: 123, b: 245 },
  { r: 232, g: 180, b: 72 },
  { r: 244, g: 67, b: 54 },
];

const DOW_PALETTE: RGB[] = [
  { r: 47, g: 129, b: 247 },
  { r: 64, g: 196, b: 99 },
  { r: 163, g: 113, b: 247 },
  { r: 47, g: 175, b: 200 },
  { r: 100, g: 200, b: 150 },
  { r: 255, g: 159, b: 10 },
  { r: 244, g: 67, b: 54 },
];

const TOD_PALETTE: Map<TodKey, RGB> = new Map([
  ["after-midnight", { r: 100, g: 60, b: 180 }],
  ["morning", { r: 255, g: 200, b: 50 }],
  ["afternoon", { r: 64, g: 196, b: 99 }],
  ["evening", { r: 47, g: 129, b: 247 }],
  ["night", { r: 60, g: 40, b: 140 }],
]);

type HistoryProviderId = string;
type ModelKey = string;
type CwdKey = string;
type DowKey = string;
type TodKey = string;
type MeasurementMode = "sessions" | "messages" | "tokens";
type BreakdownView = "model" | "cwd" | "dow" | "tod";

type LiveUsageState =
  | { status: "loading" }
  | { status: "ok"; snapshot: LiveUsageSnapshot }
  | { status: "error"; error: string }
  | { status: "unavailable"; reason: string };

interface ParsedSessionBase {
  startedAt: Date;
  dayKeyLocal: string;
  cwd: CwdKey | null;
  dow: DowKey;
  tod: TodKey;
  modelsUsed: Set<ModelKey>;
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
}

interface ParsedAllSession extends ParsedSessionBase {}

interface ParsedProviderSession extends ParsedSessionBase {
  provider: HistoryProviderId;
}

interface ParsedHistoricalFile {
  all: ParsedAllSession | null;
  providers: ParsedProviderSession[];
}

interface DayAgg {
  date: Date;
  dayKeyLocal: string;
  sessions: number;
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  sessionsByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
  sessionsByCwd: Map<CwdKey, number>;
  messagesByCwd: Map<CwdKey, number>;
  tokensByCwd: Map<CwdKey, number>;
  costByCwd: Map<CwdKey, number>;
  sessionsByTod: Map<TodKey, number>;
  messagesByTod: Map<TodKey, number>;
  tokensByTod: Map<TodKey, number>;
  costByTod: Map<TodKey, number>;
}

interface RangeAgg {
  days: DayAgg[];
  dayByKey: Map<string, DayAgg>;
  sessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  modelCost: Map<ModelKey, number>;
  modelSessions: Map<ModelKey, number>;
  modelMessages: Map<ModelKey, number>;
  modelTokens: Map<ModelKey, number>;
  cwdCost: Map<CwdKey, number>;
  cwdSessions: Map<CwdKey, number>;
  cwdMessages: Map<CwdKey, number>;
  cwdTokens: Map<CwdKey, number>;
  dowCost: Map<DowKey, number>;
  dowSessions: Map<DowKey, number>;
  dowMessages: Map<DowKey, number>;
  dowTokens: Map<DowKey, number>;
  todCost: Map<TodKey, number>;
  todSessions: Map<TodKey, number>;
  todMessages: Map<TodKey, number>;
  todTokens: Map<TodKey, number>;
}

interface ProviderPalette {
  modelPalette: {
    modelColors: Map<ModelKey, RGB>;
    otherColor: RGB;
    orderedModels: ModelKey[];
  };
  cwdPalette: {
    cwdColors: Map<CwdKey, RGB>;
    otherColor: RGB;
    orderedCwds: CwdKey[];
  };
}

interface BreakdownTab {
  id: string;
  label: string;
  shortLabel: string;
  mode: "all" | "provider";
  liveProvider?: UsageProviderDefinition;
}

interface BreakdownData {
  tabs: BreakdownTab[];
  liveUsage: Map<SupportedProviderId, LiveUsageState>;
  allRanges: Map<number, RangeAgg>;
  providerRangesById: Map<HistoryProviderId, Map<number, RangeAgg>>;
  allPalette: ProviderPalette;
  providerPalettes: Map<HistoryProviderId, ProviderPalette>;
  dowPalette: {
    dowColors: Map<DowKey, RGB>;
    orderedDows: DowKey[];
  };
  todPalette: {
    todColors: Map<TodKey, RGB>;
    orderedTods: TodKey[];
  };
}

type BreakdownProgressPhase = "scan" | "parse" | "finalize";

interface BreakdownProgressState {
  phase: BreakdownProgressPhase;
  foundFiles: number;
  parsedFiles: number;
  totalFiles: number;
  currentFile?: string;
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
  // BorderedLoader currently stores its inner Loader on a private `loader` field, and that
  // Loader exposes `setMessage()`. Replace this cast once pi-coding-agent exposes a public
  // BorderedLoader message update API.
  const inner = (loader as unknown as { loader?: { setMessage?: (message: string) => void } })
    .loader;
  inner?.setMessage?.(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}

function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const entry of colors) {
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) continue;
    total += entry.weight;
    r += entry.color.r * entry.weight;
    g += entry.color.g * entry.weight;
    b += entry.color.b * entry.weight;
  }
  if (total <= 0) return EMPTY_CELL_BG;
  return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
}

function ansiFg(rgb: RGB, text: string): string {
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function formatFetchedAt(value: Date): string {
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function abbreviatePath(input: string, maxWidth = 40): string {
  const home = os.homedir();
  let display = input;
  if (display.startsWith(home)) display = `~${display.slice(home.length)}`;
  if (display.length <= maxWidth) return display;

  const parts = display.split("/").filter(Boolean);
  if (parts.length <= 2) return display;

  const prefix = parts[0] ?? "~";
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
    const tail = parts.slice(parts.length - keep);
    const candidate = `${prefix}/…/${tail.join("/")}`;
    if (candidate.length <= maxWidth || keep === 1) return candidate;
  }
  return display;
}

function padRight(text: string, width: number): string {
  const delta = width - visibleWidth(text);
  return delta > 0 ? text + " ".repeat(delta) : text;
}

function padLeft(text: string, width: number): string {
  const delta = width - visibleWidth(text);
  return delta > 0 ? " ".repeat(delta) + text : text;
}

function toLocalDayKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDaysLocal(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function countDaysInclusiveLocal(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function todBucketForHour(hour: number): TodKey {
  for (const bucket of TOD_BUCKETS) {
    if (hour >= bucket.from && hour <= bucket.to) return bucket.key;
  }
  return "after-midnight";
}

function todBucketLabel(key: TodKey): string {
  return TOD_BUCKETS.find((bucket) => bucket.key === key)?.label ?? key;
}

function parseSessionStartFromFilename(name: string): Date | undefined {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!match) return undefined;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function normalizeHistoryProvider(value: unknown): HistoryProviderId | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatProviderShortLabel(providerId: string): string {
  const supported = getSupportedProvider(providerId);
  if (supported) return supported.shortLabel;
  if (providerId.length <= 12) return providerId;
  return providerId.slice(0, 12);
}

function formatProviderLabel(providerId: string): string {
  return getSupportedProvider(providerId)?.label ?? providerId;
}

function extractProviderModelAndUsage(input: unknown): {
  provider?: unknown;
  model?: unknown;
  modelId?: unknown;
  usage?: unknown;
  role?: unknown;
} {
  const obj = input as { message?: Record<string, unknown> } | null | undefined;
  const message = obj?.message;
  return {
    provider: (obj as Record<string, unknown> | undefined)?.provider ?? message?.provider,
    model: (obj as Record<string, unknown> | undefined)?.model ?? message?.model,
    modelId: (obj as Record<string, unknown> | undefined)?.modelId ?? message?.modelId,
    usage: (obj as Record<string, unknown> | undefined)?.usage ?? message?.usage,
    role: message?.role,
  };
}

function extractCostTotal(usage: unknown): number {
  const input = usage as { cost?: unknown } | null | undefined;
  if (!input) return 0;

  const cost = input.cost as Record<string, unknown> | number | string | null | undefined;
  const directCost = readNumber(cost);
  if (directCost !== undefined) return directCost;
  if (!cost || typeof cost !== "object") return 0;

  return readNumber((cost as { total?: unknown }).total) ?? 0;
}

function extractTokensTotal(usage: unknown): number {
  const input = usage as Record<string, unknown> | null | undefined;
  if (!input) return 0;

  let total =
    readNumber(input.totalTokens) ??
    readNumber(input.total_tokens) ??
    readNumber(input.tokens) ??
    readNumber(input.tokenCount) ??
    readNumber(input.token_count) ??
    0;
  if (total > 0) return total;

  const tokens = input.tokens as Record<string, unknown> | null | undefined;
  total =
    readNumber(tokens?.total) ??
    readNumber(tokens?.totalTokens) ??
    readNumber(tokens?.total_tokens) ??
    0;
  if (total > 0) return total;

  const prompt =
    readNumber(input.promptTokens) ??
    readNumber(input.prompt_tokens) ??
    readNumber(input.inputTokens) ??
    readNumber(input.input_tokens) ??
    0;
  const completion =
    readNumber(input.completionTokens) ??
    readNumber(input.completion_tokens) ??
    readNumber(input.outputTokens) ??
    readNumber(input.output_tokens) ??
    0;

  const sum = prompt + completion;
  return sum > 0 ? sum : 0;
}

function modelKeyFromParts(provider?: unknown, model?: unknown): ModelKey | undefined {
  const providerText = typeof provider === "string" ? provider.trim() : "";
  const modelText = typeof model === "string" ? model.trim() : "";
  if (!providerText && !modelText) return undefined;
  if (!providerText) return modelText || undefined;
  if (!modelText) return providerText;
  return `${providerText}/${modelText}`;
}

function resolveModelKey(
  provider?: unknown,
  model?: unknown,
  modelId?: unknown,
): ModelKey | undefined {
  const modelIdText = typeof modelId === "string" ? modelId.trim() : "";
  if (modelIdText) return modelKeyFromParts(provider, modelIdText);

  const modelText = typeof model === "string" ? model.trim() : "";
  if (modelText) return modelKeyFromParts(provider, modelText);

  return modelKeyFromParts(provider);
}

async function walkSessionFiles(
  root: string,
  startCutoffLocal: Date,
  signal?: AbortSignal,
  onFound?: (found: number) => void,
): Promise<string[]> {
  const output: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    throwIfAborted(signal);
    const dir = stack.pop()!;
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      const startedAt = parseSessionStartFromFilename(entry.name);
      if (startedAt) {
        if (localMidnight(startedAt) >= startCutoffLocal) {
          output.push(filePath);
          if (onFound && output.length % 10 === 0) onFound(output.length);
        }
        continue;
      }

      try {
        const stats = await fs.stat(filePath);
        const approx = new Date(stats.mtimeMs);
        if (localMidnight(approx) >= startCutoffLocal) {
          output.push(filePath);
          if (onFound && output.length % 10 === 0) onFound(output.length);
        }
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  onFound?.(output.length);
  return output;
}

async function parseHistoricalFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<ParsedHistoricalFile> {
  const fileName = path.basename(filePath);
  let startedAt = parseSessionStartFromFilename(fileName);
  let cwd: CwdKey | null = null;
  let currentModelAll: ModelKey | undefined;
  const currentModelByProvider = new Map<HistoryProviderId, ModelKey>();

  let allSession: ParsedAllSession | null = null;
  const providerSessions = new Map<HistoryProviderId, ParsedProviderSession>();

  const createParsedSessionBase = (baseDate: Date): ParsedSessionBase => ({
    startedAt: baseDate,
    dayKeyLocal: toLocalDayKey(baseDate),
    cwd,
    dow: DOW_NAMES[mondayIndex(baseDate)] ?? "Mon",
    tod: todBucketForHour(baseDate.getHours()),
    modelsUsed: new Set<ModelKey>(),
    messages: 0,
    tokens: 0,
    totalCost: 0,
    costByModel: new Map<ModelKey, number>(),
    messagesByModel: new Map<ModelKey, number>(),
    tokensByModel: new Map<ModelKey, number>(),
  });

  const getAllSession = (): ParsedAllSession => {
    const baseDate = startedAt ?? new Date();
    if (allSession) return allSession;
    allSession = createParsedSessionBase(baseDate);
    return allSession;
  };

  const getProviderSession = (provider: HistoryProviderId): ParsedProviderSession => {
    const existing = providerSessions.get(provider);
    if (existing) return existing;

    const baseDate = startedAt ?? new Date();
    const created: ParsedProviderSession = {
      provider,
      ...createParsedSessionBase(baseDate),
    };
    providerSessions.set(provider, created);
    return created;
  };

  const updateSessionBaseFields = (session: ParsedAllSession | ParsedProviderSession): void => {
    const baseDate = startedAt ?? session.startedAt;
    session.startedAt = baseDate;
    session.dayKeyLocal = toLocalDayKey(baseDate);
    session.cwd = cwd;
    session.dow = DOW_NAMES[mondayIndex(baseDate)] ?? "Mon";
    session.tod = todBucketForHour(baseDate.getHours());
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      throwIfAborted(signal);
      if (!line) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (obj.type === "session") {
        if (!startedAt && typeof obj.timestamp === "string") {
          const parsed = new Date(obj.timestamp);
          if (Number.isFinite(parsed.getTime())) startedAt = parsed;
        }
        if (typeof obj.cwd === "string" && obj.cwd.trim()) cwd = obj.cwd.trim();
        continue;
      }

      if (obj.type === "model_change") {
        const provider = normalizeHistoryProvider(obj.provider);
        const fullModel = resolveModelKey(obj.provider, obj.model, obj.modelId);
        if (fullModel) currentModelAll = fullModel;
        if (provider) {
          const providerSession = getProviderSession(provider);
          if (fullModel) {
            currentModelByProvider.set(provider, fullModel);
            providerSession.modelsUsed.add(fullModel);
          }
        }
        continue;
      }

      if (obj.type !== "message") continue;

      const {
        provider: rawProvider,
        model,
        modelId,
        usage,
        role,
      } = extractProviderModelAndUsage(obj);

      const aggregate = getAllSession();
      const aggregateModelKey =
        resolveModelKey(rawProvider, model, modelId) ?? currentModelAll ?? "unknown";
      aggregate.modelsUsed.add(aggregateModelKey);
      aggregate.messages += 1;
      addToMap(aggregate.messagesByModel, aggregateModelKey, 1);

      const tokens = extractTokensTotal(usage);
      if (tokens > 0) {
        aggregate.tokens += tokens;
        addToMap(aggregate.tokensByModel, aggregateModelKey, tokens);
      }

      const cost = extractCostTotal(usage);
      if (cost > 0) {
        aggregate.totalCost += cost;
        addToMap(aggregate.costByModel, aggregateModelKey, cost);
      }

      if (role !== "assistant") continue;

      const explicitProvider = normalizeHistoryProvider(rawProvider);
      const fallbackProvider = currentModelAll?.includes("/")
        ? currentModelAll.slice(0, currentModelAll.indexOf("/"))
        : undefined;
      const provider = explicitProvider ?? fallbackProvider;
      if (!provider) continue;

      const providerSession = getProviderSession(provider);
      const providerModel =
        resolveModelKey(rawProvider, model, modelId) ??
        currentModelByProvider.get(provider) ??
        "unknown";

      providerSession.modelsUsed.add(providerModel);
      providerSession.messages += 1;
      addToMap(providerSession.messagesByModel, providerModel, 1);

      if (tokens > 0) {
        providerSession.tokens += tokens;
        addToMap(providerSession.tokensByModel, providerModel, tokens);
      }

      if (cost > 0) {
        providerSession.totalCost += cost;
        addToMap(providerSession.costByModel, providerModel, cost);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!allSession && startedAt) {
    allSession = createParsedSessionBase(startedAt);
  }

  if (allSession) updateSessionBaseFields(allSession);
  for (const providerSession of providerSessions.values()) {
    updateSessionBaseFields(providerSession);
  }

  return {
    all: allSession,
    providers: [...providerSessions.values()],
  };
}

function buildRangeAgg(days: number, now: Date): RangeAgg {
  const end = localMidnight(now);
  const start = addDaysLocal(end, -(days - 1));
  const daysOut: DayAgg[] = [];
  const dayByKey = new Map<string, DayAgg>();

  for (let index = 0; index < days; index += 1) {
    const date = addDaysLocal(start, index);
    const dayKeyLocal = toLocalDayKey(date);
    const day: DayAgg = {
      date,
      dayKeyLocal,
      sessions: 0,
      messages: 0,
      tokens: 0,
      totalCost: 0,
      costByModel: new Map(),
      sessionsByModel: new Map(),
      messagesByModel: new Map(),
      tokensByModel: new Map(),
      sessionsByCwd: new Map(),
      messagesByCwd: new Map(),
      tokensByCwd: new Map(),
      costByCwd: new Map(),
      sessionsByTod: new Map(),
      messagesByTod: new Map(),
      tokensByTod: new Map(),
      costByTod: new Map(),
    };
    daysOut.push(day);
    dayByKey.set(dayKeyLocal, day);
  }

  return {
    days: daysOut,
    dayByKey,
    sessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalCost: 0,
    modelCost: new Map(),
    modelSessions: new Map(),
    modelMessages: new Map(),
    modelTokens: new Map(),
    cwdCost: new Map(),
    cwdSessions: new Map(),
    cwdMessages: new Map(),
    cwdTokens: new Map(),
    dowCost: new Map(),
    dowSessions: new Map(),
    dowMessages: new Map(),
    dowTokens: new Map(),
    todCost: new Map(),
    todSessions: new Map(),
    todMessages: new Map(),
    todTokens: new Map(),
  };
}

const emptyRangeCache = new Map<number, { dayKey: string; range: RangeAgg }>();

function addToMap<K>(map: Map<K, number>, key: K, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function getEmptyRange(days: number, now = new Date()): RangeAgg {
  const dayKey = toLocalDayKey(localMidnight(now));
  const cached = emptyRangeCache.get(days);
  if (cached?.dayKey === dayKey) return cached.range;

  const range = buildRangeAgg(days, now);
  emptyRangeCache.set(days, { dayKey, range });
  return range;
}

function addSessionToRange(
  range: RangeAgg,
  session: ParsedAllSession | ParsedProviderSession,
): void {
  const day = range.dayByKey.get(session.dayKeyLocal);
  if (!day) return;

  range.sessions += 1;
  range.totalMessages += session.messages;
  range.totalTokens += session.tokens;
  range.totalCost += session.totalCost;

  day.sessions += 1;
  day.messages += session.messages;
  day.tokens += session.tokens;
  day.totalCost += session.totalCost;

  for (const model of session.modelsUsed) {
    addToMap(day.sessionsByModel, model, 1);
    addToMap(range.modelSessions, model, 1);
  }

  for (const [model, count] of session.messagesByModel.entries()) {
    addToMap(day.messagesByModel, model, count);
    addToMap(range.modelMessages, model, count);
  }

  for (const [model, count] of session.tokensByModel.entries()) {
    addToMap(day.tokensByModel, model, count);
    addToMap(range.modelTokens, model, count);
  }

  for (const [model, cost] of session.costByModel.entries()) {
    addToMap(day.costByModel, model, cost);
    addToMap(range.modelCost, model, cost);
  }

  if (session.cwd) {
    addToMap(day.sessionsByCwd, session.cwd, 1);
    addToMap(range.cwdSessions, session.cwd, 1);
    addToMap(day.messagesByCwd, session.cwd, session.messages);
    addToMap(range.cwdMessages, session.cwd, session.messages);
    addToMap(day.tokensByCwd, session.cwd, session.tokens);
    addToMap(range.cwdTokens, session.cwd, session.tokens);
    addToMap(day.costByCwd, session.cwd, session.totalCost);
    addToMap(range.cwdCost, session.cwd, session.totalCost);
  }

  addToMap(range.dowSessions, session.dow, 1);
  addToMap(range.dowMessages, session.dow, session.messages);
  addToMap(range.dowTokens, session.dow, session.tokens);
  addToMap(range.dowCost, session.dow, session.totalCost);

  addToMap(day.sessionsByTod, session.tod, 1);
  addToMap(day.messagesByTod, session.tod, session.messages);
  addToMap(day.tokensByTod, session.tod, session.tokens);
  addToMap(day.costByTod, session.tod, session.totalCost);

  addToMap(range.todSessions, session.tod, 1);
  addToMap(range.todMessages, session.tod, session.messages);
  addToMap(range.todTokens, session.tod, session.tokens);
  addToMap(range.todCost, session.tod, session.totalCost);
}

function sortMapByValueDesc<K extends string>(
  map: Map<K, number>,
): Array<{ key: K; value: number }> {
  return [...map.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value);
}

function preferredPopularityMap<K>(options: {
  cost: Map<K, number>;
  tokens: Map<K, number>;
  messages: Map<K, number>;
  sessions: Map<K, number>;
  totalTokens: number;
  totalMessages: number;
}): Map<K, number> {
  const costSum = [...options.cost.values()].reduce((sum, value) => sum + value, 0);
  if (costSum > 0) return options.cost;
  if (options.totalTokens > 0) return options.tokens;
  if (options.totalMessages > 0) return options.messages;
  return options.sessions;
}

function metricValuesForKind<K>(
  kind: GraphMetric["kind"],
  options: {
    sessions: Map<K, number>;
    messages: Map<K, number>;
    tokens: Map<K, number>;
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
  },
): { values: Map<K, number>; total: number } {
  if (kind === "tokens") {
    return { values: options.tokens, total: options.totalTokens };
  }
  if (kind === "messages") {
    return { values: options.messages, total: options.totalMessages };
  }
  return { values: options.sessions, total: options.totalSessions };
}

function normalizeHue(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function rgbToHsl(color: RGB): { h: number; s: number; l: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let hue = 0;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;

  return { h: normalizeHue(hue * 60), s: saturation, l: lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const h = normalizeHue(hue) / 360;
  const s = clamp01(saturation);
  const l = clamp01(lightness);

  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }

  const hueToChannel = (p: number, q: number, t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, h) * 255),
    b: Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  };
}

function adjustColor(
  color: RGB,
  adjustments: { hueShift?: number; saturationShift?: number; lightnessShift?: number },
): RGB {
  const hsl = rgbToHsl(color);
  return hslToRgb(
    hsl.h + (adjustments.hueShift ?? 0),
    hsl.s + (adjustments.saturationShift ?? 0),
    hsl.l + (adjustments.lightnessShift ?? 0),
  );
}

function buildProviderModelPalette(color: RGB): readonly RGB[] {
  return [
    color,
    adjustColor(color, { hueShift: 16, saturationShift: 0.04, lightnessShift: 0.08 }),
    adjustColor(color, { hueShift: -12, saturationShift: 0.02, lightnessShift: -0.06 }),
  ];
}

function chooseModelPalette(
  range30: RangeAgg,
  topN = 4,
  paletteColors: readonly RGB[] = PALETTE,
): ProviderPalette["modelPalette"] {
  const popularity = preferredPopularityMap({
    cost: range30.modelCost,
    tokens: range30.modelTokens,
    messages: range30.modelMessages,
    sessions: range30.modelSessions,
    totalTokens: range30.totalTokens,
    totalMessages: range30.totalMessages,
  });

  const orderedModels = sortMapByValueDesc(popularity)
    .slice(0, topN)
    .map((entry) => entry.key);
  const modelColors = new Map<ModelKey, RGB>();

  for (let index = 0; index < orderedModels.length; index += 1) {
    const model = orderedModels[index];
    const color = paletteColors[index] ?? PALETTE[index % PALETTE.length] ?? MUTED_COLOR;
    if (model) modelColors.set(model, color);
  }

  return {
    modelColors,
    otherColor: MUTED_COLOR,
    orderedModels,
  };
}

function chooseCwdPalette(range30: RangeAgg, topN = 4): ProviderPalette["cwdPalette"] {
  const popularity = preferredPopularityMap({
    cost: range30.cwdCost,
    tokens: range30.cwdTokens,
    messages: range30.cwdMessages,
    sessions: range30.cwdSessions,
    totalTokens: range30.totalTokens,
    totalMessages: range30.totalMessages,
  });

  const orderedCwds = sortMapByValueDesc(popularity)
    .slice(0, topN)
    .map((entry) => entry.key);
  const cwdColors = new Map<CwdKey, RGB>();
  for (let index = 0; index < orderedCwds.length; index += 1) {
    const cwd = orderedCwds[index];
    if (cwd) cwdColors.set(cwd, PALETTE[index % PALETTE.length]!);
  }

  return {
    cwdColors,
    otherColor: MUTED_COLOR,
    orderedCwds,
  };
}

function buildDowPalette(): BreakdownData["dowPalette"] {
  const dowColors = new Map<DowKey, RGB>();
  for (let index = 0; index < DOW_NAMES.length; index += 1) {
    const dow = DOW_NAMES[index];
    const color = DOW_PALETTE[index];
    if (dow && color) dowColors.set(dow, color);
  }
  return { dowColors, orderedDows: [...DOW_NAMES] };
}

function buildTodPalette(): BreakdownData["todPalette"] {
  const todColors = new Map<TodKey, RGB>();
  const orderedTods: TodKey[] = [];
  for (const bucket of TOD_BUCKETS) {
    const color = TOD_PALETTE.get(bucket.key);
    if (color) todColors.set(bucket.key, color);
    orderedTods.push(bucket.key);
  }
  return { todColors, orderedTods };
}

function dayMixedColor(
  day: DayAgg,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  view: BreakdownView,
): RGB {
  if (view === "dow") {
    const dowKey = DOW_NAMES[mondayIndex(day.date)] ?? "Mon";
    return colorMap.get(dowKey) ?? otherColor;
  }

  let weights: Map<string, number>;
  if (view === "tod") {
    weights =
      mode === "tokens"
        ? day.tokens > 0
          ? day.tokensByTod
          : day.messages > 0
            ? day.messagesByTod
            : day.sessionsByTod
        : mode === "messages"
          ? day.messages > 0
            ? day.messagesByTod
            : day.sessionsByTod
          : day.sessionsByTod;
  } else if (view === "cwd") {
    weights =
      mode === "tokens"
        ? day.tokens > 0
          ? day.tokensByCwd
          : day.messages > 0
            ? day.messagesByCwd
            : day.sessionsByCwd
        : mode === "messages"
          ? day.messages > 0
            ? day.messagesByCwd
            : day.sessionsByCwd
          : day.sessionsByCwd;
  } else {
    weights =
      mode === "tokens"
        ? day.tokens > 0
          ? day.tokensByModel
          : day.messages > 0
            ? day.messagesByModel
            : day.sessionsByModel
        : mode === "messages"
          ? day.messages > 0
            ? day.messagesByModel
            : day.sessionsByModel
          : day.sessionsByModel;
  }

  const parts: Array<{ color: RGB; weight: number }> = [];
  let otherWeight = 0;
  for (const [key, weight] of weights.entries()) {
    const color = colorMap.get(key);
    if (color) parts.push({ color, weight });
    else otherWeight += weight;
  }
  if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });

  return weightedMix(parts);
}

interface GraphMetric {
  kind: "sessions" | "messages" | "tokens";
  denom: number;
}

function graphMetricForRange(range: RangeAgg, mode: MeasurementMode): GraphMetric {
  if (mode === "tokens") {
    const maxTokens = Math.max(0, ...range.days.map((day) => day.tokens));
    if (maxTokens > 0) return { kind: "tokens", denom: Math.log1p(maxTokens) };
    mode = "messages";
  }

  if (mode === "messages") {
    const maxMessages = Math.max(0, ...range.days.map((day) => day.messages));
    if (maxMessages > 0) {
      return { kind: "messages", denom: Math.log1p(maxMessages) };
    }
    mode = "sessions";
  }

  const maxSessions = Math.max(0, ...range.days.map((day) => day.sessions));
  return { kind: "sessions", denom: Math.log1p(maxSessions) };
}

function weeksForRange(range: RangeAgg): number {
  const start = range.days[0]?.date;
  const end = range.days[range.days.length - 1]?.date;
  if (!start || !end) return 0;
  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
  return Math.ceil(totalGridDays / 7);
}

function renderGraphLines(
  range: RangeAgg,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  options?: { cellWidth?: number; gap?: number },
  view: BreakdownView = "model",
  weeks?: number,
): string[] {
  const start = range.days[0]?.date;
  const end = range.days[range.days.length - 1]?.date;
  if (!start || !end) return [];

  const gridStart = addDaysLocal(start, -mondayIndex(start));
  if (weeks === undefined) {
    const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
    const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
    weeks = Math.ceil(totalGridDays / 7);
  }

  const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
  const gap = Math.max(0, Math.floor(options?.gap ?? 1));
  const block = "█".repeat(cellWidth);
  const gapString = " ".repeat(gap);

  const metric = graphMetricForRange(range, mode);
  const denom = metric.denom;
  const labelByRow = new Map<number, string>([
    [0, "Mon"],
    [2, "Wed"],
    [4, "Fri"],
  ]);

  const lines: string[] = [];
  for (let row = 0; row < 7; row += 1) {
    const label = labelByRow.get(row);
    let line = label ? `${padRight(label, 3)} ` : "    ";

    for (let week = 0; week < weeks; week += 1) {
      const cellDate = addDaysLocal(gridStart, week * 7 + row);
      const inRange = cellDate >= start && cellDate <= end;
      const columnGap = week < weeks - 1 ? gapString : "";
      if (!inRange) {
        line += " ".repeat(cellWidth) + columnGap;
        continue;
      }

      const key = toLocalDayKey(cellDate);
      const day = range.dayByKey.get(key);
      const value =
        metric.kind === "tokens"
          ? (day?.tokens ?? 0)
          : metric.kind === "messages"
            ? (day?.messages ?? 0)
            : (day?.sessions ?? 0);

      if (!day || value <= 0) {
        line += ansiFg(EMPTY_CELL_BG, block) + columnGap;
        continue;
      }

      const hue = dayMixedColor(day, colorMap, otherColor, mode, view);
      const intensity = 0.2 + 0.8 * clamp01(denom > 0 ? Math.log1p(value) / denom : 0);
      const rgb = mixRgb(DEFAULT_BG, hue, intensity);
      line += ansiFg(rgb, block) + columnGap;
    }

    lines.push(line);
  }

  return lines;
}

function renderDowDistributionLines(
  range: RangeAgg,
  mode: MeasurementMode,
  dowColors: Map<DowKey, RGB>,
  width: number,
): string[] {
  const metric = graphMetricForRange(range, mode);
  const { values: perDow, total } = metricValuesForKind(metric.kind, {
    sessions: range.dowSessions,
    messages: range.dowMessages,
    tokens: range.dowTokens,
    totalSessions: range.sessions,
    totalMessages: range.totalMessages,
    totalTokens: range.totalTokens,
  });

  const dayWidth = 3;
  const pctWidth = 4;
  const valueWidth = metric.kind === "tokens" ? 10 : 8;
  const showValue = width >= dayWidth + 1 + 10 + 1 + pctWidth + 1 + valueWidth;
  const fixedWidth = dayWidth + 1 + 1 + pctWidth + (showValue ? 1 + valueWidth : 0);
  const barWidth = Math.max(1, width - fixedWidth);

  const lines: string[] = [];
  for (const dow of DOW_NAMES) {
    const value = perDow.get(dow) ?? 0;
    const share = total > 0 ? value / total : 0;
    let filled = share > 0 ? Math.round(share * barWidth) : 0;
    if (share > 0) filled = Math.max(1, filled);
    filled = Math.min(barWidth, filled);
    const empty = Math.max(0, barWidth - filled);

    const color = dowColors.get(dow) ?? MUTED_COLOR;
    const filledBar = filled > 0 ? ansiFg(color, "█".repeat(filled)) : "";
    const emptyBar = empty > 0 ? ansiFg(EMPTY_CELL_BG, "█".repeat(empty)) : "";
    const pct = padLeft(`${Math.round(share * 100)}%`, pctWidth);

    let line = `${padRight(dow, dayWidth)} ${filledBar}${emptyBar} ${pct}`;
    if (showValue) line += ` ${padLeft(formatCount(value), valueWidth)}`;
    lines.push(line);
  }

  return lines;
}

function formatModelLabel(modelKey: string, stripProvider: boolean): string {
  if (!stripProvider) return modelKey;
  const index = modelKey.indexOf("/");
  return index === -1 ? modelKey : modelKey.slice(index + 1);
}

function renderModelTable(
  range: RangeAgg,
  metric: GraphMetric,
  maxRows = 8,
  options?: { stripProvider?: boolean },
): string[] {
  const { values: perModel, total } = metricValuesForKind(metric.kind, {
    sessions: range.modelSessions,
    messages: range.modelMessages,
    tokens: range.modelTokens,
    totalSessions: range.sessions,
    totalMessages: range.totalMessages,
    totalTokens: range.totalTokens,
  });

  const sorted = sortMapByValueDesc(perModel);
  const rows = sorted.slice(0, maxRows);
  const labels = rows.map((row) => formatModelLabel(row.key, options?.stripProvider ?? false));
  const valueWidth = metric.kind === "tokens" ? 10 : 8;
  const modelWidth = Math.min(52, Math.max("model".length, ...labels.map((label) => label.length)));

  const lines: string[] = [];
  lines.push(
    `${padRight("model", modelWidth)}  ${padLeft(metric.kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
  );
  lines.push(
    `${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  );

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const label = labels[index] ?? row.key;
    const value = perModel.get(row.key) ?? 0;
    const cost = range.modelCost.get(row.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(label.slice(0, modelWidth), modelWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  if (sorted.length === 0) lines.push(dim("(no model data found)"));
  return lines;
}

function renderCwdTable(range: RangeAgg, metric: GraphMetric, maxRows = 8): string[] {
  const { values: perCwd, total } = metricValuesForKind(metric.kind, {
    sessions: range.cwdSessions,
    messages: range.cwdMessages,
    tokens: range.cwdTokens,
    totalSessions: range.sessions,
    totalMessages: range.totalMessages,
    totalTokens: range.totalTokens,
  });

  const sorted = sortMapByValueDesc(perCwd);
  const rows = sorted.slice(0, maxRows);
  const labels = rows.map((row) => abbreviatePath(row.key, 40));
  const valueWidth = metric.kind === "tokens" ? 10 : 8;
  const cwdWidth = Math.min(
    42,
    Math.max("directory".length, ...labels.map((label) => label.length)),
  );

  const lines: string[] = [];
  lines.push(
    `${padRight("directory", cwdWidth)}  ${padLeft(metric.kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
  );
  lines.push(
    `${"-".repeat(cwdWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  );

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const label = labels[index] ?? row.key;
    const value = perCwd.get(row.key) ?? 0;
    const cost = range.cwdCost.get(row.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(label.slice(0, cwdWidth), cwdWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  if (sorted.length === 0) lines.push(dim("(no directory data found)"));
  return lines;
}

function renderDowTable(range: RangeAgg, metric: GraphMetric): string[] {
  const { values: perDow, total } = metricValuesForKind(metric.kind, {
    sessions: range.dowSessions,
    messages: range.dowMessages,
    tokens: range.dowTokens,
    totalSessions: range.sessions,
    totalMessages: range.totalMessages,
    totalTokens: range.totalTokens,
  });
  const valueWidth = metric.kind === "tokens" ? 10 : 8;
  const dowWidth = 5;

  const lines: string[] = [];
  lines.push(
    `${padRight("day", dowWidth)}  ${padLeft(metric.kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
  );
  lines.push(
    `${"-".repeat(dowWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  );

  for (const dow of DOW_NAMES) {
    const value = perDow.get(dow) ?? 0;
    const cost = range.dowCost.get(dow) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(dow, dowWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  return lines;
}

function renderTodTable(range: RangeAgg, metric: GraphMetric): string[] {
  const { values: perTod, total } = metricValuesForKind(metric.kind, {
    sessions: range.todSessions,
    messages: range.todMessages,
    tokens: range.todTokens,
    totalSessions: range.sessions,
    totalMessages: range.totalMessages,
    totalTokens: range.totalTokens,
  });

  const valueWidth = metric.kind === "tokens" ? 10 : 8;
  const todWidth = 22;

  const lines: string[] = [];
  lines.push(
    `${padRight("time of day", todWidth)}  ${padLeft(metric.kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
  );
  lines.push(
    `${"-".repeat(todWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  );

  for (const bucket of TOD_BUCKETS) {
    const value = perTod.get(bucket.key) ?? 0;
    const cost = range.todCost.get(bucket.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(bucket.label, todWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  return lines;
}

function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
  const avg = range.sessions > 0 ? range.totalCost / range.sessions : 0;
  const costPart =
    range.totalCost > 0
      ? `${formatUsd(range.totalCost)} · avg ${formatUsd(avg)}/session`
      : "$0.0000";

  if (mode === "tokens") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalTokens)} tokens · ${costPart}`;
  }
  if (mode === "messages") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
  }
  return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${costPart}`;
}

function historySemanticsText(tab: BreakdownTab): string {
  if (tab.mode === "all") {
    return "history: sessions = session files; messages = all Pi message rows; tokens = assistant usage tokens";
  }
  return "history: sessions = session files where this provider appeared; messages/tokens = provider-attributed assistant usage";
}

async function getLiveUsageAvailability(
  provider: UsageProviderDefinition,
  ctx: ExtensionContext,
): Promise<LiveUsageAvailability> {
  if (provider.getLiveUsageAvailability) {
    return provider.getLiveUsageAvailability(ctx);
  }

  return ctx.modelRegistry.authStorage.hasAuth(provider.id)
    ? { available: true }
    : { available: false, reason: "no auth configured" };
}

async function getLiveUsageAvailabilityMap(
  ctx: ExtensionContext,
): Promise<Map<SupportedProviderId, LiveUsageAvailability>> {
  const entries = await Promise.all(
    SUPPORTED_PROVIDERS.map(
      async (provider) => [provider.id, await getLiveUsageAvailability(provider, ctx)] as const,
    ),
  );
  return new Map(entries);
}

function getLiveAvailableProviders(
  availabilityByProvider: ReadonlyMap<SupportedProviderId, LiveUsageAvailability>,
): Set<SupportedProviderId> {
  const providers = new Set<SupportedProviderId>();
  for (const [providerId, availability] of availabilityByProvider.entries()) {
    if (availability.available) providers.add(providerId);
  }
  return providers;
}

function buildInitialLiveUsage(
  providers: readonly UsageProviderDefinition[],
  availabilityByProvider: ReadonlyMap<SupportedProviderId, LiveUsageAvailability>,
): Map<SupportedProviderId, LiveUsageState> {
  const liveUsage = new Map<SupportedProviderId, LiveUsageState>();
  for (const provider of providers) {
    const availability = availabilityByProvider.get(provider.id);
    if (!availability?.available) {
      liveUsage.set(provider.id, {
        status: "unavailable",
        reason: availability?.reason ?? "no auth configured",
      });
    }
  }
  return liveUsage;
}

async function fetchLiveUsageForProvider(
  provider: UsageProviderDefinition,
  availabilityByProvider: ReadonlyMap<SupportedProviderId, LiveUsageAvailability>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<LiveUsageState> {
  const availability = availabilityByProvider.get(provider.id);
  if (!availability?.available) {
    return { status: "unavailable", reason: availability?.reason ?? "no auth configured" };
  }

  try {
    const snapshot = await provider.fetchLiveUsage(ctx, signal);
    return { status: "ok", snapshot };
  } catch (error) {
    if (isLiveUsageUnavailableError(error)) {
      return { status: "unavailable", reason: error.message };
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchLiveUsage(
  providers: readonly UsageProviderDefinition[],
  availabilityByProvider: ReadonlyMap<SupportedProviderId, LiveUsageAvailability>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Map<SupportedProviderId, LiveUsageState>> {
  throwIfAborted(signal);
  const entries = await Promise.all(
    providers.map(
      async (provider) =>
        [
          provider.id,
          await fetchLiveUsageForProvider(provider, availabilityByProvider, ctx, signal),
        ] as const,
    ),
  );
  return new Map(entries);
}

function buildTabs(
  historyProviderIds: Set<HistoryProviderId>,
  liveAvailableProviders: ReadonlySet<string>,
): BreakdownTab[] {
  const tabs: BreakdownTab[] = [
    { id: ALL_TAB_ID, label: "All providers", shortLabel: "all", mode: "all" },
  ];
  const added = new Set<string>();

  for (const provider of SUPPORTED_PROVIDERS) {
    if (!historyProviderIds.has(provider.id) && !liveAvailableProviders.has(provider.id)) continue;
    tabs.push({
      id: provider.id,
      label: provider.label,
      shortLabel: provider.shortLabel,
      mode: "provider",
      liveProvider: provider,
    });
    added.add(provider.id);
  }

  const historyOnly = [...historyProviderIds].filter((providerId) => !added.has(providerId));
  historyOnly.sort((left, right) => left.localeCompare(right));
  for (const providerId of historyOnly) {
    tabs.push({
      id: providerId,
      label: formatProviderLabel(providerId),
      shortLabel: formatProviderShortLabel(providerId),
      mode: "provider",
    });
  }

  return tabs;
}

async function computeBreakdown(
  availabilityByProvider: ReadonlyMap<SupportedProviderId, LiveUsageAvailability>,
  signal?: AbortSignal,
  onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
  const now = new Date();
  const allRanges = new Map<number, RangeAgg>();
  for (const days of RANGE_DAYS) allRanges.set(days, buildRangeAgg(days, now));

  const providerRangesById = new Map<HistoryProviderId, Map<number, RangeAgg>>();
  const historyProviderIds = new Set<HistoryProviderId>();

  const range90 = allRanges.get(90)!;
  const start90 = range90.days[0]?.date ?? addDaysLocal(localMidnight(now), -89);

  onProgress?.({
    phase: "scan",
    foundFiles: 0,
    parsedFiles: 0,
    totalFiles: 0,
    currentFile: undefined,
  });
  const candidates = await walkSessionFiles(SESSION_ROOT, start90, signal, (found) => {
    onProgress?.({ phase: "scan", foundFiles: found });
  });

  onProgress?.({
    phase: "parse",
    foundFiles: candidates.length,
    parsedFiles: 0,
    totalFiles: candidates.length,
    currentFile: candidates[0] ? path.basename(candidates[0]) : undefined,
  });

  const addParsedFile = (parsed: ParsedHistoricalFile): void => {
    if (parsed.all) {
      const sessionDay = localMidnight(parsed.all.startedAt);
      for (const days of RANGE_DAYS) {
        const range = allRanges.get(days)!;
        const start = range.days[0]?.date;
        const end = range.days[range.days.length - 1]?.date;
        if (!start || !end) continue;
        if (sessionDay < start || sessionDay > end) continue;
        addSessionToRange(range, parsed.all);
      }
    }

    for (const providerSession of parsed.providers) {
      historyProviderIds.add(providerSession.provider);
      let providerRanges = providerRangesById.get(providerSession.provider);
      if (!providerRanges) {
        providerRanges = new Map<number, RangeAgg>();
        for (const days of RANGE_DAYS) providerRanges.set(days, buildRangeAgg(days, now));
        providerRangesById.set(providerSession.provider, providerRanges);
      }

      const sessionDay = localMidnight(providerSession.startedAt);
      for (const days of RANGE_DAYS) {
        const range = providerRanges.get(days)!;
        const start = range.days[0]?.date;
        const end = range.days[range.days.length - 1]?.date;
        if (!start || !end) continue;
        if (sessionDay < start || sessionDay > end) continue;
        addSessionToRange(range, providerSession);
      }
    }
  };

  let parsedFiles = 0;
  let nextFileIndex = 0;
  const workerCount = Math.min(FILE_PARSE_CONCURRENCY, candidates.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        throwIfAborted(signal);

        const currentIndex = nextFileIndex;
        nextFileIndex += 1;
        const filePath = candidates[currentIndex];
        if (!filePath) return;

        const parsed = await parseHistoricalFile(filePath, signal);
        addParsedFile(parsed);

        parsedFiles += 1;
        onProgress?.({
          phase: "parse",
          parsedFiles,
          totalFiles: candidates.length,
          currentFile: path.basename(filePath),
        });
      }
    }),
  );

  onProgress?.({ phase: "finalize", currentFile: undefined });

  const allPaletteRange = allRanges.get(30)!;
  const allPalette: ProviderPalette = {
    modelPalette: chooseModelPalette(allPaletteRange),
    cwdPalette: chooseCwdPalette(allPaletteRange),
  };

  const providerPalettes = new Map<HistoryProviderId, ProviderPalette>();
  for (const [providerId, ranges] of providerRangesById.entries()) {
    const range30 = ranges.get(30)!;
    const provider = getSupportedProvider(providerId);
    providerPalettes.set(providerId, {
      modelPalette: chooseModelPalette(
        range30,
        3,
        provider ? buildProviderModelPalette(provider.color) : PALETTE,
      ),
      cwdPalette: chooseCwdPalette(range30),
    });
  }

  const liveAvailableProviders = getLiveAvailableProviders(availabilityByProvider);

  return {
    tabs: buildTabs(historyProviderIds, liveAvailableProviders),
    liveUsage: buildInitialLiveUsage(SUPPORTED_PROVIDERS, availabilityByProvider),
    allRanges,
    providerRangesById,
    allPalette,
    providerPalettes,
    dowPalette: buildDowPalette(),
    todPalette: buildTodPalette(),
  };
}

function renderUsageMeterBar(
  providerId: SupportedProviderId,
  meter: LiveUsageMeter,
  width: number,
): string {
  const barWidth = Math.max(10, Math.min(32, width));
  const filled = Math.min(barWidth, Math.max(0, Math.round((barWidth * meter.usedPercent) / 100)));
  const empty = Math.max(0, barWidth - filled);
  const color = getSupportedProvider(providerId)?.color ?? MUTED_COLOR;
  const bar = `${ansiFg(color, "█".repeat(filled))}${ansiFg(EMPTY_CELL_BG, "█".repeat(empty))}`;
  return truncateToWidth(bar, width);
}

function formatUsageHeader(
  plan: string | undefined,
  fetchedAt: Date | undefined,
): {
  title: string;
  fetched?: string;
} {
  return {
    title: `Usage${plan ? ` · ${plan}` : ""}`,
    fetched: fetchedAt ? `fetched ${formatFetchedAt(fetchedAt)}` : undefined,
  };
}

function renderUsageHeader(
  plan: string | undefined,
  fetchedAt: Date | undefined,
  width: number,
): string {
  const header = formatUsageHeader(plan, fetchedAt);
  let text = bold(header.title);
  if (header.fetched) text += `  ${dim(header.fetched)}`;
  return truncateToWidth(text, width);
}

type ResolvedLiveUsageState =
  | { kind: "ok"; snapshot: LiveUsageSnapshot }
  | { kind: "loading"; message: string }
  | { kind: "message"; message: string; tone: "muted" | "error" };

function resolveLiveUsageState(
  tab: BreakdownTab,
  liveState: LiveUsageState | undefined,
): ResolvedLiveUsageState {
  if (!tab.liveProvider) {
    return { kind: "message", message: "History only · no live quota integration", tone: "muted" };
  }
  if (!liveState) {
    return {
      kind: "message",
      message: "Select this tab to load live quota data on demand.",
      tone: "muted",
    };
  }
  if (liveState.status === "loading") {
    return { kind: "loading", message: "loading..." };
  }
  if (liveState.status === "unavailable") {
    return { kind: "message", message: `History only · ${liveState.reason}`, tone: "muted" };
  }
  if (liveState.status === "error") {
    return { kind: "message", message: `Usage unavailable · ${liveState.error}`, tone: "error" };
  }
  return { kind: "ok", snapshot: liveState.snapshot };
}

function formatLiveUsageItemLine(
  item: LiveUsageItem,
  options?: { dimReset?: boolean; emphasizeStatValue?: boolean },
): string {
  if (item.kind === "meter") {
    const label = item.windowLabel ? `${item.label} (${item.windowLabel})` : item.label;
    let text = `${label}: ${formatUsedPercent(item.usedPercent)}`;
    if (item.detail) text += ` · ${item.detail}`;
    if (item.resetDescription) {
      const reset = options?.dimReset ? dim(item.resetDescription) : item.resetDescription;
      text += ` · ${reset}`;
    }
    return text;
  }

  const value = options?.emphasizeStatValue ? bold(item.value) : item.value;
  return `${item.label}: ${value}${item.detail ? ` · ${item.detail}` : ""}`;
}

function renderLiveUsageLines(
  tab: BreakdownTab,
  liveState: LiveUsageState | undefined,
  width: number,
): string[] {
  if (tab.mode === "all") return [];

  const resolved = resolveLiveUsageState(tab, liveState);
  if (resolved.kind === "loading") {
    return [truncateToWidth(`${bold("Usage")} ${dim(resolved.message)}`, width)];
  }

  const lines: string[] = [
    renderUsageHeader(
      resolved.kind === "ok" ? resolved.snapshot.plan : undefined,
      resolved.kind === "ok" ? resolved.snapshot.fetchedAt : undefined,
      width,
    ),
  ];
  if (resolved.kind === "message") {
    const message =
      resolved.tone === "error" ? ansiFg(ERROR_COLOR, resolved.message) : dim(resolved.message);
    lines.push(truncateToWidth(message, width));
    return lines;
  }

  for (const item of resolved.snapshot.items) {
    lines.push("");
    lines.push(
      truncateToWidth(
        formatLiveUsageItemLine(item, { dimReset: true, emphasizeStatValue: true }),
        width,
      ),
    );
    if (item.kind === "meter" && tab.liveProvider) {
      lines.push(renderUsageMeterBar(tab.liveProvider.id, item, width));
    }
  }

  return lines;
}

function renderNonInteractiveSummary(data: BreakdownData): string {
  const lines: string[] = ["Usage"];
  const allRange = data.allRanges.get(30)!;
  lines.push(`All providers · ${rangeSummary(allRange, 30, "tokens")}`);
  lines.push(
    `  ${historySemanticsText({ id: ALL_TAB_ID, label: "All providers", shortLabel: "all", mode: "all" })}`,
  );

  for (const tab of data.tabs) {
    if (tab.mode !== "provider") continue;
    lines.push("");
    lines.push(tab.label);

    const liveState = tab.liveProvider ? data.liveUsage.get(tab.liveProvider.id) : undefined;
    const resolved = resolveLiveUsageState(tab, liveState);
    if (resolved.kind === "ok") {
      const header = formatUsageHeader(resolved.snapshot.plan, resolved.snapshot.fetchedAt);
      lines.push(`  ${header.title}${header.fetched ? `  ${header.fetched}` : ""}`);
      for (const item of resolved.snapshot.items) {
        lines.push(`  ${formatLiveUsageItemLine(item)}`);
      }
    } else if (resolved.kind === "loading") {
      lines.push(`  Usage ${resolved.message}`);
    } else {
      lines.push(`  ${resolved.message}`);
    }

    const range = data.providerRangesById.get(tab.id)?.get(30);
    if (range) lines.push(`  ${rangeSummary(range, 30, "tokens")}`);
    lines.push(`  ${historySemanticsText(tab)}`);
  }

  return lines.join("\n");
}

class UsageBreakdownComponent implements Component {
  private readonly data: BreakdownData;
  private readonly tui: TUI;
  private readonly onDone: () => void;
  private readonly loadLiveUsage: (
    provider: UsageProviderDefinition,
    signal?: AbortSignal,
  ) => Promise<LiveUsageState>;
  private readonly liveUsageRequests = new Map<SupportedProviderId, Promise<void>>();
  private readonly liveUsageControllers = new Map<SupportedProviderId, AbortController>();
  private tabIndex = 0;
  private rangeIndex = 1;
  private measurement: MeasurementMode = "tokens";
  private view: BreakdownView = "model";
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    data: BreakdownData,
    tui: TUI,
    onDone: () => void,
    loadLiveUsage: (
      provider: UsageProviderDefinition,
      signal?: AbortSignal,
    ) => Promise<LiveUsageState>,
  ) {
    this.data = data;
    this.tui = tui;
    this.onDone = onDone;
    this.loadLiveUsage = loadLiveUsage;
    this.ensureLiveUsageLoaded();
  }

  private close(): void {
    for (const controller of this.liveUsageControllers.values()) {
      controller.abort();
    }
    this.liveUsageControllers.clear();
    this.onDone();
  }

  private ensureLiveUsageLoaded(): void {
    const tab = this.data.tabs[this.tabIndex];
    const provider = tab?.liveProvider;
    if (!provider) return;

    const current = this.data.liveUsage.get(provider.id);
    if (current && current.status !== "loading") return;
    if (this.liveUsageRequests.has(provider.id)) return;

    const controller = new AbortController();
    this.liveUsageControllers.set(provider.id, controller);
    this.data.liveUsage.set(provider.id, { status: "loading" });
    this.invalidate();
    this.tui.requestRender();

    const request = this.loadLiveUsage(provider, controller.signal)
      .then((state) => {
        if (controller.signal.aborted) return;
        this.data.liveUsage.set(provider.id, state);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        this.data.liveUsage.set(provider.id, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.liveUsageRequests.delete(provider.id);
        this.liveUsageControllers.delete(provider.id);
        if (!controller.signal.aborted) {
          this.invalidate();
          this.tui.requestRender();
        }
      });

    this.liveUsageRequests.set(provider.id, request);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    ) {
      this.close();
      return;
    }

    if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift("tab")) ||
      data.toLowerCase() === "t"
    ) {
      const order: MeasurementMode[] = ["sessions", "messages", "tokens"];
      const index = Math.max(0, order.indexOf(this.measurement));
      const direction = matchesKey(data, Key.shift("tab")) ? -1 : 1;
      this.measurement = order[(index + order.length + direction) % order.length] ?? "tokens";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right) ||
      data.toLowerCase() === "h" ||
      data.toLowerCase() === "l"
    ) {
      const direction = matchesKey(data, Key.left) || data.toLowerCase() === "h" ? -1 : 1;
      this.rangeIndex = (this.rangeIndex + RANGE_DAYS.length + direction) % RANGE_DAYS.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (data === "[" || data === "]" || data.toLowerCase() === "p" || data.toLowerCase() === "n") {
      const direction = data === "[" || data.toLowerCase() === "p" ? -1 : 1;
      this.tabIndex = (this.tabIndex + this.data.tabs.length + direction) % this.data.tabs.length;
      this.ensureLiveUsageLoaded();
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      data.toLowerCase() === "j" ||
      data.toLowerCase() === "k"
    ) {
      const views: BreakdownView[] = ["model", "cwd", "dow", "tod"];
      const index = views.indexOf(this.view);
      const direction = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
      this.view = views[(index + views.length + direction) % views.length] ?? "model";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    const rangeByKey: Record<string, number> = { "1": 0, "2": 1, "3": 2 };
    if (Object.hasOwn(rangeByKey, data)) {
      this.rangeIndex = rangeByKey[data]!;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const tab = this.data.tabs[this.tabIndex]!;
    const selectedDays = RANGE_DAYS[this.rangeIndex]!;
    const range =
      tab.mode === "all"
        ? this.data.allRanges.get(selectedDays)!
        : (this.data.providerRangesById.get(tab.id)?.get(selectedDays) ??
          getEmptyRange(selectedDays));
    const palette =
      tab.mode === "all"
        ? this.data.allPalette
        : (this.data.providerPalettes.get(tab.id) ?? {
            modelPalette: {
              modelColors: new Map<ModelKey, RGB>(),
              otherColor: MUTED_COLOR,
              orderedModels: [],
            },
            cwdPalette: {
              cwdColors: new Map<CwdKey, RGB>(),
              otherColor: MUTED_COLOR,
              orderedCwds: [],
            },
          });
    const liveState = tab.liveProvider ? this.data.liveUsage.get(tab.liveProvider.id) : undefined;
    const metric = graphMetricForRange(range, this.measurement);

    const providerBadge = bold(`[${tab.shortLabel}]`);
    const rangeTab = (days: number, index: number): string =>
      index === this.rangeIndex ? bold(`[${days}d]`) : dim(` ${days}d `);
    const metricTab = (mode: MeasurementMode, label: string): string =>
      mode === this.measurement ? bold(`[${label}]`) : dim(` ${label} `);
    const viewTab = (candidate: BreakdownView, label: string): string =>
      candidate === this.view ? bold(`[${label}]`) : dim(` ${label} `);

    const header =
      `${bold("Usage")}  ${providerBadge}${dim(` ${this.tabIndex + 1}/${this.data.tabs.length}`)}  ` +
      `${rangeTab(7, 0)}${rangeTab(30, 1)}${rangeTab(90, 2)}  ` +
      `${metricTab("sessions", "sess")}${metricTab("messages", "msg")}${metricTab("tokens", "tok")}  ` +
      `${viewTab("model", "model")}${viewTab("cwd", "cwd")}${viewTab("dow", "dow")}${viewTab("tod", "tod")}`;

    const lines: string[] = [];
    lines.push(truncateToWidth(header, width));
    lines.push(
      truncateToWidth(dim("[/] provider · ←/→ range · ↑/↓ view · tab metric · q to close"), width),
    );
    lines.push(truncateToWidth(`${bold(tab.label)}  ${dim(historySemanticsText(tab))}`, width));
    lines.push("");

    const liveLines = renderLiveUsageLines(tab, liveState, width);
    if (liveLines.length > 0) {
      for (const line of liveLines) lines.push(truncateToWidth(line, width));
      lines.push("");
    }

    const graphDescriptor =
      this.view === "dow" ? `share of ${metric.kind} by weekday` : `${metric.kind}/day`;
    lines.push(
      truncateToWidth(
        `${rangeSummary(range, selectedDays, metric.kind)}${dim(`   (graph: ${graphDescriptor})`)}`,
        width,
      ),
    );
    lines.push("");

    let activeColorMap: Map<string, RGB>;
    let activeOtherColor = MUTED_COLOR;
    const legendItems: string[] = [];
    const stripProvider = tab.mode === "provider";

    if (this.view === "model") {
      activeColorMap = palette.modelPalette.modelColors;
      activeOtherColor = palette.modelPalette.otherColor;
      for (const model of palette.modelPalette.orderedModels) {
        const color = activeColorMap.get(model);
        if (color)
          legendItems.push(`${ansiFg(color, "█")} ${formatModelLabel(model, stripProvider)}`);
      }
      legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
    } else if (this.view === "cwd") {
      activeColorMap = palette.cwdPalette.cwdColors;
      activeOtherColor = palette.cwdPalette.otherColor;
      for (const cwd of palette.cwdPalette.orderedCwds) {
        const color = activeColorMap.get(cwd);
        if (color) legendItems.push(`${ansiFg(color, "█")} ${abbreviatePath(cwd, 30)}`);
      }
      legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
    } else if (this.view === "dow") {
      activeColorMap = this.data.dowPalette.dowColors;
      for (const dow of this.data.dowPalette.orderedDows) {
        const color = activeColorMap.get(dow);
        if (color) legendItems.push(`${ansiFg(color, "█")} ${dow}`);
      }
    } else {
      activeColorMap = this.data.todPalette.todColors;
      for (const tod of this.data.todPalette.orderedTods) {
        const color = activeColorMap.get(tod);
        if (color) legendItems.push(`${ansiFg(color, "█")} ${todBucketLabel(tod)}`);
      }
    }

    let graphLines: string[];
    if (this.view === "dow") {
      graphLines = renderDowDistributionLines(
        range,
        this.measurement,
        this.data.dowPalette.dowColors,
        width,
      );
    } else {
      const maxScale = selectedDays === 7 ? 4 : selectedDays === 30 ? 3 : 2;
      const weeks = weeksForRange(range);
      const leftMargin = 4;
      const gap = 1;
      const graphArea = Math.max(1, width - leftMargin);
      const idealCellWidth = Math.floor((graphArea + gap) / Math.max(1, weeks)) - gap;
      const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));
      graphLines = renderGraphLines(
        range,
        activeColorMap,
        activeOtherColor,
        this.measurement,
        { cellWidth, gap },
        this.view,
        weeks,
      );
    }

    const tableLines =
      this.view === "model"
        ? renderModelTable(range, metric, 8, { stripProvider })
        : this.view === "cwd"
          ? renderCwdTable(range, metric, 8)
          : this.view === "dow"
            ? renderDowTable(range, metric)
            : renderTodTable(range, metric);

    if (this.view === "dow") {
      for (const line of graphLines) lines.push(truncateToWidth(line, width));
    } else {
      const graphWidth = Math.max(0, ...graphLines.map((line) => visibleWidth(line)));
      const separator = 2;
      const legendWidth = width - graphWidth - separator;
      const showSideLegend = legendWidth >= 22;

      if (showSideLegend) {
        const legendTitle =
          this.view === "model"
            ? "Top models (30d palette):"
            : this.view === "cwd"
              ? "Top directories (30d palette):"
              : "Time of day:";
        const legendBlock = [dim(legendTitle), ...legendItems];
        const maxLegendRows = graphLines.length;
        let legendLines = legendBlock.slice(0, maxLegendRows);
        if (legendBlock.length > maxLegendRows) {
          const remaining = legendBlock.length - (maxLegendRows - 1);
          legendLines = [...legendBlock.slice(0, maxLegendRows - 1), dim(`+${remaining} more`)];
        }
        while (legendLines.length < graphLines.length) legendLines.push("");

        const padRightAnsi = (value: string, targetWidth: number): string => {
          const currentWidth = visibleWidth(value);
          return currentWidth >= targetWidth
            ? value
            : value + " ".repeat(targetWidth - currentWidth);
        };

        for (let index = 0; index < graphLines.length; index += 1) {
          const left = padRightAnsi(graphLines[index] ?? "", graphWidth);
          const right = truncateToWidth(legendLines[index] ?? "", Math.max(0, legendWidth));
          lines.push(truncateToWidth(left + " ".repeat(separator) + right, width));
        }
      } else {
        for (const line of graphLines) lines.push(truncateToWidth(line, width));
        lines.push("");
        const legendTitle =
          this.view === "model"
            ? "Top models (30d palette):"
            : this.view === "cwd"
              ? "Top directories (30d palette):"
              : "Time of day:";
        lines.push(truncateToWidth(dim(legendTitle), width));
        for (const item of legendItems) lines.push(truncateToWidth(item, width));
      }
    }

    lines.push("");
    for (const line of tableLines) lines.push(truncateToWidth(line, width));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return this.cachedLines;
  }
}

export default function usageBreakdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description:
      "Interactive Pi usage breakdown with an all-providers historical view plus live quota details for supported providers",
    handler: async (_args, ctx: ExtensionContext) => {
      const liveUsageAvailability = await getLiveUsageAvailabilityMap(ctx);

      if (!ctx.hasUI) {
        const [data, liveUsage] = await Promise.all([
          computeBreakdown(liveUsageAvailability, undefined),
          fetchLiveUsage(SUPPORTED_PROVIDERS, liveUsageAvailability, ctx, undefined),
        ]);
        data.liveUsage = liveUsage;
        pi.sendMessage(
          {
            customType: "usage",
            content: renderNonInteractiveSummary(data),
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      let aborted = false;
      const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Analyzing usage…");
        const startedAt = Date.now();
        const progress: BreakdownProgressState = {
          phase: "scan",
          foundFiles: 0,
          parsedFiles: 0,
          totalFiles: 0,
        };

        const renderMessage = (): string => {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          if (progress.phase === "scan") {
            return `Analyzing usage… scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
          }
          if (progress.phase === "parse") {
            return `Analyzing usage… parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
          }
          return `Analyzing usage… finalizing · ${elapsed}s`;
        };

        let intervalId: NodeJS.Timeout | null = null;
        const stopTicker = () => {
          if (!intervalId) return;
          clearInterval(intervalId);
          intervalId = null;
        };

        setBorderedLoaderMessage(loader, renderMessage());
        intervalId = setInterval(() => {
          setBorderedLoaderMessage(loader, renderMessage());
        }, 500);

        loader.onAbort = () => {
          aborted = true;
          stopTicker();
          done(null);
        };

        computeBreakdown(liveUsageAvailability, loader.signal, (update) =>
          Object.assign(progress, update),
        )
          .then((result) => {
            stopTicker();
            if (!aborted) done(result);
          })
          .catch((error) => {
            stopTicker();
            if (!aborted) {
              console.error("usage: failed to analyze usage", error);
              done(null);
            }
          });

        return loader;
      });

      if (!data) {
        ctx.ui.notify(
          aborted ? "Cancelled" : "Failed to analyze usage",
          aborted ? "info" : "error",
        );
        return;
      }

      const allRange = data.allRanges.get(30)!;
      const hasHistory =
        allRange.sessions > 0 || allRange.totalMessages > 0 || allRange.totalTokens > 0;
      const hasLiveQuotaSources = [...liveUsageAvailability.values()].some(
        (availability) => availability.available,
      );
      if (!hasHistory && !hasLiveQuotaSources) {
        ctx.ui.notify("No live or historical usage data found.", "warning");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) =>
          new UsageBreakdownComponent(data, tui, done, (provider, signal) =>
            fetchLiveUsageForProvider(provider, liveUsageAvailability, ctx, signal),
          ),
      );
    },
  });
}
