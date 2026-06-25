import {
  keyText,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKeyRelease,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

import {
  buildAdditionalContextSection,
  buildProjectReviewGuidelinesSection,
  REVIEW_DEDUP_PROMPT,
  REVIEW_FOCUSES,
  REVIEW_FOCUS_PROMPT,
  REVIEW_OUTPUT_CONTRACT_PROMPT,
} from "./prompts.js";
import {
  buildReviewedScopeLine,
  buildReviewFailuresMarkdown,
  buildReviewFindingsMarkdown,
  formatDuration,
} from "./renderers/inline.js";
import { buildRequestSignature } from "./request.js";
import {
  appendErrorDetails,
  asRecord,
  buildProviderErrorMessage,
  classifyTaskError,
  getSubmittedPayload,
  parseJsonFromText,
  REVIEW_INSPECTION_TOOLS,
  REVIEW_STARTUP_RETRY_DELAYS_MS,
  REVIEW_TASK_TIMEOUT_MS,
  runPiOneShotTask,
  runPiSubmitToolTask,
  type TaskErrorKind,
  withJitter,
} from "./runner.js";
import {
  computeCurrentFingerprint,
  fingerprintsEqual,
  buildScopeInstructions,
  isGitRepo,
  loadProjectReviewGuidelines,
  resolveScope,
  type ResolvedScope,
} from "./git.js";
import {
  appendModelThinkingSuffix,
  buildResolvedReviewModelLabel,
  buildResolvedReviewStatusModelLabel,
  buildReviewProgressModelLabel,
  clearProviderCandidateProbe,
  getFallbackThinkingLevels,
  getProviderCandidateAvailability,
  getProviderCandidateProbe,
  getResolvedReviewCurrentThinkingLevel,
  getResolvedReviewPrimaryProviderCandidate,
  selectReviewDedupModel,
  setProviderCandidateAvailability,
  setProviderCandidateProbe,
  resolveModels,
  type ResolvedReviewModel,
  type ResolvedReviewProviderCandidate,
  type ReviewThinkingLevel,
} from "./models.js";
import {
  notify,
  REVIEW_CANCELLED_ERROR,
  REVIEW_STATUS_KEY,
  STATUS_SPINNER_FRAMES,
  STATUS_SPINNER_INTERVAL_MS,
  withManagedReviewRun,
  withSpinner,
  type ReviewExecutionControl,
} from "./runtime.js";
import {
  REVIEW_FOCUS_NAMES,
  type FocusFinding,
  type ReviewFocus,
  type FocusOutput,
  type ParsedRequest,
  type Priority,
  type ReviewDedupGroup,
  type ReviewFingerprint,
  type ReviewMessageDetails,
  type ReviewMessageKind,
  type ReviewReportFinding,
  type ReviewRequestMode,
  type ReviewRunResult,
  type ReviewRunSource,
  type ReviewStaleness,
} from "./schema.js";
import { SUBMIT_REVIEW_EXTENSION_PATH } from "./submit-review-tool.js";

const SUBMIT_REVIEW_TOOL = "submit_review";
const REVIEW_TOOLS = `${REVIEW_INSPECTION_TOOLS},${SUBMIT_REVIEW_TOOL}`;

const REVIEW_STALE_REVIEW_WARNING = "Repository changed while this review was running.";
const REVIEW_STALE_REVIEW_NEXT_STEP =
  "Results are shown anyway. Run /review again to refresh them.";
const REVIEW_STALE_FIX_WARNING = "Repository changed while /fix was gathering findings.";
const REVIEW_STALE_FIX_NEXT_STEP =
  "No fixes were applied. Run /fix again to continue, or /review first to refresh.";
const REVIEW_STALE_PAYLOAD_WARNING = "Repository changed since this review was generated.";
const REVIEW_STALE_PAYLOAD_NEXT_STEP = "Run /review first to refresh it.";

const REVIEW_PROGRESS_WIDGET_KEY = "review-progress";

type ReviewTheme = ExtensionContext["ui"]["theme"];

type FocusTask = {
  model: ResolvedReviewModel;
  focus: ReviewFocus;
  prompt: string;
};

type FocusTaskAttempt = FocusTask & {
  providerCandidate: ResolvedReviewProviderCandidate;
  currentThinkingLevel?: ReviewThinkingLevel;
};

type FocusTaskErrorKind = TaskErrorKind;

type FocusTaskResult = {
  focus: ReviewFocus;
  model: string;
  ok: boolean;
  output?: FocusOutput;
  error?: string;
  errorKind?: FocusTaskErrorKind;
  missingApiProvider?: string;
};

type ReviewProgressStatus = "running" | "success" | "failure";

type ReviewProgressTask = {
  focus: ReviewFocus;
  model: string;
  status: ReviewProgressStatus;
};

type ReviewProgressState = {
  startedAtMs: number;
  expanded: boolean;
  frame: number;
  tasks: ReviewProgressTask[];
};

type ReviewProgressController = {
  update: (task: FocusTask, result: FocusTaskResult) => void;
  stop: () => void;
};

type PreparedReviewRun = {
  scope: ResolvedScope;
  includeUntracked: boolean;
  baselineFingerprint: ReviewFingerprint;
  models: ResolvedReviewModel[];
  tasks: FocusTask[];
};

function createReviewProgress(ctx: ExtensionContext, tasks: FocusTask[]): ReviewProgressController {
  if (!ctx.hasUI) {
    return {
      update: () => {},
      stop: () => {},
    };
  }

  const state: ReviewProgressState = {
    startedAtMs: Date.now(),
    expanded: false,
    frame: 0,
    tasks: tasks.map((task) => ({
      focus: task.focus,
      model: buildReviewProgressModelLabel(task.model),
      status: "running",
    })),
  };
  const progressTasks = new Map(tasks.map((task, index) => [task, state.tasks[index]!]));

  const render = () => {
    if (state.expanded) {
      ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
      ctx.ui.setWidget(
        REVIEW_PROGRESS_WIDGET_KEY,
        (_tui, theme) => new ReviewProgressComponent(state, theme),
        { placement: "belowEditor" },
      );
      return;
    }

    ctx.ui.setWidget(REVIEW_PROGRESS_WIDGET_KEY, undefined, { placement: "belowEditor" });
    ctx.ui.setStatus(REVIEW_STATUS_KEY, buildCollapsedReviewProgressStatus(state));
  };
  const unsubscribeToggle = ctx.ui.onTerminalInput((data) => {
    if (isKeyRelease(data)) return undefined;
    if (!getKeybindings().matches(data, "app.tools.expand")) return undefined;
    state.expanded = !state.expanded;
    render();
    return { consume: true };
  });
  const timer = setInterval(() => {
    state.frame = (state.frame + 1) % STATUS_SPINNER_FRAMES.length;
    render();
  }, STATUS_SPINNER_INTERVAL_MS);

  render();
  return {
    update: (task, result) => {
      const progressTask = progressTasks.get(task);
      if (!progressTask) return;
      progressTask.status = result.ok ? "success" : "failure";
      render();
    },
    stop: () => {
      clearInterval(timer);
      unsubscribeToggle();
      ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
      ctx.ui.setWidget(REVIEW_PROGRESS_WIDGET_KEY, undefined, { placement: "belowEditor" });
    },
  };
}

class ReviewProgressComponent implements Component {
  constructor(
    private state: ReviewProgressState,
    private theme: ReviewTheme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return buildExpandedReviewProgressLines(this.state, this.theme, width);
  }
}

function buildCollapsedReviewProgressStatus(state: ReviewProgressState): string {
  const counts = countReviewProgressTasks(state.tasks);
  const spinner = getProgressSpinner(state);
  const failedText = counts.failed > 0 ? `, ${counts.failed} failed` : "";
  return `${spinner} reviewing ${counts.finished}/${counts.total}${failedText} (${keyText("app.tools.expand")} to expand)`;
}

function buildExpandedReviewProgressLines(
  state: ReviewProgressState,
  theme: ReviewTheme,
  width: number,
): string[] {
  const counts = countReviewProgressTasks(state.tasks);
  const spinner = getProgressSpinner(state);
  const hint = `${theme.fg("muted", `(${formatDuration(Date.now() - state.startedAtMs)}, `)}${theme.fg(
    "dim",
    keyText("app.tools.expand"),
  )}${theme.fg("muted", " to collapse)")}`;
  const header = truncateToWidth(
    `${theme.fg("accent", spinner)} reviewing ${counts.finished}/${counts.total} ${hint}`,
    width,
    theme.fg("muted", "…"),
  );
  const groupedTasks = groupReviewProgressTasks(state.tasks);
  const fullRows = buildReviewProgressRows(groupedTasks, theme, width, "full", spinner);
  const rows = fullRows.fits
    ? fullRows.lines
    : buildReviewProgressRows(groupedTasks, theme, width, "short", spinner).lines;
  return [header, ...rows, theme.fg("borderMuted", "─".repeat(Math.max(0, width)))];
}

function buildReviewProgressRows(
  groupedTasks: Map<string, ReviewProgressTask[]>,
  theme: ReviewTheme,
  width: number,
  labelStyle: "full" | "short",
  spinner: string,
): { fits: boolean; lines: string[] } {
  const focuses = getReviewProgressFocuses(groupedTasks);
  const rowData = Array.from(groupedTasks, ([model, tasks]) => ({
    model,
    chips: focuses
      .map((focus) => {
        const task = tasks.find((candidate) => candidate.focus === focus);
        return formatReviewProgressChip(
          task?.status ?? "running",
          focus,
          labelStyle,
          spinner,
          theme,
        );
      })
      .join("  "),
  }));
  const maxModelWidth = Math.max(0, ...rowData.map((row) => visibleWidth(row.model)));
  const maxChipWidth = Math.max(0, ...rowData.map((row) => visibleWidth(row.chips)));
  const fullModelColumnWidth = Math.max(maxModelWidth, 1);
  const fullRowsFit = rowData.every(
    (row) => fullModelColumnWidth + 1 + visibleWidth(row.chips) <= width,
  );
  const availableModelWidth = width - 1 - maxChipWidth;
  const minimumUsefulModelWidth = Math.min(16, fullModelColumnWidth);
  const canFit = fullRowsFit || availableModelWidth >= minimumUsefulModelWidth;
  const modelColumnWidth = fullRowsFit ? fullModelColumnWidth : Math.max(8, availableModelWidth);
  const lines = rowData.map((row) => {
    const model = padToWidth(truncateToWidth(row.model, modelColumnWidth, "…"), modelColumnWidth);
    return truncateToWidth(`${model} ${row.chips}`, width, "…");
  });

  return { fits: canFit, lines };
}

function getReviewProgressFocuses(groupedTasks: Map<string, ReviewProgressTask[]>): ReviewFocus[] {
  const selected = new Set<ReviewFocus>();
  for (const tasks of groupedTasks.values()) {
    for (const task of tasks) {
      selected.add(task.focus);
    }
  }
  return REVIEW_FOCUS_NAMES.filter((focus) => selected.has(focus));
}

function formatReviewProgressChip(
  status: ReviewProgressStatus,
  focus: ReviewFocus,
  labelStyle: "full" | "short",
  spinner: string,
  theme: ReviewTheme,
): string {
  const label = labelStyle === "full" ? focus : getShortReviewFocusLabel(focus);
  switch (status) {
    case "success":
      return `${theme.fg("success", "✓")} ${label}`;
    case "failure":
      return `${theme.fg("error", "✕")} ${label}`;
    case "running":
      return `${spinner} ${label}`;
  }
}

function countReviewProgressTasks(tasks: ReviewProgressTask[]): {
  total: number;
  finished: number;
  running: number;
  failed: number;
} {
  const failed = tasks.filter((task) => task.status === "failure").length;
  const succeeded = tasks.filter((task) => task.status === "success").length;
  const finished = failed + succeeded;
  return {
    total: tasks.length,
    finished,
    running: tasks.length - finished,
    failed,
  };
}

function groupReviewProgressTasks(tasks: ReviewProgressTask[]): Map<string, ReviewProgressTask[]> {
  const grouped = new Map<string, ReviewProgressTask[]>();
  for (const task of tasks) {
    const group = grouped.get(task.model) ?? [];
    group.push(task);
    grouped.set(task.model, group);
  }
  return grouped;
}

function getProgressSpinner(state: ReviewProgressState): string {
  return STATUS_SPINNER_FRAMES[state.frame % STATUS_SPINNER_FRAMES.length];
}

function getShortReviewFocusLabel(focus: ReviewFocus): string {
  switch (focus) {
    case "general":
      return "gen";
    case "security":
      return "sec";
    case "reuse":
      return "reuse";
    case "quality":
      return "qual";
    case "testing":
      return "test";
    case "efficiency":
      return "eff";
  }
}

function padToWidth(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function priorityRank(priority: Priority): number {
  return priority.charCodeAt(1) - 48; // '0' = 48
}

function buildFocusPrompt(
  focus: ReviewFocus,
  scopeInstructions: string,
  projectGuidelines: string | null,
  additionalContext: string | undefined,
): string {
  const additionalContextSection = buildAdditionalContextSection(additionalContext);
  const projectGuidelinesSection = buildProjectReviewGuidelinesSection(projectGuidelines);

  const def = REVIEW_FOCUSES[focus];

  return REVIEW_FOCUS_PROMPT.replace("{FOCUS_SUFFIX}", () => def.suffix)
    .replace("{FOCUS_QUALIFIER}", () => def.qualifier)
    .replace("{SCOPE_INSTRUCTIONS}", () => scopeInstructions)
    .replace("{FOCUS_CONTEXT}", () => def.context)
    .replace("{ADDITIONAL_CONTEXT_SECTION}", () => additionalContextSection)
    .replace("{PROJECT_GUIDELINES_SECTION}", () => projectGuidelinesSection)
    .replace("{OUTPUT_CONTRACT}", () => REVIEW_OUTPUT_CONTRACT_PROMPT);
}

function buildReviewDedupPrompt(findings: ReviewReportFinding[]): string {
  const findingsWithIds = findings.map((finding, index) => ({ id: index + 1, ...finding }));
  return REVIEW_DEDUP_PROMPT.replace("{REVIEW_FINDINGS_JSON}", () =>
    JSON.stringify({ findings: findingsWithIds }, null, 2),
  );
}

// --- Focus task execution ---

function parseReviewDedupOutput(parsed: unknown, totalFindings: number): ReviewDedupGroup[] | null {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("groups" in parsed) ||
    !Array.isArray(parsed.groups)
  ) {
    return null;
  }

  const groups: ReviewDedupGroup[] = [];
  const seenIds = new Set<number>();

  for (const group of parsed.groups) {
    if (
      typeof group !== "object" ||
      group === null ||
      !("ids" in group) ||
      !Array.isArray(group.ids)
    ) {
      return null;
    }

    const normalizedIds = group.ids
      .map((value: unknown) => Number(value))
      .filter((id: number): id is number => Number.isInteger(id) && id >= 1 && id <= totalFindings);
    const ids = [...new Set<number>(normalizedIds)].sort((a, b) => a - b);
    if (ids.length < 2) {
      return null;
    }

    for (const id of ids) {
      if (seenIds.has(id)) {
        return null;
      }
      seenIds.add(id);
    }

    // Reason is requested to make duplicate judgments explicit; the host only needs ids.
    groups.push({ ids });
  }

  return groups;
}

function formatThinkingFallbackError(
  result: FocusTaskResult,
  triedLevels: ReviewThinkingLevel[],
): FocusTaskResult {
  if (triedLevels.length <= 1 || !result.error) return result;
  return {
    ...result,
    error: `Automatic reasoning fallback failed after trying ${triedLevels.join(" -> ")}. Last error: ${result.error}`,
  };
}

function getExplicitThinkingSupportError(attempt: FocusTaskAttempt): string | undefined {
  if (attempt.model.thinkingSource !== "explicit" || !attempt.currentThinkingLevel)
    return undefined;
  if (
    attempt.currentThinkingLevel !== "off" &&
    attempt.providerCandidate.supportsThinking === false
  ) {
    return `Reasoning level '${attempt.currentThinkingLevel}' is not supported by this model.`;
  }
  if (
    attempt.currentThinkingLevel === "xhigh" &&
    attempt.providerCandidate.supportsXhigh === false
  ) {
    return "Reasoning level 'xhigh' is not supported by this model.";
  }
  return undefined;
}

function createUnsupportedReasoningFocusAttemptResult(
  attempt: FocusTaskAttempt,
  error: string,
): FocusTaskResult {
  return {
    focus: attempt.focus,
    model: buildFocusTaskAttemptModelLabel(attempt),
    ok: false,
    error,
    errorKind: "unsupported_reasoning",
  };
}

function createCancelledFocusAttemptResult(attempt: FocusTaskAttempt): FocusTaskResult {
  return {
    focus: attempt.focus,
    model: buildFocusTaskAttemptModelLabel(attempt),
    ok: false,
    error: REVIEW_CANCELLED_ERROR,
    errorKind: "other",
  };
}

function createCancelledFocusResult(task: FocusTask): FocusTaskResult {
  return createCancelledFocusAttemptResult(
    createFocusTaskAttempt(task, getResolvedReviewPrimaryProviderCandidate(task.model)),
  );
}

function buildFocusTaskAttemptModelLabel(attempt: FocusTaskAttempt): string {
  return buildResolvedReviewModelLabel(attempt.model, attempt.currentThinkingLevel);
}

function getFocusTaskAttemptModelArg(attempt: FocusTaskAttempt): string | undefined {
  if (attempt.providerCandidate.modelArg) return attempt.providerCandidate.modelArg;
  return attempt.providerCandidate.baseModelArg
    ? appendModelThinkingSuffix(
        attempt.providerCandidate.baseModelArg,
        attempt.currentThinkingLevel,
      )
    : undefined;
}

function createFocusTaskAttempt(
  task: FocusTask,
  providerCandidate: ResolvedReviewProviderCandidate,
  currentThinkingLevel = getResolvedReviewCurrentThinkingLevel(task.model, providerCandidate),
): FocusTaskAttempt {
  return {
    ...task,
    providerCandidate,
    currentThinkingLevel,
  };
}

async function runFocusTaskOnce(
  task: FocusTaskAttempt,
  cwd: string,
  control?: ReviewExecutionControl,
): Promise<FocusTaskResult> {
  const modelLabel = buildFocusTaskAttemptModelLabel(task);
  const modelArg = getFocusTaskAttemptModelArg(task);
  const args = [
    "--mode",
    "json",
    "-p",
    "--tools",
    REVIEW_TOOLS,
    "--no-extensions",
    "--extension",
    SUBMIT_REVIEW_EXTENSION_PATH,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
  ];
  if (modelArg) {
    args.push("--model", modelArg);
  }

  const taskResult = await runPiSubmitToolTask({
    args,
    prompt: task.prompt,
    cwd,
    timeoutMs: REVIEW_TASK_TIMEOUT_MS,
    control,
    submitTool: SUBMIT_REVIEW_TOOL,
  });

  if (taskResult.status === "cancelled") {
    return createCancelledFocusAttemptResult(task);
  }

  if (taskResult.status === "timeout") {
    return {
      focus: task.focus,
      model: modelLabel,
      ok: false,
      error: "Review timed out after 30 minutes.",
      errorKind: "other",
    };
  }

  if (taskResult.status === "spawn_error") {
    const error = `Failed to start focus process: ${taskResult.error ?? "unknown error"}`;
    return {
      focus: task.focus,
      model: modelLabel,
      ok: false,
      error,
      ...classifyTaskError(error),
    };
  }

  if (taskResult.status === "non_zero_exit") {
    const stderr = taskResult.stderr.trim();
    const error = `Focus exited with code ${taskResult.exitCode ?? 1}${stderr ? `: ${stderr}` : ""}`;
    return {
      focus: task.focus,
      model: modelLabel,
      ok: false,
      error,
      ...classifyTaskError(`${taskResult.stderr}\n${error}`),
    };
  }

  if (taskResult.status === "assistant_error") {
    const classification = classifyTaskError(taskResult.error ?? "");
    const error =
      classification.errorKind === "missing_api_key"
        ? `Missing API key for provider '${classification.missingApiProvider ?? "unknown"}'. Use /login or configure credentials for that provider.`
        : classification.errorKind === "rate_limit"
          ? appendErrorDetails(
              "Focus failed due to rate limiting. Try again later or switch models.",
              taskResult.error,
            )
          : buildProviderErrorMessage("Focus failed due to a provider error.", taskResult.error);
    return {
      focus: task.focus,
      model: modelLabel,
      ok: false,
      error,
      ...classification,
    };
  }

  const submittedPayload = getSubmittedPayload({
    submittedPayloads: taskResult.submittedPayloads,
    assistantOutput: taskResult.assistantOutput,
    submitTool: SUBMIT_REVIEW_TOOL,
    taskLabel: "Focus",
  });
  if (!submittedPayload.ok) {
    return {
      focus: task.focus,
      model: modelLabel,
      ok: false,
      error: submittedPayload.error,
      errorKind: "other",
    };
  }

  return {
    focus: task.focus,
    model: modelLabel,
    ok: true,
    output: {
      focus: task.focus,
      model: modelLabel,
      findings: (submittedPayload.payload as { findings: FocusFinding[] }).findings,
    },
  };
}

async function runFocusTaskWithRetry(
  task: FocusTaskAttempt,
  cwd: string,
  control?: ReviewExecutionControl,
): Promise<FocusTaskResult> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runFocusTaskOnce(task, cwd, control);
    if (result.ok || attempt >= REVIEW_STARTUP_RETRY_DELAYS_MS.length) return result;

    if (result.errorKind !== "lock_contention") return result;
    if (control?.isCancelled()) {
      return createCancelledFocusAttemptResult(task);
    }

    const baseDelayMs =
      REVIEW_STARTUP_RETRY_DELAYS_MS[attempt] ??
      REVIEW_STARTUP_RETRY_DELAYS_MS[REVIEW_STARTUP_RETRY_DELAYS_MS.length - 1];
    await new Promise((resolve) => setTimeout(resolve, withJitter(baseDelayMs)));
  }
}

