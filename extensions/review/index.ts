/**
 * Unified /review + /triage + /fix extension.
 *
 * What this extension does:
 * - /review runs up to 6 parallel focuses (general, security, reuse, quality, testing, efficiency),
 *   then emits a single findings report.
 * - /triage fetches PR feedback from GitHub, inspects the checked-out PR diff,
 *   and classifies each item as address, push_back, research, or ignore.
 * - /fix applies findings from the review report. It reuses the last message only
 *   when that message is a matching review payload, even if stale. Otherwise it
 *   runs a fresh review first. If that fresh review becomes stale while running,
 *   /fix shows the findings and waits for an explicit rerun before applying fixes.
 *   context=... guides the fix pass without invalidating reusable review payloads.
 *   /fix loop repeats review + fix until the review produces no findings.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { prepareFixReviewDetails, runFixLoop, runFixPassFromReview } from "./fix.js";
import { createReviewMessageQueue, type ReviewMessageQueue } from "./message-queue.js";
import {
  getFixArgumentCompletions,
  getReviewArgumentCompletions,
  parseCommandRequest,
  parseFixCommandRequest,
  parseTriagePrRef,
  showReviewHelp,
  type ParseFailure,
} from "./request.js";
import { runReviewPipeline } from "./review.js";
import {
  acquireReviewRunLock,
  createAgentRunTracker,
  handleReviewSessionShutdown,
  handleReviewSessionStart,
  notify,
  recordPromptEnd,
  recordPromptStart,
  releaseReviewRunLock,
  type AgentEndMessages,
} from "./runtime.js";
import { runTriagePipeline } from "./triage.js";

function handleParseFailure(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  result: ParseFailure,
): void {
  if (result.help) {
    showReviewHelp(pi);
    return;
  }
  if (result.error) {
    notify(ctx, result.error, "error");
  }
}

function stopAndFlushReviewQueue(
  ctx: ExtensionCommandContext,
  reviewMessageQueue: ReviewMessageQueue,
  stopReviewQueue: () => void,
): void {
  stopReviewQueue();
  reviewMessageQueue.flushAll(ctx, { forceFollowUp: true });
}

type BackgroundRunResult = { ok: true } | { ok: false; error: string };

function startQueuedBackgroundRun(
  ctx: ExtensionCommandContext,
  reviewMessageQueue: ReviewMessageQueue,
  options: {
    busyMessage: string;
    startMessage: string;
    failurePrefix: string;
    run: () => Promise<BackgroundRunResult>;
  },
): void {
  const sessionKey = acquireReviewRunLock(ctx, options.busyMessage);
  if (!sessionKey) return;

  const stopReviewQueue = reviewMessageQueue.start(ctx);
  notify(ctx, options.startMessage, "info");
  void (async () => {
    try {
      const result = await options.run();
      if (!result.ok) {
        notify(ctx, result.error, "error");
      }
    } catch (error) {
      notify(
        ctx,
        `${options.failurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      releaseReviewRunLock(sessionKey);
      stopAndFlushReviewQueue(ctx, reviewMessageQueue, stopReviewQueue);
    }
  })();
}

export default function reviewExtension(pi: ExtensionAPI) {
  const reviewMessageQueue = createReviewMessageQueue(pi);
  const agentTracker = createAgentRunTracker();

  pi.events.on("ui:prompt_start", () => {
    recordPromptStart();
  });

  pi.events.on("ui:prompt_end", () => {
    recordPromptEnd();
  });

  pi.on("input", async (event, ctx) => {
    if (!reviewMessageQueue.handleInput(event, ctx)) return { action: "continue" };
    return { action: "handled" };
  });

  pi.on("agent_start", async () => {
    agentTracker.handleStart();
  });

  pi.on("session_start", async (_event, ctx) => {
    handleReviewSessionStart(ctx);
    agentTracker.reset();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    handleReviewSessionShutdown(ctx);
    reviewMessageQueue.clear(ctx);
    agentTracker.reset();
  });

  pi.on("agent_end", async (event) => {
    agentTracker.handleEnd({
      messages: event.messages as AgentEndMessages,
    });
  });

  pi.on("agent_settled", async () => {
    agentTracker.handleSettled();
  });

  pi.registerCommand("review", {
    description:
      "Run findings-only review across up to 6 focuses (general/security/reuse/quality/testing/efficiency). Use /review help for full usage.",
    getArgumentCompletions: getReviewArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseCommandRequest(args);
      if (!parsed.ok) {
        handleParseFailure(pi, ctx, parsed);
        return;
      }

      startQueuedBackgroundRun(ctx, reviewMessageQueue, {
        busyMessage: "A /review run is already active in this session.",
        startMessage: "Starting review in background...",
        failurePrefix: "Review run failed",
        run: () => runReviewPipeline(pi, ctx, parsed.value, "review"),
      });
    },
  });

  pi.registerCommand("triage", {
    description:
      "Fetch PR feedback from GitHub, inspect the checked-out PR diff, and classify each item as address, push_back, research, or ignore.",
    handler: async (args, ctx) => {
      const parsed = parseTriagePrRef(args);
      if (!parsed.ok) {
        handleParseFailure(pi, ctx, parsed);
        return;
      }

      startQueuedBackgroundRun(ctx, reviewMessageQueue, {
        busyMessage:
          "A review-related run is already active in this session. Wait for it to finish before /triage.",
        startMessage: "Starting PR triage in background...",
        failurePrefix: "PR triage failed",
        run: () => runTriagePipeline(pi, ctx, parsed.value),
      });
    },
  });

  pi.registerCommand("fix", {
    description:
      "Fix findings when the last message is a matching /review result. Otherwise, runs review first. Use /fix loop to repeat review + fix until clean. context=... guides the fix pass without forcing a fresh review. If the last review is stale, /fix warns and continues; if a /fix-started review goes stale mid-run, /fix shows the findings and applies no fixes. Use /review help for modes/options.",
    getArgumentCompletions: getFixArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseFixCommandRequest(args);
      if (!parsed.ok) {
        handleParseFailure(pi, ctx, parsed);
        return;
      }

      const { loop, request } = parsed.value;
      if (loop && (!ctx.isIdle() || ctx.hasPendingMessages())) {
        notify(ctx, "Wait for the agent to become idle before starting /fix loop.", "warning");
        return;
      }

      const sessionKey = acquireReviewRunLock(
        ctx,
        "A /review run is active in this session. Wait for it to finish before /fix.",
      );
      if (!sessionKey) return;

      const stopReviewQueue = reviewMessageQueue.start(ctx);
      try {
        if (loop) {
          notify(ctx, "Starting fix loop...", "info");
          await runFixLoop(pi, ctx, request, agentTracker, reviewMessageQueue);
          return;
        }

        const reviewDetails = await prepareFixReviewDetails(pi, ctx, request);
        if (!reviewDetails) return;
        await runFixPassFromReview(
          pi,
          ctx,
          reviewDetails,
          request.additionalContext,
          agentTracker,
          reviewMessageQueue,
        );
      } finally {
        releaseReviewRunLock(sessionKey);
        stopAndFlushReviewQueue(ctx, reviewMessageQueue, stopReviewQueue);
      }
    },
  });
}
