import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  buildProjectReviewGuidelinesSection,
  TRIAGE_METADATA_QUERY,
  TRIAGE_PROMPT,
  TRIAGE_THREADS_QUERY,
} from "./prompts.js";
import { buildTriageMarkdown } from "./renderers/inline.js";
import { parsePrReference } from "./request.js";
import {
  appendErrorDetails,
  asRecord,
  buildProviderErrorMessage,
  classifyTaskError,
  getSubmittedPayload,
  REVIEW_INSPECTION_TOOLS,
  REVIEW_STARTUP_RETRY_DELAYS_MS,
  REVIEW_TASK_TIMEOUT_MS,
  runPiSubmitToolTask,
  runReviewCommand,
  type ReviewCommandContext,
  withJitter,
} from "./runner.js";
import {
  computeCurrentFingerprint,
  fingerprintsEqual,
  buildScopeInstructions,
  getPrCheckoutBlockedError,
  isGitRepo,
  loadProjectReviewGuidelines,
  preparePrCheckoutScope,
  type ResolvedScope,
} from "./git.js";
import {
  buildResolvedReviewStatusModelLabel,
  getResolvedReviewStatusModelArg,
  resolveModels,
  type ResolvedReviewModel,
} from "./models.js";
import {
  notify,
  REVIEW_CANCELLED_ERROR,
  joinAll,
  withSpinner,
  type ReviewRuntime,
} from "./runtime.js";
import type { ReviewFingerprint } from "./schema.js";
import { SUBMIT_TRIAGE_EXTENSION_PATH } from "./submit-triage-tool.js";

const SUBMIT_TRIAGE_TOOL = "submit_triage";
const TRIAGE_TOOLS = `${REVIEW_INSPECTION_TOOLS},${SUBMIT_TRIAGE_TOOL}`;

type TriageFeedbackKind = "review-thread" | "review-summary" | "pr-comment";
type TriageDecision = "address" | "push_back" | "research" | "ignore";

type TriageFeedbackComment = {
  author: string;
  body: string;
  url?: string;
  createdAt?: string;
};

type TriageFeedbackItem = {
  id: string;
  kind: TriageFeedbackKind;
  author: string;
  location: string;
  url?: string;
  body?: string;
  state?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: TriageFeedbackComment[];
};

type TriageItem = {
  id: string;
  decision: TriageDecision;
  summary: string;
  rationale: string;
  action: string;
};

type TriageMessageItem = TriageItem & {
  feedbackKind: TriageFeedbackKind;
  location: string;
  author: string;
  url?: string;
};

type TriageMessageDetails = {
  kind: "triage";
  generatedAt: string;
  pr: {
    number: number;
    url: string;
    title: string;
    baseBranch: string;
    headBranch: string;
    ref: string;
  };
  scope: {
    mode: ResolvedScope["kind"];
    description: string;
  };
  feedbackCount: number;
  items: TriageMessageItem[];
};

export type TriageRunResult =
  | { ok: false; error: string }
  | { ok: true; details: TriageMessageDetails };

type TriagePrContext = {
  prNumber: number;
  prRef: string;
  prUrl: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  author: string;
  scope: Extract<ResolvedScope, { kind: "branch-diff" }>;
  baselineFingerprint: ReviewFingerprint;
  feedbackItems: TriageFeedbackItem[];
};

// --- Helpers ---

function getConnectionNodes(value: unknown): unknown[] {
  const record = asRecord(value);
  return record && Array.isArray(record.nodes) ? record.nodes : [];
}

function getNestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return asRecord(current);
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getRequiredString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getAuthorLogin(value: unknown): string {
  const author = asRecord(value);
  return typeof author?.login === "string" ? author.login : "unknown";
}