function getFocusTaskThinkingLevels(
  task: FocusTask,
  providerCandidate: ResolvedReviewProviderCandidate,
): Array<ReviewThinkingLevel | undefined> {
  const currentThinkingLevel = getResolvedReviewCurrentThinkingLevel(task.model, providerCandidate);
  if (task.model.thinkingSource !== "inherited" || !currentThinkingLevel) {
    return [currentThinkingLevel];
  }

  return getFallbackThinkingLevels(currentThinkingLevel);
}

function getProviderCandidateAvailabilityFromResult(
  result: FocusTaskResult,
): "supported" | "unsupported" {
  return result.errorKind === "unsupported_model" || result.errorKind === "unsupported_reasoning"
    ? "unsupported"
    : "supported";
}

async function runFocusTaskForProviderCandidate(
  task: FocusTask,
  providerCandidate: ResolvedReviewProviderCandidate,
  cwd: string,
  control?: ReviewExecutionControl,
): Promise<FocusTaskResult> {
  const thinkingLevels = getFocusTaskThinkingLevels(task, providerCandidate);
  const triedLevels: ReviewThinkingLevel[] = [];
  let lastResult: FocusTaskResult | undefined;

  for (let index = 0; index < thinkingLevels.length; index += 1) {
    const currentThinkingLevel = thinkingLevels[index];
    const attempt = createFocusTaskAttempt(task, providerCandidate, currentThinkingLevel);
    const explicitThinkingSupportError = getExplicitThinkingSupportError(attempt);
    if (explicitThinkingSupportError) {
      return createUnsupportedReasoningFocusAttemptResult(attempt, explicitThinkingSupportError);
    }

    const result = await runFocusTaskWithRetry(attempt, cwd, control);
    if (result.ok) return result;

    lastResult = result;
    if (currentThinkingLevel !== undefined) {
      triedLevels.push(currentThinkingLevel);
    }

    if (result.errorKind === "unsupported_model") {
      return result;
    }

    const hasLowerThinkingLevel = index < thinkingLevels.length - 1;
    const shouldFallback = hasLowerThinkingLevel && result.errorKind === "unsupported_reasoning";
    if (!shouldFallback) {
      return formatThinkingFallbackError(result, triedLevels);
    }
  }

  return lastResult ?? createCancelledFocusResult(task);
}

