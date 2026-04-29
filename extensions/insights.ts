import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  SessionManager,
  buildSessionContext,
  getAgentDir,
  getLanguageFromPath,
  getMarkdownTheme,
  migrateSessionEntries,
  parseSessionEntries,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionHeader,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// --- Constants ---

const INSIGHTS_META_SCHEMA_VERSION = 1;
const SESSION_FINGERPRINT_VERSION = 1;
const INSIGHTS_FACET_SCHEMA_VERSION = 1;
const FACET_PROMPT_VERSION = 1;
const SYNTHESIS_PROMPT_VERSION = 1;

const MIN_MEANINGFUL_USER_MESSAGES = 2;
const MIN_DURATION_MINUTES = 1;

const FULL_TRANSCRIPT_MAX_CHARS = 30_000;
const REDUCED_TRANSCRIPT_HEAD_CHARS = 12_000;
const REDUCED_TRANSCRIPT_TAIL_CHARS = 12_000;
const REDUCED_TRANSCRIPT_MAX_CHARS = FULL_TRANSCRIPT_MAX_CHARS;

const AGENT_ROOT = getAgentDir();
const CACHE_ROOT = path.join(AGENT_ROOT, "insights");
const META_CACHE_DIR = path.join(CACHE_ROOT, "session-meta");
const FACET_CACHE_DIR = path.join(CACHE_ROOT, "session-facets");

const GOAL_CATEGORIES = [
  "debug_investigate",
  "implement_feature",
  "fix_bug",
  "refactor_code",
  "write_tests",
  "write_docs",
  "analyze_data",
  "understand_codebase",
  "configure_system",
  "automation_workflow",
  "quick_question",
] as const;

const FRICTION_CATEGORIES = [
  "misunderstood_request",
  "wrong_approach",
  "buggy_code",
  "too_much_change",
  "tool_failed",
  "environment_issue",
  "context_missing",
  "branch_confusion",
] as const;

const FACET_SYSTEM_PROMPT = `You analyze one Pi coding session and extract structured JSON.

Return valid JSON only. No markdown. No prose outside JSON.

Schema:
{
  "underlyingGoal": string,
  "goalCategories": string[],
  "outcome": "achieved" | "partial" | "blocked" | "unclear",
  "frictionCategories": string[],
  "frictionDetail": string,
  "briefSummary": string,
  "explicitInstructionsToRemember": string[],
  "repeatedWorkflowHints": string[]
}

Allowed goalCategories:
${GOAL_CATEGORIES.map((item) => `- ${item}`).join("\n")}

Allowed frictionCategories:
${FRICTION_CATEGORIES.map((item) => `- ${item}`).join("\n")}

Rules:
- Count only what the user actually wanted.
- Pick 1-3 goal categories when the session is clear. Use [] only if the goal is genuinely unclear.
- Outcome should reflect whether the user's requested result was achieved.
- Friction should stay concrete and session-specific. Use [] when there was no meaningful friction.
- frictionDetail should be concise and empty when there was no meaningful friction.
- briefSummary should be at most 2 sentences.
- explicitInstructionsToRemember should contain only direct, reusable user instructions worth remembering later.
- repeatedWorkflowHints should capture reusable workflows or collaboration patterns, not one-off task details.
- Keep arrays short, deduplicated, and high-signal.
- Self-check that JSON.parse(output) would succeed before responding.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are writing a Pi /insights report.

Return Markdown only.

Use exactly these sections in this order:
1. ## At a glance
2. ## What you use Pi for
3. ## How you tend to work with Pi
4. ## Repeated instructions worth moving into AGENTS.md
5. ## Good prompt template candidates
6. ## Good skill candidates
7. ## Good extension candidates
8. ## Where things go wrong
9. ## Quick wins

Rules:
- Be concrete and direct.
- Avoid fluff.
- Prefer fewer, stronger recommendations over long weak lists.
- Base recommendations on repeated evidence, not one-off anecdotes.
- For every AGENTS.md / prompt template / skill / extension recommendation, explain why it belongs in that bucket.
- If evidence is weak for a section, say so briefly instead of inventing material.
- Do not mention implementation details of this analytics pipeline.`;

// --- Types ---

type InsightScope = "current" | "project" | "all";

type ConfiguredModelSelection = {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
};

type ReadonlySessionManager = Pick<
  SessionManager,
  | "getEntries"
  | "getBranch"
  | "getLeafId"
  | "getHeader"
  | "getSessionDir"
  | "getSessionId"
  | "getSessionFile"
>;

type SessionTarget = {
  path?: string;
  manager?: ReadonlySessionManager;
};

type SessionRuntime = {
  manager: ReadonlySessionManager;
  transcript?: NormalizedTranscript;
};

type SessionCacheInfo = {
  cacheKey?: string;
  fingerprint?: string;
};

type SessionMeta = {
  schemaVersion: number;
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
  fingerprint: string;
  startedAt?: string;
  endedAt?: string;
  durationMinutes: number;
  totalEntries: number;
  pathEntries: number;
  branchCount: number;
  compactionCount: number;
  branchSummaryCount: number;
  meaningfulUserMessages: number;
  assistantMessages: number;
  toolResultMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost?: number;
  toolCounts: Record<string, number>;
  toolsWithErrors: Record<string, number>;
  modifiedFiles: string[];
  languages: Record<string, number>;
  firstUserPrompt?: string;
  transcriptCharLength: number;
  isTrivial: boolean;
};

type TranscriptBlock = {
  kind:
    | "user"
    | "assistant"
    | "toolCall"
    | "toolResult"
    | "bashExecution"
    | "compactionSummary"
    | "branchSummary";
  text: string;
  isSummary?: boolean;
};

type NormalizedTranscript = {
  sessionFile: string;
  fingerprint: string;
  blockCount: number;
  charLength: number;
  text?: string;
  blocks: TranscriptBlock[];
  headerText: string;
};

type PreparedTranscript = {
  text: string;
  fullCharLength: number;
  usedReducedTranscript: boolean;
};

type SessionFacet = {
  schemaVersion: number;
  promptVersion: number;
  fingerprint: string;
  underlyingGoal: string;
  goalCategories: string[];
  outcome: "achieved" | "partial" | "blocked" | "unclear";
  frictionCategories: string[];
  frictionDetail?: string;
  briefSummary: string;
  explicitInstructionsToRemember: string[];
  repeatedWorkflowHints: string[];
};

type SessionAnalysis = {
  meta: SessionMeta;
  facet?: SessionFacet;
};

type RepeatedEvidence = {
  text: string;
  count: number;
};

type InsightsAggregate = {
  scope: InsightScope;
  sessionsConsidered: number;
  sessionsAnalyzed: number;
  sessionsWithFacets: number;
  sessionsSkipped: number;
  dateRange: {
    start?: string;
    end?: string;
  };
  projects: Record<string, number>;
  goalCategories: Record<string, number>;
  frictionCategories: Record<string, number>;
  toolCounts: Record<string, number>;
  languages: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost?: number;
  repeatedInstructions: RepeatedEvidence[];
  repeatedWorkflows: RepeatedEvidence[];
  representativeSessions: Array<{
    sessionFile: string;
    cwd?: string;
    startedAt?: string;
    summary: string;
    goal: string;
    outcome: SessionFacet["outcome"];
  }>;
};

type InsightsResult = {
  scope: InsightScope;
  generatedAt: string;
  modelId?: string;
  aggregate: InsightsAggregate;
  reportMarkdown: string;
};

type ProgressStage = "resolve" | "metadata" | "facets" | "aggregate" | "synthesize";

type ProgressState = {
  stage: ProgressStage;
  current: number;
  total: number;
  metaCacheHits: number;
  facetCacheHits: number;
};

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

class InsightsReportComponent implements Component {
  private readonly markdown: Markdown;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private cachedBodyWidth?: number;
  private cachedBodyLines?: string[];