async function fetchPrTriageMetadata(
  workspace: ReviewCommandContext,
  prNumber: number,
): Promise<{
  prNumber: number;
  prUrl: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  author: string;
  comments: TriageFeedbackItem[];
  reviews: TriageFeedbackItem[];
} | null> {
  const { stdout, code } = await runReviewCommand(workspace, "gh", [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-F",
    `number=${prNumber}`,
    "-f",
    `query=${TRIAGE_METADATA_QUERY}`,
  ]);
  if (code !== 0) return null;

  try {
    const root = asRecord(JSON.parse(stdout));
    const pr = getNestedRecord(root, "data", "repository", "pullRequest");
    if (!pr) return null;

    const number = getOptionalNumber(pr.number);
    const prUrl = getRequiredString(pr.url);
    const title = getRequiredString(pr.title);
    const body = getRequiredString(pr.body) ?? "";
    const baseBranch = getRequiredString(pr.baseRefName);
    const headBranch = getRequiredString(pr.headRefName);
    if (!number || !prUrl || !title || !baseBranch || !headBranch) return null;

    const prAuthor = getAuthorLogin(pr.author);
    const comments = getConnectionNodes(pr.comments)
      .map((node, index): TriageFeedbackItem | null => {
        const record = asRecord(node);
        if (!record) return null;
        const bodyText = (getRequiredString(record.body) ?? "").trim();
        const author = getAuthorLogin(record.author);
        if (!bodyText || author === prAuthor) return null;
        return {
          id: `comment-${index + 1}`,
          kind: "pr-comment",
          author,
          location: "PR conversation",
          url: getOptionalString(record.url),
          body: bodyText,
        };
      })
      .filter((item): item is TriageFeedbackItem => item !== null);

    const reviews = getConnectionNodes(pr.reviews)
      .map((node, index): TriageFeedbackItem | null => {
        const record = asRecord(node);
        if (!record) return null;
        const bodyText = (getRequiredString(record.body) ?? "").trim();
        if (!bodyText) return null;
        return {
          id: `review-${index + 1}`,
          kind: "review-summary",
          author: getAuthorLogin(record.author),
          location: "Review summary",
          url: getOptionalString(record.url),
          body: bodyText,
          state: getOptionalString(record.state),
        };
      })
      .filter((item): item is TriageFeedbackItem => item !== null);

    return {
      prNumber: number,
      prUrl,
      title,
      body,
      baseBranch,
      headBranch,
      author: prAuthor,
      comments,
      reviews,
    };
  } catch {
    return null;
  }
}

function formatThreadLocation(options: {
  path?: string;
  line?: number;
  originalLine?: number;
  startLine?: number;
  originalStartLine?: number;
}): string {
  const path = options.path?.trim();
  const endLine = options.line ?? options.originalLine;
  const startLine = options.startLine ?? options.originalStartLine;
  if (!path) return endLine ? `review thread:${endLine}` : "review thread";
  if (!endLine) return path;
  if (startLine && startLine !== endLine) return `${path}:${startLine}-${endLine}`;
  return `${path}:${endLine}`;
}

function pickThreadAuthor(comments: TriageFeedbackComment[], prAuthor: string): string {
  const externalComment = comments.find(
    (comment) => comment.author !== prAuthor && comment.author !== "unknown",
  );
  if (externalComment) return externalComment.author;
  return comments[0]?.author ?? "unknown";
}

async function fetchPrReviewThreads(
  workspace: ReviewCommandContext,
  prNumber: number,
  prAuthor: string,
): Promise<TriageFeedbackItem[] | null> {
  const { stdout, code } = await runReviewCommand(workspace, "gh", [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-F",
    `number=${prNumber}`,
    "-f",
    `query=${TRIAGE_THREADS_QUERY}`,
  ]);
  if (code !== 0) return null;

  try {
    const pages = JSON.parse(stdout);
    if (!Array.isArray(pages)) return null;

    const items: TriageFeedbackItem[] = [];
    for (const page of pages) {
      const threads = getConnectionNodes(
        getNestedRecord(page, "data", "repository", "pullRequest", "reviewThreads"),
      );
      for (const thread of threads) {
        const record = asRecord(thread);
        if (!record) continue;
        const comments = getConnectionNodes(record.comments)
          .map((node): TriageFeedbackComment | null => {
            const comment = asRecord(node);
            if (!comment) return null;
            const body = (getRequiredString(comment.body) ?? "").trim();
            if (!body) return null;
            return {
              author: getAuthorLogin(comment.author),
              body,
              url: getOptionalString(comment.url),
              createdAt: getOptionalString(comment.createdAt),
            };
          })
          .filter((comment): comment is TriageFeedbackComment => comment !== null);
        if (comments.length === 0) continue;

        items.push({
          id: `thread-${items.length + 1}`,
          kind: "review-thread",
          author: pickThreadAuthor(comments, prAuthor),
          location: formatThreadLocation({
            path: getOptionalString(record.path),
            line: getOptionalNumber(record.line),
            originalLine: getOptionalNumber(record.originalLine),
            startLine: getOptionalNumber(record.startLine),
            originalStartLine: getOptionalNumber(record.originalStartLine),
          }),
          url: comments[comments.length - 1]?.url,
          isResolved: getOptionalBoolean(record.isResolved),
          isOutdated: getOptionalBoolean(record.isOutdated),
          comments,
        });
      }
    }

    return items;
  } catch {
    return null;
  }
}