async function runFocusTask(
  task: FocusTask,
  cwd: string,
  control?: ReviewExecutionControl,
): Promise<FocusTaskResult> {
  if (control?.isCancelled()) {
    return createCancelledFocusResult(task);
  }

  let lastResult: FocusTaskResult | undefined;

  for (const providerCandidate of task.model.providerCandidates) {
    const availability = getProviderCandidateAvailability(task.model, providerCandidate);
    if (availability === "unsupported") {
      continue;
    }
    if (availability === "supported") {
      const result = await runFocusTaskForProviderCandidate(task, providerCandidate, cwd, control);
      if (result.ok) return result;
      lastResult = result;
      if (
        result.errorKind === "unsupported_model" ||
        result.errorKind === "unsupported_reasoning"
      ) {
        setProviderCandidateAvailability(task.model, providerCandidate, "unsupported");
        continue;
      }
      return result;
    }

    const existingProbe = getProviderCandidateProbe(task.model, providerCandidate);
    if (existingProbe) {
      const probedAvailability = await existingProbe;
      if (probedAvailability === "unsupported") {
        continue;
      }

      const result = await runFocusTaskForProviderCandidate(task, providerCandidate, cwd, control);
      if (result.ok) return result;
      lastResult = result;
      if (
        result.errorKind === "unsupported_model" ||
        result.errorKind === "unsupported_reasoning"
      ) {
        setProviderCandidateAvailability(task.model, providerCandidate, "unsupported");
        continue;
      }
      return result;
    }

    let resolveProbe: ((value: "supported" | "unsupported") => void) | undefined;
    let rejectProbe: ((reason?: unknown) => void) | undefined;
    const probe = new Promise<"supported" | "unsupported">((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    setProviderCandidateProbe(task.model, providerCandidate, probe);

    try {
      const result = await runFocusTaskForProviderCandidate(task, providerCandidate, cwd, control);
      lastResult = result;
      const probedAvailability = getProviderCandidateAvailabilityFromResult(result);
      setProviderCandidateAvailability(task.model, providerCandidate, probedAvailability);
      resolveProbe?.(probedAvailability);
      if (result.ok) return result;
      if (probedAvailability === "unsupported") {
        continue;
      }
      return result;
    } catch (error) {
      rejectProbe?.(error);
      throw error;
    } finally {
      clearProviderCandidateProbe(task.model, providerCandidate);
    }
  }

  return lastResult ?? createCancelledFocusResult(task);
}

async function runReviewDedupTask(options: {
  ctx: ExtensionCommandContext;
  cwd: string;
  findings: ReviewReportFinding[];
  control?: ReviewExecutionControl;
}): Promise<ReviewDedupGroup[] | null> {
  const { ctx, cwd, findings, control } = options;
  if (findings.length <= 1) return [];
  if (control?.isCancelled()) return null;

  const model = selectReviewDedupModel(ctx);
  if (!model) return null;

  const taskResult = await withSpinner(
    ctx,
    () => `deduplicating ${findings.length} review findings`,
    () =>
      runPiOneShotTask({
        args: [
          "--mode",
          "json",
          "-p",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--model",
          model.modelArg,
        ],
        prompt: buildReviewDedupPrompt(findings),
        cwd,
        timeoutMs: REVIEW_TASK_TIMEOUT_MS,
        control,
      }),
  );

  if (taskResult.status !== "ok") {
    return null;
  }

  try {
    return parseReviewDedupOutput(parseJsonFromText(taskResult.assistantOutput), findings.length);
  } catch {
    return null;
  }
}

const SCOPE_MODES = new Set(["working-tree", "branch-diff", "commit", "folder", "custom"]);

function isScopeMode(value: unknown): value is ResolvedScope["kind"] {
  return typeof value === "string" && SCOPE_MODES.has(value);
}

const REQUEST_MODE_PREFIXES = ["branch:", "commit:", "pr:", "folder:"];

function isReviewRequestMode(value: unknown): value is ReviewRequestMode {
  if (typeof value !== "string") return false;
  if (value === "auto" || value === "uncommitted" || value === "custom") return true;
  return REQUEST_MODE_PREFIXES.some(
    (prefix) => value.startsWith(prefix) && value.length > prefix.length,
  );
}

function parseReviewStaleness(value: unknown): ReviewStaleness | undefined | null {
  if (value === undefined) return undefined;
  const staleness = asRecord(value);
  if (!staleness) return null;
  if (staleness.status !== "stale") return null;
  if (typeof staleness.warning !== "string") return null;
  if (typeof staleness.nextStep !== "string") return null;
  return {
    status: "stale",
    warning: staleness.warning,
    nextStep: staleness.nextStep,
  };
}

function buildReviewStaleness(source: ReviewRunSource): ReviewStaleness {
  if (source === "fix") {
    return {
      status: "stale",
      warning: REVIEW_STALE_FIX_WARNING,
      nextStep: REVIEW_STALE_FIX_NEXT_STEP,
    };
  }

  return {
    status: "stale",
    warning: REVIEW_STALE_REVIEW_WARNING,
    nextStep: REVIEW_STALE_REVIEW_NEXT_STEP,
  };
}

export function buildStalePayloadStaleness(): ReviewStaleness {
  return {
    status: "stale",
    warning: REVIEW_STALE_PAYLOAD_WARNING,
    nextStep: REVIEW_STALE_PAYLOAD_NEXT_STEP,
  };
}

function buildReviewFooterNotes(staleness: ReviewStaleness | undefined): string[] {
  if (!staleness) return [];
  return [staleness.warning, staleness.nextStep];
}

function parseReviewMessageDetails(value: unknown): ReviewMessageDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as ReviewMessageDetails;
  if (details.kind !== undefined && details.kind !== "report") return null;
  if (!isReviewRequestMode(details.request?.mode)) return null;
  if (typeof details.request?.signature !== "string") return null;
  if (!isScopeMode(details.scope?.mode)) return null;
  if (
    !details.fingerprint ||
    typeof details.fingerprint !== "object" ||
    typeof details.fingerprint.headSha !== "string" ||
    typeof details.fingerprint.branch !== "string" ||
    typeof details.fingerprint.trackedDiffHash !== "string" ||
    typeof details.fingerprint.untrackedHash !== "string"
  ) {
    return null;
  }

  const staleness = parseReviewStaleness(details.staleness);
  if (staleness === null) return null;

  if (!Array.isArray(details.focusStatus) || !Array.isArray(details.findings)) return null;
  return {
    ...details,
    staleness,
  };
}

export function getLastMessageReviewDetails(ctx: ExtensionContext): ReviewMessageDetails | null {
  const entry = ctx.sessionManager.getBranch().at(-1);
  if (!entry || entry.type !== "custom_message" || entry.customType !== "review") {
    return null;
  }

  return parseReviewMessageDetails(entry.details);
}

// --- Review pipeline ---

function buildReviewTasks(
  scope: ResolvedScope,
  guidelines: string | null,
  additionalContext: string | undefined,
  models: ResolvedReviewModel[],
  focuses: readonly ReviewFocus[],
): FocusTask[] {
  const scopeInstructions = buildScopeInstructions(scope);
  const tasks: FocusTask[] = [];

  for (const model of models) {
    for (const focus of focuses) {
      tasks.push({
        model,
        focus,
        prompt: buildFocusPrompt(focus, scopeInstructions, guidelines, additionalContext),
      });
    }
  }

  return tasks;
}

async function prepareReviewRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  request: ParsedRequest,
): Promise<{ ok: false; error: string } | { ok: true; data: PreparedReviewRun }> {
  if (!(await isGitRepo(pi))) {
    return { ok: false, error: "Not a git repository." };
  }

  const resolved = await resolveScope(pi, request.target, (message, type) =>
    notify(ctx, message, type),
  );
  if (!resolved.scope) {
    return { ok: false, error: resolved.error ?? "Failed to resolve review scope." };
  }

  const scope = resolved.scope;
  const includeUntracked = scope.kind === "working-tree" || scope.kind === "folder";
  const scopeUntrackedFiles = scope.kind === "working-tree" ? scope.untrackedFiles : undefined;
  const [baselineFingerprint, guidelines, models] = await Promise.all([
    computeCurrentFingerprint(pi, ctx.cwd, includeUntracked, scopeUntrackedFiles),
    loadProjectReviewGuidelines(ctx.cwd),
    resolveModels(ctx, request.models, pi.getThinkingLevel()),
  ]);

  return {
    ok: true,
    data: {
      scope,
      includeUntracked,
      baselineFingerprint,
      models,
      tasks: buildReviewTasks(
        scope,
        guidelines,
        request.additionalContext,
        models,
        request.focuses,
      ),
    },
  };
}