  constructor(
    private readonly result: InsightsResult,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onDone: () => void,
  ) {
    this.markdown = new Markdown(result.reportMarkdown, 0, 0, getMarkdownTheme());
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedBodyWidth = undefined;
    this.cachedBodyLines = undefined;
    this.markdown.invalidate();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    ) {
      this.onDone();
      return;
    }

    const bodyHeight = this.getBodyHeight();
    const boxWidth = this.getBoxWidth(this.tui.terminal.columns);
    const bodyLines = this.getBodyLines(this.getContentWidth(boxWidth));
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);

    if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(4, bodyHeight - 2));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + Math.max(4, bodyHeight - 2));
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = maxScroll;
    } else {
      return;
    }

    this.invalidateFrame();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    const boxWidth = this.getBoxWidth(width);
    const contentWidth = this.getContentWidth(boxWidth);
    const bodyLines = this.getBodyLines(contentWidth);
    const bodyHeight = this.getBodyHeight();
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll);

    const title = this.theme.fg("accent", this.theme.bold("Insights"));
    const metadata = [
      `${this.result.aggregate.scope} scope · ${formatCount(this.result.aggregate.sessionsAnalyzed)} analyzed · ${formatCount(this.result.aggregate.sessionsWithFacets)} classified`,
      `${this.result.modelId ?? "current model"} · generated ${formatIsoShort(this.result.generatedAt)}`,
    ];

    const lines: string[] = [];
    lines.push(this.borderLine("╭", "╮", boxWidth));
    lines.push(this.boxLine(title, boxWidth));
    for (const line of metadata) {
      for (const wrapped of wrapTextWithAnsi(this.theme.fg("muted", line), contentWidth)) {
        lines.push(this.boxLine(wrapped, boxWidth));
      }
    }
    lines.push(this.separatorLine(boxWidth));

    const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    for (const line of visibleBody) {
      lines.push(this.boxLine(line, boxWidth));
    }
    for (let i = visibleBody.length; i < bodyHeight; i++) {
      lines.push(this.boxLine("", boxWidth));
    }

    lines.push(this.separatorLine(boxWidth));
    const scrollText = `${formatCount(Math.min(bodyLines.length, this.scrollOffset + 1))}-${formatCount(Math.min(bodyLines.length, this.scrollOffset + visibleBody.length))}/${formatCount(bodyLines.length)}`;
    const controls = `${this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn jump · Home/End · Enter/Esc close")} ${this.theme.fg("muted", scrollText)}`;
    lines.push(this.boxLine(truncateToWidth(controls, contentWidth), boxWidth));
    lines.push(this.borderLine("╰", "╯", boxWidth));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private getBodyHeight(): number {
    return Math.max(10, this.tui.terminal.rows - 10);
  }

  private invalidateFrame(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private getBodyLines(contentWidth: number): string[] {
    if (this.cachedBodyWidth === contentWidth && this.cachedBodyLines) {
      return this.cachedBodyLines;
    }

    const lines = this.markdown.render(contentWidth);
    this.cachedBodyWidth = contentWidth;
    this.cachedBodyLines = lines;
    return lines;
  }

  private getBoxWidth(width: number): number {
    return Math.max(40, Math.min(width - 2, 140));
  }

  private getContentWidth(boxWidth: number): number {
    return Math.max(10, boxWidth - 4);
  }

  private borderLine(left: string, right: string, width: number): string {
    return this.theme.fg("borderMuted", `${left}${"─".repeat(width - 2)}${right}`);
  }

  private separatorLine(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`);
  }

  private boxLine(content: string, width: number): string {
    const padded = ` ${content}`;
    const visible = visibleWidth(padded);
    const rightPad = Math.max(0, width - 2 - visible);
    return `${this.theme.fg("borderMuted", "│")}${padded}${" ".repeat(rightPad)}${this.theme.fg("borderMuted", "│")}`;
  }
}

// --- Helpers ---

export default function insightsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("insights", {
    description:
      "Analyze Pi sessions and suggest reusable instructions, templates, skills, and extensions",
    getArgumentCompletions: (prefix) => getScopeCompletions(prefix),
    handler: async (args, ctx) => {
      await runInsightsCommand(args, ctx);
    },
  });
}

async function runInsightsCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    ctx.ui.notify(parsed.error, "warning");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("/insights currently requires interactive mode", "warning");
    return;
  }

  let aborted = false;
  let caughtError: unknown;
  const selectionPromise = getConfiguredModelSelection(ctx);

  const result = await ctx.ui.custom<InsightsResult | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Analyzing sessions...");
    const progress: ProgressState = {
      stage: "resolve",
      current: 0,
      total: 0,
      metaCacheHits: 0,
      facetCacheHits: 0,
    };

    const startedAt = Date.now();
    let interval: NodeJS.Timeout | null = null;

    const renderMessage = (): string => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      return renderProgressMessage(progress, elapsed);
    };

    const stopTicker = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    setBorderedLoaderMessage(loader, renderMessage());
    interval = setInterval(() => {
      setBorderedLoaderMessage(loader, renderMessage());
    }, 1000);

    loader.onAbort = () => {
      aborted = true;
      stopTicker();
      done(null);
    };

    void (async () => {
      try {
        const selection = await selectionPromise;
        const runResult = await runInsightsPipeline(
          parsed.scope,
          ctx,
          selection,
          loader.signal,
          (update) => {
            Object.assign(progress, update);
          },
        );
        stopTicker();
        if (!aborted) done(runResult);
      } catch (error) {
        stopTicker();
        caughtError = error;
        if (!aborted) done(null);
      }
    })();

    return loader;
  });

  if (!result) {
    if (aborted || isAbortError(caughtError)) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const message =
      caughtError instanceof Error ? caughtError.message : "Failed to analyze sessions";
    ctx.ui.notify(message, "error");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return new InsightsReportComponent(result, tui, theme, done);
  });
}

async function runInsightsPipeline(
  scope: InsightScope,
  ctx: ExtensionCommandContext,
  selection: ConfiguredModelSelection | null,
  signal: AbortSignal,
  onProgress: (update: Partial<ProgressState>) => void,
): Promise<InsightsResult> {
  if (!selection) {
    throw new Error("No configured Pi model is available for /insights");
  }

  const targets = await listTargets(scope, ctx, signal, onProgress);
  throwIfAborted(signal);

  const analyses: SessionAnalysis[] = [];
  let metaCacheHits = 0;
  let facetCacheHits = 0;
  let facetAttempts = 0;
  let facetFailures = 0;
  let lastFacetError: unknown;

  for (let index = 0; index < targets.length; index++) {
    throwIfAborted(signal);
    onProgress({
      stage: "metadata",
      current: index + 1,
      total: targets.length,
      metaCacheHits,
      facetCacheHits,
    });

    const target = targets[index]!;
    try {
      const loaded = await loadOrExtractMeta(target, signal);
      if (loaded.cacheHit) metaCacheHits++;
      onProgress({ metaCacheHits, facetCacheHits });
      if (!loaded.meta || loaded.meta.isTrivial) continue;

      let facet: SessionFacet | undefined;
      facetAttempts++;
      onProgress({
        stage: "facets",
        current: index + 1,
        total: targets.length,
        metaCacheHits,
        facetCacheHits,
      });

      try {
        const classified = await loadOrExtractFacet(
          target,
          loaded.meta,
          loaded.cacheInfo,
          loaded.runtime,
          selection,
          signal,
        );
        if (classified.cacheHit) {
          facetCacheHits++;
          onProgress({ facetCacheHits });
        }
        facet = classified.facet;
      } catch (error) {
        if (isAbortError(error)) throw error;
        facetFailures++;
        lastFacetError = error;
      } finally {
        if (loaded.runtime) {
          loaded.runtime.transcript = undefined;
        }
      }

      analyses.push(facet ? { meta: loaded.meta, facet } : { meta: loaded.meta });
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Skip malformed or unreadable sessions.
      continue;
    }
  }

  if (analyses.length === 0) {
    const aggregate = buildAggregate(scope, targets.length, analyses);
    return {
      scope,
      generatedAt: new Date().toISOString(),
      modelId: selection.model.id,
      aggregate,
      reportMarkdown: buildDeterministicReport(aggregate),
    };
  }

  if (facetAttempts > 0 && facetFailures === facetAttempts && lastFacetError) {
    throw lastFacetError;
  }

  throwIfAborted(signal);
  onProgress({ stage: "aggregate", current: 1, total: 1, metaCacheHits, facetCacheHits });
  const aggregate = buildAggregate(scope, targets.length, analyses);

  throwIfAborted(signal);
  onProgress({ stage: "synthesize", current: 1, total: 1, metaCacheHits, facetCacheHits });

  let reportMarkdown = buildDeterministicReport(aggregate);
  if (aggregate.sessionsWithFacets > 0) {
    try {
      reportMarkdown = await synthesizeReport(aggregate, selection, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      reportMarkdown = prependReportNotice(
        buildDeterministicReport(aggregate),
        "Final synthesis failed. Showing deterministic fallback.",
      );
    }
  }

  return {
    scope,
    generatedAt: new Date().toISOString(),
    modelId: selection.model.id,
    aggregate,
    reportMarkdown,
  };
}

function parseArgs(args: string | undefined): { scope: InsightScope } | { error: string } {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { scope: "project" };

  const eqMatch = trimmed.match(/^scope=(current|project|all)$/);
  if (eqMatch) {
    return { scope: eqMatch[1] as InsightScope };
  }

  return { error: "Usage: /insights [scope=current|project|all]" };
}

function getScopeCompletions(
  prefix: string,
): Array<{ value: string; label: string; description: string }> | null {
  const trimmed = prefix.trimStart();
  const options: InsightScope[] = ["current", "project", "all"];

  if (!trimmed) {
    return [{ value: "scope=", label: "scope=", description: "Choose current, project, or all" }];
  }

  if (trimmed === "scope=") {
    return options.map((value) => ({
      value: `scope=${value}`,
      label: value,
      description: describeScope(value),
    }));
  }

  const eqMatch = trimmed.match(/^scope=(\S*)$/);
  if (!eqMatch) return null;

  const valuePrefix = eqMatch[1] ?? "";
  const items = options
    .filter((value) => value.startsWith(valuePrefix))
    .map((value) => ({ value: `scope=${value}`, label: value, description: describeScope(value) }));
  return items.length > 0 ? items : null;
}

function describeScope(scope: InsightScope): string {
  switch (scope) {
    case "current":
      return "Analyze only the active session";
    case "project":
      return "Analyze sessions for the current cwd";
    case "all":
      return "Analyze all Pi sessions";
  }
}

async function getConfiguredModelSelection(
  ctx: Pick<ExtensionCommandContext, "model" | "modelRegistry">,
): Promise<ConfiguredModelSelection | null> {
  if (!ctx.model) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return null;
  return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers };
}

async function listTargets(
  scope: InsightScope,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  onProgress: (update: Partial<ProgressState>) => void,
): Promise<SessionTarget[]> {
  throwIfAborted(signal);

  if (scope === "current") {
    onProgress({ stage: "resolve", current: 1, total: 1 });
    return [{ path: ctx.sessionManager.getSessionFile(), manager: ctx.sessionManager }];
  }

  const progress = (current: number, total: number): void => {
    onProgress({ stage: "resolve", current, total });
  };

  const sessionFiles =
    scope === "project"
      ? await listProjectSessionFiles(ctx.cwd, ctx.sessionManager.getSessionDir(), progress)
      : await listAllSessionFiles(progress);

  throwIfAborted(signal);
  return sessionFiles.map((sessionFile) => ({ path: sessionFile }));
}

async function listProjectSessionFiles(
  cwd: string,
  sessionDir: string,
  onProgress: (current: number, total: number) => void,
): Promise<string[]> {
  const currentCwd = path.resolve(cwd);
  const sessions = await SessionManager.list(currentCwd, sessionDir, onProgress);
  return sessions
    .filter((session) => path.resolve(session.cwd || currentCwd) === currentCwd)
    .map((session) => session.path);
}

async function listAllSessionFiles(
  onProgress: (current: number, total: number) => void,
): Promise<string[]> {
  const sessions = await SessionManager.listAll(onProgress);
  return sessions.map((session) => session.path);
}

async function loadOrExtractMeta(
  target: SessionTarget,
  signal: AbortSignal,
): Promise<{
  meta: SessionMeta | null;
  cacheInfo: SessionCacheInfo;
  cacheHit: boolean;
  runtime?: SessionRuntime;
}> {
  const cacheInfo = await getCacheInfo(target.path);

  if (cacheInfo.cacheKey && cacheInfo.fingerprint) {
    const cached = await readMetaCache(cacheInfo.cacheKey, cacheInfo.fingerprint);
    if (cached) {
      return { meta: cached, cacheInfo, cacheHit: true };
    }
  }

  throwIfAborted(signal);
  const manager = await openTargetSession(target);
  const extracted = extractSessionArtifacts(manager, target, cacheInfo.fingerprint);

  if (cacheInfo.cacheKey && cacheInfo.fingerprint) {
    try {
      await writeMetaCache(cacheInfo.cacheKey, extracted.meta, signal);
    } catch {
      // Cache writes are best-effort.
    }
  }

  return {
    meta: extracted.meta,
    cacheInfo,
    cacheHit: false,
    runtime: extracted.transcript ? { manager, transcript: extracted.transcript } : undefined,
  };
}

async function loadOrExtractFacet(
  target: SessionTarget,
  meta: SessionMeta,
  cacheInfo: SessionCacheInfo,
  runtime: SessionRuntime | undefined,
  selection: ConfiguredModelSelection,
  signal: AbortSignal,
): Promise<{ facet?: SessionFacet; cacheHit: boolean }> {
  if (cacheInfo.cacheKey) {
    const cached = await readFacetCache(cacheInfo.cacheKey, meta.fingerprint);
    if (cached) {
      return { facet: cached, cacheHit: true };
    }
  }

  throwIfAborted(signal);
  const manager = runtime?.manager ?? (await openTargetSession(target));
  const transcript =
    runtime?.transcript ??
    buildNormalizedTranscript(manager.getEntries(), manager.getLeafId(), meta);
  const preparedTranscript = prepareTranscriptForFacet(transcript);
  const facet = await extractFacet(meta, preparedTranscript, selection, signal);

  if (cacheInfo.cacheKey) {
    try {
      await writeFacetCache(cacheInfo.cacheKey, facet, signal);
    } catch {
      // Cache writes are best-effort.
    }
  }

  return { facet, cacheHit: false };
}

async function openTargetSession(target: SessionTarget): Promise<ReadonlySessionManager> {
  if (target.manager) return target.manager;
  if (!target.path) {
    throw new Error("Session has no file path");
  }
  return await readOnlyOpenSession(target.path);
}

async function readOnlyOpenSession(sessionFile: string): Promise<ReadonlySessionManager> {
  const content = await fs.readFile(sessionFile, "utf8");
  const fileEntries = parseSessionEntries(content);
  if (fileEntries.length === 0) {
    throw new Error(`Session file is empty or invalid: ${sessionFile}`);
  }

  migrateSessionEntries(fileEntries);
  const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
  if (!header) {
    throw new Error(`Session file has no header: ${sessionFile}`);
  }

  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leafId = entries.at(-1)?.id ?? null;
  const sessionDir = path.dirname(sessionFile);

  return {
    getEntries() {
      return entries.slice();
    },
    getBranch(fromId?: string) {
      const startId = fromId ?? leafId;
      if (!startId) return [];
      const pathEntries: SessionEntry[] = [];
      let current = byId.get(startId);
      while (current) {
        pathEntries.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return pathEntries;
    },
    getLeafId() {
      return leafId;
    },
    getHeader() {
      return header;
    },
    getSessionDir() {
      return sessionDir;
    },
    getSessionId() {
      return header.id;
    },
    getSessionFile() {
      return sessionFile;
    },
  } satisfies ReadonlySessionManager;
}

function extractSessionArtifacts(
  manager: ReadonlySessionManager,
  target: SessionTarget,
  fingerprint: string | undefined,
): { meta: SessionMeta; transcript?: NormalizedTranscript } {
  const header = manager.getHeader();
  const entries = manager.getEntries();
  const leafId = manager.getLeafId();
  const branchEntries = manager.getBranch();
  const normalizedCwd = normalizeOptionalText(header?.cwd);

  const startedAt = firstTimestamp(branchEntries) ?? header?.timestamp;
  const endedAt = lastTimestamp(branchEntries) ?? header?.timestamp;
  const durationMinutes = computeDurationMinutes(startedAt, endedAt);

  const toolCounts: Record<string, number> = {};
  const toolsWithErrors: Record<string, number> = {};
  const modifiedFiles = new Set<string>();

  let meaningfulUserMessages = 0;
  let assistantMessages = 0;
  let toolResultMessages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let firstUserPrompt: string | undefined;

  for (const entry of branchEntries) {
    collectModifiedFilesFromEntry(entry, modifiedFiles);

    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "user") {
      if (isMeaningfulUserMessage(message)) {
        meaningfulUserMessages++;
        if (!firstUserPrompt) {
          firstUserPrompt = cleanOneLine(extractMessageText(message.content, true), 240);
        }
      }
      continue;
    }

    if (role === "assistant") {
      assistantMessages++;
      const usage = isRecord(message.usage) ? message.usage : undefined;
      totalInputTokens +=
        numberValue(usage?.input) + numberValue(usage?.cacheRead) + numberValue(usage?.cacheWrite);
      totalOutputTokens += numberValue(usage?.output);
      totalCost += numberValue(isRecord(usage?.cost) ? usage?.cost.total : undefined);

      const toolCalls = extractToolCalls(message.content);
      for (const toolCall of toolCalls) {
        incrementRecord(toolCounts, toolCall.name);
        collectModifiedFilesFromToolCall(toolCall.name, toolCall.arguments, modifiedFiles);
      }
      continue;
    }

    if (role === "toolResult") {
      toolResultMessages++;
      if (message.isError === true && typeof message.toolName === "string") {
        incrementRecord(toolsWithErrors, message.toolName);
      }
    }
  }

  const resolvedFingerprint =
    fingerprint ??
    fallbackFingerprint(
      entries.length,
      manager.getSessionId(),
      leafId,
      lastTimestamp(branchEntries),
      target.path,
    );

  const baseMeta: Omit<SessionMeta, "transcriptCharLength" | "isTrivial"> = {
    schemaVersion: INSIGHTS_META_SCHEMA_VERSION,
    sessionFile: normalizeSessionFile(target.path),
    sessionId: header?.id,
    cwd: normalizedCwd,
    fingerprint: resolvedFingerprint,
    startedAt,
    endedAt,
    durationMinutes,
    totalEntries: entries.length,
    pathEntries: branchEntries.length,
    branchCount: countBranchPoints(entries),
    compactionCount: entries.filter((entry: SessionEntry) => entry.type === "compaction").length,
    branchSummaryCount: entries.filter((entry: SessionEntry) => entry.type === "branch_summary")
      .length,
    meaningfulUserMessages,
    assistantMessages,
    toolResultMessages,
    totalInputTokens,
    totalOutputTokens,
    totalCost: totalCost > 0 ? roundNumber(totalCost, 6) : undefined,
    toolCounts,
    toolsWithErrors,
    modifiedFiles: [...modifiedFiles].sort(),
    languages: buildLanguageSummary(modifiedFiles),
    firstUserPrompt,
  };

  if (
    meaningfulUserMessages < MIN_MEANINGFUL_USER_MESSAGES ||
    durationMinutes < MIN_DURATION_MINUTES
  ) {
    return {
      meta: {
        ...baseMeta,
        transcriptCharLength: 0,
        isTrivial: true,
      },
    };
  }

  const transcript = buildNormalizedTranscript(entries, leafId, {
    sessionFile: normalizeSessionFile(target.path),
    sessionId: header?.id,
    cwd: normalizedCwd,
    fingerprint: resolvedFingerprint,
    startedAt,
    durationMinutes,
  });

  return {
    meta: {
      ...baseMeta,
      transcriptCharLength: transcript.charLength,
      isTrivial: transcript.blockCount === 0,
    },
    transcript,
  };
}

function buildNormalizedTranscript(
  entries: SessionEntry[],
  leafId: string | null,
  meta: Pick<
    SessionMeta,
    "sessionFile" | "sessionId" | "cwd" | "startedAt" | "durationMinutes" | "fingerprint"
  >,
): NormalizedTranscript {
  const context = buildSessionContext(entries, leafId);
  const headerLines = [
    `Session: ${meta.sessionId ?? path.basename(meta.sessionFile)}`,
    `CWD: ${meta.cwd ?? "(unknown)"}`,
    `Started: ${meta.startedAt ?? "(unknown)"}`,
    `Duration: ${formatDuration(meta.durationMinutes)}`,
  ];
  const headerText = headerLines.join("\n");

  const blocks: TranscriptBlock[] = [];
  let bodyCharLength = 0;
  const pushBlock = (block: TranscriptBlock): void => {
    bodyCharLength += block.text.length;
    if (blocks.length > 0) bodyCharLength += 2;
    blocks.push(block);
  };

  for (const rawMessage of context.messages) {
    const message = rawMessage as unknown as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "user") {
      const text = extractMessageText(message.content, true).trim();
      if (!text) continue;
      pushBlock({ kind: "user", text: `[User]\n${text}` });
      continue;
    }

    if (role === "assistant") {
      const assistantText = extractAssistantText(message.content).trim();
      if (assistantText) {
        pushBlock({ kind: "assistant", text: `[Assistant]\n${assistantText}` });
      }
      for (const toolCall of extractToolCalls(message.content)) {
        pushBlock({
          kind: "toolCall",
          text: `[ToolCall ${toolCall.name}]\n${summarizeToolCall(toolCall.name, toolCall.arguments)}`,
        });
      }
      continue;
    }

    if (role === "toolResult") {
      const summary = summarizeToolResult(message);
      if (summary) {
        const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
        pushBlock({ kind: "toolResult", text: `[ToolResult ${toolName}]\n${summary}` });
      }
      continue;
    }

    if (role === "custom") {
      const customType =
        typeof message.customType === "string" ? message.customType.trim() : "custom";
      const customText = extractMessageTextPreview(message.content, true, 4_000).trim();
      if (!customText) continue;
      pushBlock({ kind: "assistant", text: `[Custom ${customType}]\n${customText}` });
      continue;
    }

    if (role === "bashExecution") {
      if (message.excludeFromContext === true) continue;
      const command = typeof message.command === "string" ? message.command.trim() : "";
      if (!command) continue;
      const output =
        typeof message.output === "string" ? summarizeBoundedFreeText(message.output, 220) : "";
      const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
      const parts = [`command: ${command}`];
      if (typeof exitCode === "number") parts.push(`exit: ${exitCode}`);
      if (output) parts.push(`summary: ${output}`);
      pushBlock({ kind: "bashExecution", text: `[UserBash]\n${parts.join("\n")}` });
      continue;
    }

    if (role === "compactionSummary") {
      const summary = typeof message.summary === "string" ? message.summary.trim() : "";
      if (!summary) continue;
      pushBlock({
        kind: "compactionSummary",
        isSummary: true,
        text: `[CompactionSummary]\n${summary}`,
      });
      continue;
    }

    if (role === "branchSummary") {
      const summary = typeof message.summary === "string" ? message.summary.trim() : "";
      if (!summary) continue;
      pushBlock({ kind: "branchSummary", isSummary: true, text: `[BranchSummary]\n${summary}` });
    }
  }

  const charLength = headerText.length + (blocks.length > 0 ? bodyCharLength + 2 : 0);
  const text =
    charLength <= FULL_TRANSCRIPT_MAX_CHARS
      ? [headerText, blocks.map((block) => block.text).join("\n\n")]
          .filter(Boolean)
          .join("\n\n")
          .trim()
      : undefined;

  return {
    sessionFile: meta.sessionFile,
    fingerprint: meta.fingerprint,
    blockCount: blocks.length,
    charLength,
    text,
    blocks,
    headerText,
  };
}

function prepareTranscriptForFacet(transcript: NormalizedTranscript): PreparedTranscript {
  if (transcript.charLength <= FULL_TRANSCRIPT_MAX_CHARS) {
    return {
      text:
        transcript.text ??
        [transcript.headerText, transcript.blocks.map((block) => block.text).join("\n\n")]
          .filter(Boolean)
          .join("\n\n")
          .trim(),
      fullCharLength: transcript.charLength,
      usedReducedTranscript: false,
    };
  }

  const selected = new Set<number>();
  let headChars = 0;
  for (let index = 0; index < transcript.blocks.length; index++) {
    if (headChars >= REDUCED_TRANSCRIPT_HEAD_CHARS) break;
    selected.add(index);
    headChars += transcript.blocks[index]!.text.length + 2;
  }

  let tailChars = 0;
  for (let index = transcript.blocks.length - 1; index >= 0; index--) {
    if (tailChars >= REDUCED_TRANSCRIPT_TAIL_CHARS) break;
    if (selected.has(index)) continue;
    selected.add(index);
    tailChars += transcript.blocks[index]!.text.length + 2;
  }

  for (let index = 0; index < transcript.blocks.length; index++) {
    if (transcript.blocks[index]!.isSummary) {
      selected.add(index);
    }
  }

  const ordered = [...selected].sort((a, b) => a - b);
  const prefix = [
    transcript.headerText,
    `[Transcript reduced due to length. Full size: ${formatCount(transcript.charLength)} chars.]`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const reducedBlocks: string[] = [];
  let previous = -1;
  let bodyLength = 0;
  const maxBodyLength = Math.max(0, REDUCED_TRANSCRIPT_MAX_CHARS - prefix.length - 2);

  for (const index of ordered) {
    if (previous >= 0 && index > previous + 1) {
      const gapText = `[... ${index - previous - 1} blocks omitted ...]`;
      const appendedGap = appendReducedBlock(reducedBlocks, gapText, maxBodyLength, bodyLength);
      bodyLength = appendedGap.bodyLength;
      if (!appendedGap.didAppend) break;
    }

    const appendedBlock = appendReducedBlock(
      reducedBlocks,
      transcript.blocks[index]!.text,
      maxBodyLength,
      bodyLength,
    );
    bodyLength = appendedBlock.bodyLength;
    if (!appendedBlock.didAppend) break;
    previous = index;
  }

  if (previous >= 0 && previous < transcript.blocks.length - 1) {
    const appendedTailGap = appendReducedBlock(
      reducedBlocks,
      `[... ${transcript.blocks.length - previous - 1} blocks omitted ...]`,
      maxBodyLength,
      bodyLength,
    );
    bodyLength = appendedTailGap.bodyLength;
  }

  const reducedText = [prefix, reducedBlocks.join("\n\n")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, REDUCED_TRANSCRIPT_MAX_CHARS)
    .trim();

  return {
    text: reducedText,
    fullCharLength: transcript.charLength,
    usedReducedTranscript: true,
  };
}

function appendReducedBlock(
  blocks: string[],
  block: string,
  maxBodyLength: number,
  currentBodyLength: number,
): { bodyLength: number; didAppend: boolean } {
  if (maxBodyLength <= currentBodyLength) {
    return { bodyLength: currentBodyLength, didAppend: false };
  }

  const separatorLength = blocks.length > 0 ? 2 : 0;
  const remaining = maxBodyLength - currentBodyLength - separatorLength;
  if (remaining <= 0) {
    return { bodyLength: currentBodyLength, didAppend: false };
  }

  const nextBlock = truncateChars(block, remaining);
  if (!nextBlock) {
    return { bodyLength: currentBodyLength, didAppend: false };
  }

  blocks.push(nextBlock);
  return {
    bodyLength: currentBodyLength + separatorLength + nextBlock.length,
    didAppend: true,
  };
}

async function extractFacet(
  meta: SessionMeta,
  transcript: PreparedTranscript,
  selection: ConfiguredModelSelection,
  signal: AbortSignal,
): Promise<SessionFacet> {
  throwIfAborted(signal);

  const userPrompt = [
    "Session metadata:",
    formatMetaForFacetPrompt(meta),
    "",
    transcript.usedReducedTranscript
      ? `Transcript: reduced from ${formatCount(transcript.fullCharLength)} chars to fit the model budget.`
      : "Transcript: full session transcript.",
    "",
    "<session>",
    transcript.text,
    "</session>",
  ].join("\n");

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: Date.now(),
  };

  const response = await complete(
    selection.model,
    {
      systemPrompt: FACET_SYSTEM_PROMPT,
      messages: [userMessage],
    },
    {
      apiKey: selection.apiKey,
      headers: selection.headers,
      signal,
    },
  );

  if (response.stopReason === "aborted") {
    throw new AbortError();
  }

  if (response.stopReason === "error") {
    throw new Error("Session facet extraction failed");
  }

  const rawText = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  if (!rawText) {
    throw new Error("Session facet extraction returned no text");
  }

  return validateFacet(parsePossiblyWrappedJson(rawText), meta.fingerprint);
}

function buildAggregate(
  scope: InsightScope,
  sessionsConsidered: number,
  analyses: SessionAnalysis[],
): InsightsAggregate {
  const projects: Record<string, number> = {};
  const goalCategories: Record<string, number> = {};
  const frictionCategories: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const languages: Record<string, number> = {};

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let dateRangeStart: string | undefined;
  let dateRangeEnd: string | undefined;

  const repeatedInstructions = new Map<string, { text: string; sessions: Set<string> }>();
  const repeatedWorkflows = new Map<string, { text: string; sessions: Set<string> }>();
  const representativeSessions: InsightsAggregate["representativeSessions"] = [];

  for (const analysis of analyses) {
    const meta = analysis.meta;
    incrementRecord(projects, meta.cwd ?? "(unknown)");
    totalInputTokens += meta.totalInputTokens;
    totalOutputTokens += meta.totalOutputTokens;
    totalCost += meta.totalCost ?? 0;

    mergeNumberRecord(toolCounts, meta.toolCounts);
    mergeNumberRecord(languages, meta.languages);

    if (meta.startedAt && (!dateRangeStart || meta.startedAt < dateRangeStart)) {
      dateRangeStart = meta.startedAt;
    }
    if (meta.endedAt && (!dateRangeEnd || meta.endedAt > dateRangeEnd)) {
      dateRangeEnd = meta.endedAt;
    }

    if (!analysis.facet) continue;

    for (const category of analysis.facet.goalCategories) {
      incrementRecord(goalCategories, category);
    }
    for (const category of analysis.facet.frictionCategories) {
      incrementRecord(frictionCategories, category);
    }

    const sessionRef = sessionRefForMeta(meta);
    addRepeatedEvidence(
      repeatedInstructions,
      analysis.facet.explicitInstructionsToRemember,
      sessionRef,
    );
    addRepeatedEvidence(repeatedWorkflows, analysis.facet.repeatedWorkflowHints, sessionRef);

    representativeSessions.push({
      sessionFile: meta.sessionFile,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      summary: analysis.facet.briefSummary,
      goal: analysis.facet.underlyingGoal,
      outcome: analysis.facet.outcome,
    });
  }

  representativeSessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  return {
    scope,
    sessionsConsidered,
    sessionsAnalyzed: analyses.length,
    sessionsWithFacets: analyses.filter((analysis) => Boolean(analysis.facet)).length,
    sessionsSkipped: Math.max(0, sessionsConsidered - analyses.length),
    dateRange: {
      start: dateRangeStart,
      end: dateRangeEnd,
    },
    projects,
    goalCategories,
    frictionCategories,
    toolCounts,
    languages,
    totalInputTokens,
    totalOutputTokens,
    totalCost: totalCost > 0 ? roundNumber(totalCost, 6) : undefined,
    repeatedInstructions: finalizeRepeatedEvidence(repeatedInstructions),
    repeatedWorkflows: finalizeRepeatedEvidence(repeatedWorkflows),
    representativeSessions: representativeSessions.slice(0, 12),
  };
}

async function synthesizeReport(
  aggregate: InsightsAggregate,
  selection: ConfiguredModelSelection,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  const payload = {
    schemaVersion: SYNTHESIS_PROMPT_VERSION,
    scope: aggregate.scope,
    sessionsConsidered: aggregate.sessionsConsidered,
    sessionsAnalyzed: aggregate.sessionsAnalyzed,
    sessionsWithFacets: aggregate.sessionsWithFacets,
    sessionsSkipped: aggregate.sessionsSkipped,
    dateRange: aggregate.dateRange,
    topProjects: topEntries(aggregate.projects, 8),
    topGoalCategories: topEntries(aggregate.goalCategories, 10),
    topFrictionCategories: topEntries(aggregate.frictionCategories, 10),
    topTools: topEntries(aggregate.toolCounts, 12),
    topLanguages: topEntries(aggregate.languages, 10),
    totals: {
      inputTokens: aggregate.totalInputTokens,
      outputTokens: aggregate.totalOutputTokens,
      cost: aggregate.totalCost,
    },
    repeatedInstructions: aggregate.repeatedInstructions.slice(0, 10),
    repeatedWorkflows: aggregate.repeatedWorkflows.slice(0, 10),
    representativeSessions: aggregate.representativeSessions.slice(0, 12),
    bucketRubric: {
      agentsMd: "explicit, repeated, stable, instruction-like guidance",
      promptTemplate: "mostly prompt framing, lightweight, user-triggered, not stateful",
      skill: "multi-step, procedural, reusable, mostly LLM-driven",
      extension: "stateful, event-driven, custom tooling/UI, persistent behavior",
    },
  };

  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Analyze this aggregate Pi session data and write the report.\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    selection.model,
    {
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      messages: [userMessage],
    },
    {
      apiKey: selection.apiKey,
      headers: selection.headers,
      signal,
    },
  );

  if (response.stopReason === "aborted") {
    throw new AbortError();
  }

  if (response.stopReason === "error") {
    throw new Error("Final report synthesis failed");
  }

  const markdown = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  if (!markdown) {
    throw new Error("Final report synthesis returned no text");
  }

  return markdown;
}

function buildDeterministicReport(aggregate: InsightsAggregate): string {
  const lines: string[] = [];
  lines.push("# Insights");
  lines.push("");
  lines.push("## At a glance");
  lines.push(`- Scope: ${aggregate.scope}`);
  lines.push(`- Sessions considered: ${formatCount(aggregate.sessionsConsidered)}`);

  if (aggregate.sessionsAnalyzed === 0) {
    lines.push("- No sessions met the minimum threshold for analysis.");
    lines.push("");
    lines.push("## Quick wins");
    if (aggregate.scope === "current") {
      lines.push("- `scope=current` only analyzes the active session.");
      lines.push(
        "- If you started a fresh Pi session just to test `/insights`, this result is expected.",
      );
      lines.push(
        "- To test `current`, first `/resume` a substantial session or exchange a few real prompts, then run `/insights scope=current`.",
      );
    } else {
      lines.push("- Try /insights again after a few longer sessions in this scope.");
      lines.push(
        "- The current filter skips sessions with fewer than 2 meaningful user messages or under 1 minute of activity.",
      );
    }
    return lines.join("\n");
  }

  lines.push(`- Sessions analyzed: ${formatCount(aggregate.sessionsAnalyzed)}`);
  lines.push(`- Sessions classified: ${formatCount(aggregate.sessionsWithFacets)}`);
  if (aggregate.dateRange.start || aggregate.dateRange.end) {
    lines.push(
      `- Date range: ${formatDateRange(aggregate.dateRange.start, aggregate.dateRange.end)}`,
    );
  }
  lines.push(`- Input tokens: ${formatCount(aggregate.totalInputTokens)}`);
  lines.push(`- Output tokens: ${formatCount(aggregate.totalOutputTokens)}`);
  if (aggregate.totalCost) {
    lines.push(`- Estimated cost: ${formatUsd(aggregate.totalCost)}`);
  }
  lines.push("");

  lines.push("## What you use Pi for");
  lines.push(
    ...formatTopRecordAsBullets(
      aggregate.goalCategories,
      5,
      "No strong recurring goal categories yet.",
    ),
  );
  lines.push("");

  lines.push("## How you tend to work with Pi");
  lines.push(...formatTopRecordAsBullets(aggregate.toolCounts, 6, "No strong tool pattern yet."));
  lines.push(
    ...formatTopRecordAsBullets(aggregate.languages, 6, "No strong language pattern yet."),
  );
  lines.push("");

  lines.push("## Repeated instructions worth moving into AGENTS.md");
  lines.push(
    ...formatRepeatedEvidence(
      aggregate.repeatedInstructions,
      "No repeated instruction-style guidance stood out yet.",
    ),
  );
  lines.push("");

  lines.push("## Good prompt template candidates");
  lines.push(
    ...formatRepeatedEvidence(
      aggregate.repeatedWorkflows,
      "No repeated prompt-shaped workflow stood out yet.",
    ),
  );
  lines.push("");

  lines.push("## Good skill candidates");
  if (aggregate.repeatedWorkflows.length > 0) {
    for (const workflow of aggregate.repeatedWorkflows.slice(0, 5)) {
      lines.push(
        `- ${workflow.text} — repeated in ${workflow.count} sessions. This looks procedural enough for a reusable skill.`,
      );
    }
  } else {
    lines.push("- No strong multi-step workflow pattern yet.");
  }
  lines.push("");

  lines.push("## Good extension candidates");
  if (aggregate.repeatedInstructions.length > 0) {
    lines.push(
      "- Look for repeated instructions that feel like enforcement or runtime behavior. Those are stronger extension candidates than prompt-only guidance.",
    );
  } else {
    lines.push("- No obviously stateful or enforcement-heavy pattern stood out yet.");
  }
  lines.push("");

  lines.push("## Where things go wrong");
  lines.push(
    ...formatTopRecordAsBullets(
      aggregate.frictionCategories,
      5,
      "No strong recurring friction category yet.",
    ),
  );
  lines.push("");

  lines.push("## Quick wins");
  lines.push("- Move stable, repeated instructions into AGENTS.md.");
  lines.push("- Turn repeated procedural workflows into a skill before building an extension.");
  lines.push("- Reserve extension work for patterns that need state, tooling, or enforcement.");

  return lines.join("\n");
}

function prependReportNotice(markdown: string, notice: string): string {
  return markdown.replace("# Insights\n", `# Insights\n\n> ${notice}\n`);
}

function renderProgressMessage(progress: ProgressState, elapsedSeconds: string): string {
  const cacheSuffix = ` · meta cache ${formatCount(progress.metaCacheHits)} · facet cache ${formatCount(progress.facetCacheHits)}`;

  if (progress.stage === "resolve") {
    return `Analyzing sessions · resolving (${formatCount(progress.current)}/${formatCount(progress.total)}) · ${elapsedSeconds}s`;
  }

  if (progress.stage === "metadata") {
    return `Analyzing sessions · metadata (${formatCount(progress.current)}/${formatCount(progress.total)})${cacheSuffix} · ${elapsedSeconds}s`;
  }

  if (progress.stage === "facets") {
    return `Analyzing sessions · facets (${formatCount(progress.current)}/${formatCount(progress.total)})${cacheSuffix} · ${elapsedSeconds}s`;
  }

  if (progress.stage === "aggregate") {
    return `Analyzing sessions · aggregating${cacheSuffix} · ${elapsedSeconds}s`;
  }

  return `Analyzing sessions · synthesizing report${cacheSuffix} · ${elapsedSeconds}s`;
}

function setBorderedLoaderMessage(loader: BorderedLoader, message: string): void {
  const inner = (loader as unknown as { loader?: { setMessage?: (message: string) => void } })
    .loader;
  if (inner?.setMessage) {
    inner.setMessage(message);
  }
}

async function getCacheInfo(sessionFile: string | undefined): Promise<SessionCacheInfo> {
  if (!sessionFile) return {};

  const cacheKey = hashText(sessionFile);
  try {
    const stats = await fs.stat(sessionFile);
    const fingerprint = hashText(
      JSON.stringify({
        sessionFile,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        schemaVersion: SESSION_FINGERPRINT_VERSION,
      }),
    );
    return { cacheKey, fingerprint };
  } catch {
    return { cacheKey };
  }
}

async function readMetaCache(cacheKey: string, fingerprint: string): Promise<SessionMeta | null> {
  const raw = await readJsonFile(path.join(META_CACHE_DIR, `${cacheKey}.json`));
  if (!raw || !isRecord(raw)) return null;
  if (raw.schemaVersion !== INSIGHTS_META_SCHEMA_VERSION) return null;
  if (raw.fingerprint !== fingerprint) return null;
  if (typeof raw.sessionFile !== "string") return null;
  return raw as unknown as SessionMeta;
}

async function writeMetaCache(
  cacheKey: string,
  meta: SessionMeta,
  signal: AbortSignal,
): Promise<void> {
  await writeJsonAtomic(path.join(META_CACHE_DIR, `${cacheKey}.json`), meta, signal);
}

async function readFacetCache(
  cacheKey: string | undefined,
  fingerprint: string,
): Promise<SessionFacet | null> {
  if (!cacheKey) return null;
  const raw = await readJsonFile(path.join(FACET_CACHE_DIR, `${cacheKey}.json`));
  if (!raw || !isRecord(raw)) return null;
  if (raw.schemaVersion !== INSIGHTS_FACET_SCHEMA_VERSION) return null;
  if (raw.promptVersion !== FACET_PROMPT_VERSION) return null;
  if (raw.fingerprint !== fingerprint) return null;
  return raw as unknown as SessionFacet;
}

async function writeFacetCache(
  cacheKey: string,
  facet: SessionFacet,
  signal: AbortSignal,
): Promise<void> {
  await writeJsonAtomic(path.join(FACET_CACHE_DIR, `${cacheKey}.json`), facet, signal);
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, payload, "utf8");
    throwIfAborted(signal);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    void fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateFacet(parsed: unknown, fingerprint: string): SessionFacet {
  if (!isRecord(parsed)) {
    throw new Error("Facet output must be a JSON object");
  }

  const underlyingGoal = cleanSentence(parsed.underlyingGoal, "Unclear goal");
  const goalCategories = sanitizeEnumArray(parsed.goalCategories, GOAL_CATEGORIES);
  const frictionCategories = sanitizeEnumArray(parsed.frictionCategories, FRICTION_CATEGORIES);
  const outcome = sanitizeOutcome(parsed.outcome);
  const frictionDetail = optionalCleanSentence(parsed.frictionDetail);
  const briefSummary = cleanSentence(parsed.briefSummary, underlyingGoal);
  const explicitInstructionsToRemember = sanitizeStringArray(
    parsed.explicitInstructionsToRemember,
    8,
    220,
  );
  const repeatedWorkflowHints = sanitizeStringArray(parsed.repeatedWorkflowHints, 8, 220);

  return {
    schemaVersion: INSIGHTS_FACET_SCHEMA_VERSION,
    promptVersion: FACET_PROMPT_VERSION,
    fingerprint,
    underlyingGoal,
    goalCategories,
    outcome,
    frictionCategories,
    frictionDetail,
    briefSummary,
    explicitInstructionsToRemember,
    repeatedWorkflowHints,
  };
}

function parsePossiblyWrappedJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty output");

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced || trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Output is not valid JSON");
  }
}