function buildTriageFeedbackItems(metadata: {
  comments: TriageFeedbackItem[];
  reviews: TriageFeedbackItem[];
  threads: TriageFeedbackItem[];
}): TriageFeedbackItem[] {
  return [...metadata.threads, ...metadata.reviews, ...metadata.comments];
}

function buildTriagePrompt(context: TriagePrContext, projectGuidelines: string | null): string {
  const projectGuidelinesSection = buildProjectReviewGuidelinesSection(projectGuidelines);
  const triageInput = JSON.stringify(
    {
      pr: {
        number: context.prNumber,
        url: context.prUrl,
        title: context.title,
        body: context.body,
        base_branch: context.baseBranch,
        head_branch: context.headBranch,
        author: context.author,
      },
      feedback: context.feedbackItems,
    },
    null,
    2,
  );

  return TRIAGE_PROMPT.replace("{SCOPE_INSTRUCTIONS}", () => buildScopeInstructions(context.scope))
    .replace("{PROJECT_GUIDELINES_SECTION}", () => projectGuidelinesSection)
    .replace("{TRIAGE_INPUT_JSON}", () => triageInput);
}

function validateTriageOutput(parsed: unknown, feedbackItems: TriageFeedbackItem[]): TriageItem[] {
  const items = (parsed as { items?: TriageItem[] }).items;
  if (!Array.isArray(items)) {
    throw new Error("submit_triage payload must include an items array.");
  }

  const knownIds = new Set(feedbackItems.map((item) => item.id));
  const triageById = new Map<string, TriageItem>();
  const unknownIds = new Set<string>();
  for (const item of items) {
    if (!knownIds.has(item.id)) {
      unknownIds.add(item.id);
      continue;
    }
    if (triageById.has(item.id)) {
      throw new Error(`Triage output contains duplicate id ${item.id}.`);
    }
    triageById.set(item.id, item);
  }

  if (unknownIds.size > 0) {
    const preview = Array.from(unknownIds).slice(0, 5).join(", ");
    const suffix = unknownIds.size > 5 ? ", ..." : "";
    throw new Error(`Triage output contains ${unknownIds.size} unknown id(s): ${preview}${suffix}`);
  }

  const missingIds = feedbackItems
    .filter((item) => !triageById.has(item.id))
    .map((item) => item.id);
  if (missingIds.length > 0) {
    const preview = missingIds.slice(0, 5).join(", ");
    const suffix = missingIds.length > 5 ? ", ..." : "";
    throw new Error(
      `Triage output is missing ${missingIds.length} feedback item(s): ${preview}${suffix}`,
    );
  }

  return feedbackItems.map((item) => triageById.get(item.id) as TriageItem);
}