async function runFocusTasks(
  ctx: ExtensionCommandContext,
  cwd: string,
  tasks: FocusTask[],
  control: ReviewExecutionControl,
): Promise<FocusTaskResult[]> {
  const progress = createReviewProgress(ctx, tasks);
  try {
    return await Promise.all(
      tasks.map(async (task) => {
        const result = control.isCancelled()
          ? createCancelledFocusResult(task)
          : await runFocusTask(task, cwd, control);
        progress.update(task, result);
        return result;
      }),
    );
  } finally {
    progress.stop();
  }
}

function sortReviewFindings(findings: ReviewReportFinding[]): void {
  findings.sort((a, b) => {
    const prio = priorityRank(a.priority) - priorityRank(b.priority);
    if (prio !== 0) return prio;

    const locationCmp = a.location.localeCompare(b.location);
    if (locationCmp !== 0) return locationCmp;

    if (a.focus !== b.focus) return a.focus.localeCompare(b.focus);
    return a.model.localeCompare(b.model);
  });
}

function applyReviewDedupGroups(
  findings: ReviewReportFinding[],
  groups: ReviewDedupGroup[],
): ReviewReportFinding[] {
  if (groups.length === 0) return findings;

  const next = findings.slice();
  const dropped = new Set<number>();

  for (const group of groups) {
    // Dedup ids are 1-based positions in priority-sorted order, so the lowest id is the preferred survivor.
    const keepId = Math.min(...group.ids);
    const groupedFindings = group.ids.map((id) => findings[id - 1]);
    const survivor = findings[keepId - 1];
    const priorities = groupedFindings
      .map((finding) => finding.priority)
      .sort((a, b) => priorityRank(a) - priorityRank(b));
    const focuses = Array.from(new Set(groupedFindings.map((finding) => finding.focus))).join(", ");
    const models = Array.from(new Set(groupedFindings.map((finding) => finding.model))).join(", ");

    next[keepId - 1] = {
      ...survivor,
      priority: priorities[0],
      focus: focuses,
      model: models,
    };

    for (const id of group.ids) {
      if (id !== keepId) {
        dropped.add(id);
      }
    }
  }

  return next.filter((_, index) => !dropped.has(index + 1));
}