function formatMetaForFacetPrompt(meta: SessionMeta): string {
  const fields = [
    `session_file: ${meta.sessionFile}`,
    `cwd: ${meta.cwd ?? "(unknown)"}`,
    `started_at: ${meta.startedAt ?? "(unknown)"}`,
    `duration_minutes: ${meta.durationMinutes}`,
    `meaningful_user_messages: ${meta.meaningfulUserMessages}`,
    `assistant_messages: ${meta.assistantMessages}`,
    `tool_result_messages: ${meta.toolResultMessages}`,
    `tool_counts: ${JSON.stringify(topEntries(meta.toolCounts, 10))}`,
    `tools_with_errors: ${JSON.stringify(topEntries(meta.toolsWithErrors, 10))}`,
    `modified_files: ${JSON.stringify(meta.modifiedFiles.slice(0, 20))}`,
    `languages: ${JSON.stringify(topEntries(meta.languages, 10))}`,
  ];
  if (meta.firstUserPrompt) {
    fields.push(`first_user_prompt: ${meta.firstUserPrompt}`);
  }
  return fields.join("\n");
}

function isMeaningfulUserMessage(message: Record<string, unknown>): boolean {
  const text = extractMessageText(message.content, true).trim();
  if (text) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((item) => isRecord(item) && item.type === "image");
}