async function runTriageTask(options: {
  ctx: ExtensionCommandContext;
  cwd: string;
  prompt: string;
  model: ResolvedReviewModel;
  feedbackItems: TriageFeedbackItem[];
  signal: AbortSignal;
}): Promise<{ ok: true; items: TriageItem[] } | { ok: false; error: string }> {
  const { ctx, cwd, prompt, model, feedbackItems, signal } = options;
  const args = [
    "--mode",
    "json",
    "-p",
    "--tools",
    TRIAGE_TOOLS,
    "--no-extensions",
    "--extension",
    SUBMIT_TRIAGE_EXTENSION_PATH,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
  ];
  const modelArg = getResolvedReviewStatusModelArg(model);
  if (modelArg) {
    args.push("--model", modelArg);
  }

  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();

    const taskResult = await withSpinner(
      ctx,
      () => `triaging PR feedback (${feedbackItems.length} items)`,
      () =>
        runPiSubmitToolTask({
          args,
          prompt,
          cwd,
          timeoutMs: REVIEW_TASK_TIMEOUT_MS,
          signal,
          submitTool: SUBMIT_TRIAGE_TOOL,
        }),
    );

    if (taskResult.status === "cancelled") {
      return { ok: false, error: REVIEW_CANCELLED_ERROR };
    }
    if (taskResult.status === "timeout") {
      return { ok: false, error: "PR triage timed out after 30 minutes." };
    }
    if (taskResult.status === "spawn_error") {
      return {
        ok: false,
        error: `Failed to start triage process: ${taskResult.error ?? "unknown error"}`,
      };
    }
    if (taskResult.status === "non_zero_exit") {
      const stderr = taskResult.stderr.trim();
      const error = `Triage exited with code ${taskResult.exitCode ?? 1}${stderr ? `: ${stderr}` : ""}`;
      const classification = classifyTaskError(`${taskResult.stderr}\n${error}`);
      if (classification.errorKind === "missing_api_key") {
        return {
          ok: false,
          error: `Missing API key for provider '${classification.missingApiProvider ?? "unknown"}'. Use /login or configure credentials for that provider.`,
        };
      }
      if (
        classification.errorKind === "lock_contention" &&
        attempt < REVIEW_STARTUP_RETRY_DELAYS_MS.length
      ) {
        const baseDelayMs =
          REVIEW_STARTUP_RETRY_DELAYS_MS[attempt] ??
          REVIEW_STARTUP_RETRY_DELAYS_MS[REVIEW_STARTUP_RETRY_DELAYS_MS.length - 1];
        await delay(withJitter(baseDelayMs), undefined, { signal });
        continue;
      }
      return { ok: false, error };
    }
    if (taskResult.status === "assistant_error") {
      const classification = classifyTaskError(taskResult.error ?? "");
      if (classification.errorKind === "missing_api_key") {
        return {
          ok: false,
          error: `Missing API key for provider '${classification.missingApiProvider ?? "unknown"}'. Use /login or configure credentials for that provider.`,
        };
      }
      if (classification.errorKind === "rate_limit") {
        return {
          ok: false,
          error: appendErrorDetails(
            "Triage failed due to rate limiting. Try again later or switch models.",
            taskResult.error,
          ),
        };
      }
      return {
        ok: false,
        error: buildProviderErrorMessage(
          "Triage failed due to a provider error.",
          taskResult.error,
        ),
      };
    }

    const submittedPayload = getSubmittedPayload({
      submittedPayloads: taskResult.submittedPayloads,
      assistantOutput: taskResult.assistantOutput,
      submitTool: SUBMIT_TRIAGE_TOOL,
      taskLabel: "Triage",
    });
    if (!submittedPayload.ok) {
      return { ok: false, error: submittedPayload.error };
    }

    try {
      return {
        ok: true,
        items: validateTriageOutput(submittedPayload.payload, feedbackItems),
      };
    } catch (error) {
      return {
        ok: false,
        error: `submit_triage payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

async function prepareTriageContext(
  ctx: ExtensionCommandContext,
  prRef: string,
  signal: AbortSignal,
): Promise<{ ok: false; error: string } | { ok: true; data: TriagePrContext }> {
  const workspace = { cwd: ctx.cwd, signal };
  if (!(await isGitRepo(workspace))) {
    return { ok: false, error: "Not a git repository." };
  }

  const blockedError = await getPrCheckoutBlockedError(workspace);
  if (blockedError) {
    return { ok: false, error: blockedError };
  }

  const prNumber = parsePrReference(prRef);
  if (!prNumber) {
    return { ok: false, error: `Invalid PR reference: ${prRef}` };
  }

  notify(ctx, `Fetching PR #${prNumber} feedback...`, "info");
  const metadata = await fetchPrTriageMetadata(workspace, prNumber);
  if (!metadata) {
    return {
      ok: false,
      error: `Could not load PR #${prNumber}. Ensure gh is authenticated and PR exists.`,
    };
  }

  const [preparedPrScope, threads] = await joinAll([
    preparePrCheckoutScope(workspace, (message, type) => notify(ctx, message, type), {
      prNumber,
      baseBranch: metadata.baseBranch,
      headBranch: metadata.headBranch,
    }),
    fetchPrReviewThreads(workspace, prNumber, metadata.author),
  ]);
  if (!preparedPrScope.ok) {
    return { ok: false, error: preparedPrScope.error };
  }
  if (!threads) {
    return {
      ok: false,
      error: `Could not load review threads for PR #${prNumber}. Ensure gh is authenticated and GraphQL access is available.`,
    };
  }

  const feedbackItems = buildTriageFeedbackItems({
    comments: metadata.comments,
    reviews: metadata.reviews,
    threads,
  });
  const baselineFingerprint = await computeCurrentFingerprint(workspace, false);

  return {
    ok: true,
    data: {
      prNumber,
      prRef,
      prUrl: metadata.prUrl,
      title: metadata.title,
      body: metadata.body,
      baseBranch: metadata.baseBranch,
      headBranch: metadata.headBranch,
      author: metadata.author,
      scope: preparedPrScope.scope,
      baselineFingerprint,
      feedbackItems,
    },
  };
}

function buildTriageMessageDetails(
  context: TriagePrContext,
  items: TriageMessageItem[],
): TriageMessageDetails {
  return {
    kind: "triage",
    generatedAt: new Date().toISOString(),
    pr: {
      number: context.prNumber,
      url: context.prUrl,
      title: context.title,
      baseBranch: context.baseBranch,
      headBranch: context.headBranch,
      ref: context.prRef,
    },
    scope: {
      mode: context.scope.kind,
      description: context.scope.description,
    },
    feedbackCount: context.feedbackItems.length,
    items,
  };
}

export async function runTriagePipeline(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prRef: string,
  runtime: ReviewRuntime,
): Promise<TriageRunResult> {
  const startedAtMs = Date.now();
  return runtime.run(ctx, "triage", async (signal): Promise<TriageRunResult> => {
    const prepared = await prepareTriageContext(ctx, prRef, signal);
    signal.throwIfAborted();
    if (!prepared.ok) return prepared;
    const context = prepared.data;
    const workspace = { cwd: ctx.cwd, signal };
    if (context.feedbackItems.length === 0) {
      const details = buildTriageMessageDetails(context, []);
      pi.sendMessage(
        {
          customType: "review",
          content: buildTriageMarkdown(context, [], Date.now() - startedAtMs),
          display: true,
          details,
        },
        { deliverAs: "followUp" },
      );
      notify(ctx, "No PR feedback items found for triage.", "info");
      return { ok: true, details };
    }

    const [projectGuidelines, models] = await joinAll([
      loadProjectReviewGuidelines(workspace),
      resolveModels(ctx, [], pi.getThinkingLevel(), signal),
    ]);
    signal.throwIfAborted();
    const model = models[0];
    notify(
      ctx,
      `Triaging ${context.feedbackItems.length} feedback item(s) with ${buildResolvedReviewStatusModelLabel(model)}.`,
      "info",
    );

    const triageResult = await runTriageTask({
      ctx,
      cwd: ctx.cwd,
      prompt: buildTriagePrompt(context, projectGuidelines),
      model,
      feedbackItems: context.feedbackItems,
      signal,
    });
    signal.throwIfAborted();
    if (!triageResult.ok) return triageResult;

    const endingFingerprint = await computeCurrentFingerprint(workspace, false);
    signal.throwIfAborted();
    if (!fingerprintsEqual(context.baselineFingerprint, endingFingerprint)) {
      return {
        ok: false,
        error: "PR triage became stale while running (repository changed). Rerun /triage.",
      };
    }

    const items: TriageMessageItem[] = context.feedbackItems.map((feedback, index) => {
      const triageItem = triageResult.items[index];
      return {
        ...triageItem,
        feedbackKind: feedback.kind,
        location: feedback.location,
        author: feedback.author,
        url: feedback.url,
      };
    });
    const details = buildTriageMessageDetails(context, items);

    pi.sendMessage(
      {
        customType: "review",
        content: buildTriageMarkdown(context, items, Date.now() - startedAtMs),
        display: true,
        details,
      },
      { deliverAs: "followUp" },
    );
    notify(ctx, `Triage completed: ${items.length} feedback item(s).`, "info");
    return { ok: true, details };
  });
}