async function buildReviewFindings(
  ctx: ExtensionCommandContext,
  cwd: string,
  successfulFocuses: Array<FocusTaskResult & { output: FocusOutput }>,
  control?: ReviewExecutionControl,
): Promise<ReviewReportFinding[]> {
  const findings = successfulFocuses.flatMap((focus) =>
    focus.output.findings.map((finding) => ({
      ...finding,
      focus: focus.focus,
      model: focus.model,
    })),
  );
  sortReviewFindings(findings);

  if (findings.length <= 1) {
    return findings;
  }

  const dedupGroups = await runReviewDedupTask({
    ctx,
    cwd,
    findings,
    control,
  });
  return dedupGroups ? applyReviewDedupGroups(findings, dedupGroups) : findings;
}

export async function runReviewPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  request: ParsedRequest,
  source: ReviewRunSource,
): Promise<ReviewRunResult> {
  const startedAtMs = Date.now();
  const prepared = await prepareReviewRun(pi, ctx, request);
  if (!prepared.ok) {
    return { ok: false, error: prepared.error };
  }

  return withManagedReviewRun(pi, ctx, source, async (managed) => {
    const { scope, includeUntracked, baselineFingerprint, models, tasks } = prepared.data;
    if (source === "review") {
      const modelsText = models
        .map((model) => buildResolvedReviewStatusModelLabel(model))
        .join(", ");
      notify(ctx, `Review focuses: ${request.focuses.join(", ")} · models: ${modelsText}.`, "info");
    }

    const focusResults = await runFocusTasks(ctx, ctx.cwd, tasks, managed.control);
    if (managed.control.isCancelled()) {
      managed.markCancelled();
      return { ok: false, error: REVIEW_CANCELLED_ERROR };
    }

    const failedFocuses = focusResults.filter((focus) => !focus.ok);
    const failedCount = failedFocuses.length;
    const totalReviews = focusResults.length;
    const completedReviews = totalReviews - failedCount;
    const successfulFocuses = focusResults.filter(
      (result): result is FocusTaskResult & { output: FocusOutput } =>
        Boolean(result.ok && result.output),
    );
    if (successfulFocuses.length === 0) {
      if (failedCount > 0) {
        const reviewedScopeLine = buildReviewedScopeLine(scope, Date.now() - startedAtMs);
        const failureReport = `${reviewedScopeLine}\n\n${buildReviewFailuresMarkdown(failedFocuses)}`;
        pi.sendMessage(
          {
            customType: "review",
            content: failureReport,
            display: true,
            details: { kind: "failure" satisfies ReviewMessageKind },
          },
          { deliverAs: "followUp" },
        );
      }

      const missingApiProvider = failedFocuses.find(
        (focus) => focus.errorKind === "missing_api_key" && Boolean(focus.missingApiProvider),
      )?.missingApiProvider;
      if (missingApiProvider) {
        return {
          ok: false,
          error: `All reviews failed. Missing API key for provider '${missingApiProvider}'. Use /login or configure credentials for that provider.`,
        };
      }

      const sampleError =
        focusResults.find((focus) => focus.error)?.error ?? "Unknown focus failure";
      return {
        ok: false,
        error: `All reviews failed. ${sampleError}`,
      };
    }

    const findings = await buildReviewFindings(ctx, ctx.cwd, successfulFocuses, managed.control);

    const endingFingerprint = await computeCurrentFingerprint(pi, ctx.cwd, includeUntracked);
    const reviewStaleness = !fingerprintsEqual(baselineFingerprint, endingFingerprint)
      ? buildReviewStaleness(source)
      : undefined;

    if (managed.control.isCancelled()) {
      managed.markCancelled();
      return { ok: false, error: REVIEW_CANCELLED_ERROR };
    }

    const reviewedScopeLine = buildReviewedScopeLine(scope, Date.now() - startedAtMs);
    let findingsMarkdown = buildReviewFindingsMarkdown(
      reviewedScopeLine,
      findings,
      completedReviews,
      totalReviews,
      buildReviewFooterNotes(reviewStaleness),
    );
    if (failedCount > 0) {
      findingsMarkdown = `${findingsMarkdown.trimEnd()}\n\n${buildReviewFailuresMarkdown(failedFocuses)}`;
    }
    const details: ReviewMessageDetails = {
      kind: "report",
      request: {
        mode: request.mode,
        signature: buildRequestSignature(request),
      },
      scope: {
        mode: scope.kind,
        description: scope.description,
      },
      fingerprint: reviewStaleness ? baselineFingerprint : endingFingerprint,
      staleness: reviewStaleness,
      focusStatus: focusResults.map((focus) => ({
        focus: focus.focus,
        model: focus.model,
        ok: focus.ok,
        error: focus.error,
      })),
      findings,
    };

    pi.sendMessage(
      {
        customType: "review",
        content: findingsMarkdown,
        display: true,
        details,
      },
      { deliverAs: "followUp" },
    );

    if (reviewStaleness) {
      if (failedCount > 0) {
        const failedLabel = `review${failedCount === 1 ? "" : "s"}`;
        notify(
          ctx,
          `Review completed with stale partial results: ${failedCount} ${failedLabel} failed.`,
          "warning",
        );
      } else {
        notify(
          ctx,
          `Review completed with stale results: ${findings.length} finding(s).`,
          "warning",
        );
      }
    } else if (failedCount > 0) {
      const failedLabel = `review${failedCount === 1 ? "" : "s"}`;
      notify(
        ctx,
        `Review completed with partial results: ${failedCount} ${failedLabel} failed.`,
        "warning",
      );
    } else {
      notify(ctx, `Review completed: ${findings.length} finding(s).`, "info");
    }

    managed.markSuccessful();
    return { ok: true, details };
  });
}