function extractMessageText(content: unknown, includeImagePlaceholders: boolean): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (includeImagePlaceholders && item.type === "image") return "[image attachment]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return "";
      return item.text;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractToolCalls(
  content: unknown,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "toolCall") continue;
    if (typeof item.name !== "string") continue;
    calls.push({
      name: item.name,
      arguments: isRecord(item.arguments) ? item.arguments : {},
    });
  }
  return calls;
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const targetPath = typeof args.path === "string" ? args.path.trim() : "";

  if (command) lines.push(`command: ${command}`);
  if (targetPath) lines.push(`path: ${targetPath}`);

  if (name === "write") {
    const contentLength = typeof args.content === "string" ? args.content.length : undefined;
    if (typeof contentLength === "number") lines.push(`content_chars: ${contentLength}`);
  }

  if (name === "edit") {
    const editBlocks = Array.isArray(args.edits)
      ? args.edits.filter((edit): edit is Record<string, unknown> => isRecord(edit))
      : [];
    const oldTextLength = editBlocks.reduce(
      (sum, edit) => sum + (typeof edit.oldText === "string" ? edit.oldText.length : 0),
      typeof args.oldText === "string" ? args.oldText.length : 0,
    );
    const newTextLength = editBlocks.reduce(
      (sum, edit) => sum + (typeof edit.newText === "string" ? edit.newText.length : 0),
      typeof args.newText === "string" ? args.newText.length : 0,
    );
    if (editBlocks.length > 0) lines.push(`edit_blocks: ${editBlocks.length}`);
    if (oldTextLength > 0) lines.push(`old_text_chars: ${oldTextLength}`);
    if (newTextLength > 0) lines.push(`new_text_chars: ${newTextLength}`);
  }

  if (!command && !targetPath) {
    const previewEntries = Object.entries(args)
      .filter(
        ([, value]) =>
          typeof value === "string" || typeof value === "number" || typeof value === "boolean",
      )
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${String(value)}`);
    lines.push(...previewEntries);
  }

  return lines.length > 0 ? lines.join("\n") : "(no salient arguments)";
}

function summarizeToolResult(message: Record<string, unknown>): string {
  const contentText = extractMessageTextPreview(message.content, false, 260);
  const lines: string[] = [];
  if (message.isError === true) {
    lines.push("error: true");
  } else {
    lines.push("error: false");
  }
  if (contentText) {
    lines.push(`summary: ${contentText}`);
  }
  return lines.join("\n");
}

function extractMessageTextPreview(
  content: unknown,
  includeImagePlaceholders: boolean,
  maxChars: number,
): string {
  if (typeof content === "string") {
    return summarizeBoundedFreeText(content, maxChars);
  }
  if (!Array.isArray(content)) return "";

  let buffer = "";
  const budget = Math.max(maxChars * 4, maxChars + 32);
  for (const item of content) {
    let nextChunk = "";
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      nextChunk = item.text;
    } else if (includeImagePlaceholders && isRecord(item) && item.type === "image") {
      nextChunk = "[image attachment]";
    }

    if (!nextChunk) continue;
    buffer += `${buffer ? "\n" : ""}${nextChunk}`;
    if (buffer.length >= budget) break;
  }

  return summarizeBoundedFreeText(buffer, maxChars);
}

function summarizeFreeText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

function summarizeBoundedFreeText(text: string, maxChars: number): string {
  return summarizeFreeText(text.slice(0, Math.max(maxChars * 4, maxChars + 32)), maxChars);
}

function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function collectModifiedFilesFromEntry(entry: SessionEntry, modifiedFiles: Set<string>): void {
  if ((entry.type === "compaction" || entry.type === "branch_summary") && isRecord(entry.details)) {
    const details = entry.details;
    const files = Array.isArray(details.modifiedFiles) ? details.modifiedFiles : [];
    for (const file of files) {
      if (typeof file === "string" && file.trim()) {
        modifiedFiles.add(file.trim());
      }
    }
  }
}

function collectModifiedFilesFromToolCall(
  name: string,
  args: Record<string, unknown>,
  modifiedFiles: Set<string>,
): void {
  if ((name === "write" || name === "edit") && typeof args.path === "string" && args.path.trim()) {
    modifiedFiles.add(args.path.trim());
  }
}

function buildLanguageSummary(modifiedFiles: Iterable<string>): Record<string, number> {
  const languages: Record<string, number> = {};
  for (const file of modifiedFiles) {
    incrementRecord(languages, languageFromPath(file));
  }
  return languages;
}

function languageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".vue") return "Vue";
  if (ext === ".svelte") return "Svelte";
  if (ext === ".astro") return "Astro";

  const language = getLanguageFromPath(filePath);
  if (!language) return "other";

  switch (language) {
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    case "go":
      return "Go";
    case "java":
      return "Java";
    case "kotlin":
      return "Kotlin";
    case "swift":
      return "Swift";
    case "ruby":
      return "Ruby";
    case "php":
      return "PHP";
    case "csharp":
      return "C#";
    case "markdown":
      return "Markdown";
    case "json":
      return "JSON";
    case "yaml":
      return "YAML";
    case "toml":
      return "TOML";
    case "bash":
      return "Shell";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "CSS";
    case "html":
      return "HTML";
    case "sql":
      return "SQL";
    case "graphql":
      return "GraphQL";
    case "dockerfile":
      return "Dockerfile";
    case "makefile":
      return "Makefile";
    case "cpp":
      return "C++";
    case "c":
      return "C";
    case "powershell":
      return "PowerShell";
    case "fish":
      return "Fish";
    default:
      return language.charAt(0).toUpperCase() + language.slice(1);
  }
}

function countBranchPoints(entries: SessionEntry[]): number {
  const childCounts = new Map<string | null, number>();
  for (const entry of entries) {
    childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
  }

  let branchPoints = 0;
  for (const count of childCounts.values()) {
    if (count > 1) branchPoints += count - 1;
  }
  return branchPoints;
}

function firstTimestamp(entries: SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.timestamp) return entry.timestamp;
  }
  return undefined;
}

function lastTimestamp(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const timestamp = entries[index]?.timestamp;
    if (timestamp) return timestamp;
  }
  return undefined;
}

function computeDurationMinutes(startedAt?: string, endedAt?: string): number {
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  const end = endedAt ? new Date(endedAt).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.max(0, Math.floor((end - start) / 60_000));
}

function fallbackFingerprint(
  entryCount: number,
  sessionId: string,
  leafId: string | null,
  branchLastTimestamp: string | undefined,
  sessionPath: string | undefined,
): string {
  return hashText(
    JSON.stringify({
      path: sessionPath,
      sessionId,
      leafId,
      entryCount,
      lastTimestamp: branchLastTimestamp,
    }),
  );
}

function sessionRefForMeta(meta: SessionMeta): string {
  const base = path.basename(meta.sessionFile);
  const suffix = meta.fingerprint.slice(0, 6);
  return `${base}:${suffix}`;
}

function addRepeatedEvidence(
  store: Map<string, { text: string; sessions: Set<string> }>,
  values: string[],
  sessionRef: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = cleanOneLine(value, 220);
    if (!cleaned) continue;
    const key = normalizeEvidenceKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const existing = store.get(key);
    if (existing) {
      existing.sessions.add(sessionRef);
      if (cleaned.length < existing.text.length) {
        existing.text = cleaned;
      }
    } else {
      store.set(key, { text: cleaned, sessions: new Set([sessionRef]) });
    }
  }
}

function finalizeRepeatedEvidence(
  store: Map<string, { text: string; sessions: Set<string> }>,
): RepeatedEvidence[] {
  return [...store.values()]
    .map((value) => ({
      text: value.text,
      count: value.sessions.size,
    }))
    .filter((value) => value.count >= 2)
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function normalizeEvidenceKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"“”]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;!?]+$/g, "")
    .trim();
}

function topEntries(
  record: Record<string, number>,
  limit: number,
): Array<{ key: string; value: number }> {
  return Object.entries(record)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function formatTopRecordAsBullets(
  record: Record<string, number>,
  limit: number,
  emptyMessage: string,
): string[] {
  const entries = topEntries(record, limit);
  if (entries.length === 0) return [`- ${emptyMessage}`];
  return entries.map((entry) => `- ${entry.key}: ${formatCount(entry.value)}`);
}

function formatRepeatedEvidence(values: RepeatedEvidence[], emptyMessage: string): string[] {
  if (values.length === 0) return [`- ${emptyMessage}`];
  return values.slice(0, 6).map((value) => `- ${value.text} — repeated in ${value.count} sessions`);
}

function mergeNumberRecord(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function incrementRecord(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function sanitizeEnumArray<T extends readonly string[]>(value: unknown, allowed: T): T[number][] {
  if (!Array.isArray(value)) return [];
  const allowedSet = new Set(allowed);
  const cleaned: T[number][] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!allowedSet.has(item as T[number])) continue;
    if (!cleaned.includes(item as T[number])) cleaned.push(item as T[number]);
  }
  return cleaned;
}

function sanitizeOutcome(value: unknown): SessionFacet["outcome"] {
  return value === "achieved" || value === "partial" || value === "blocked" || value === "unclear"
    ? value
    : "unclear";
}

function sanitizeStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = cleanSentence(item, "").slice(0, maxChars).trim();
    if (!normalized) continue;
    if (!cleaned.includes(normalized)) cleaned.push(normalized);
    if (cleaned.length >= maxItems) break;
  }
  return cleaned;
}

function cleanSentence(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function optionalCleanSentence(value: unknown): string | undefined {
  const cleaned = cleanSentence(value, "");
  return cleaned || undefined;
}

function cleanOneLine(value: string, maxChars: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 3)}...` : cleaned;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function normalizeSessionFile(sessionFile: string | undefined): string {
  return sessionFile ?? "(current session)";
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

function formatIsoShort(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatDateRange(start?: string, end?: string): string {
  if (start && end) return `${formatIsoShort(start)} → ${formatIsoShort(end)}`;
  return start ?? end ?? "(unknown)";
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function roundNumber(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AbortError();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
