import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { ReviewMessageQueue } from "./message-queue.js";
import { buildAdditionalContextSection, FIX_PROMPT } from "./prompts.js";
import { reviewMatchesFixRequest } from "./request.js";
import { computeCurrentFingerprint, fingerprintsEqual } from "./git.js";
import {
  buildStalePayloadStaleness,
  getLastMessageReviewDetails,
  runReviewPipeline,
} from "./review.js";
import {
  notify,
  REVIEW_CANCELLED_ERROR,
  type AgentEndMessage,
  type AgentEndMessages,
  type FixPassAgentTracker,
} from "./runtime.js";
import type { ParsedRequest, ReviewMessageDetails } from "./schema.js";

const FIX_PASS_START_GRACE_MS = 1_000;

const REVIEW_STALE_REUSE_WARNING =
  "Last review is stale. Continuing with /fix. Run /review first to refresh it.";

function buildFixPrompt(
  reviewMessageDetails: ReviewMessageDetails,
  additionalContext: string | undefined,
): string {
  const worklistPayload = JSON.stringify(
    {
      scope: reviewMessageDetails.scope,
      ...(reviewMessageDetails.staleness ? { staleness: reviewMessageDetails.staleness } : {}),
      findings: reviewMessageDetails.findings.map(
        ({ priority, location, finding, suggestion, focus }) => ({
          priority,
          location,
          finding,
          suggestion,
          focus,
        }),
      ),
    },
    null,
    2,
  );
  const additionalContextSection = buildAdditionalContextSection(additionalContext);

  return FIX_PROMPT.replace(
    "{FIX_ADDITIONAL_CONTEXT_SECTION}",
    () => additionalContextSection,
  ).replace("{REVIEW_FINDINGS_JSON}", () => worklistPayload);
}

export async function prepareFixReviewDetails(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  request: ParsedRequest,
  forceFreshReview = false,
): Promise<ReviewMessageDetails | null> {
  let reviewDetails = forceFreshReview ? null : getLastMessageReviewDetails(ctx);

  if (reviewDetails && reviewMatchesFixRequest(reviewDetails, request)) {
    const currentFingerprint = await computeCurrentFingerprint(
      pi,
      ctx.cwd,
      reviewDetails.scope.mode === "working-tree" || reviewDetails.scope.mode === "folder",
    );
    const hasStalePayload = reviewDetails.staleness?.status === "stale";
    const isStaleNow = !fingerprintsEqual(reviewDetails.fingerprint, currentFingerprint);
    if (hasStalePayload || isStaleNow) {
      reviewDetails = {
        ...reviewDetails,
        staleness: reviewDetails.staleness ?? buildStalePayloadStaleness(),
      };
      notify(ctx, REVIEW_STALE_REUSE_WARNING, "warning");
    }
  } else {
    const reviewResult = await runReviewPipeline(pi, ctx, request, "fix");
    if (!reviewResult.ok) {
      if (reviewResult.error === REVIEW_CANCELLED_ERROR) {
        notify(ctx, REVIEW_CANCELLED_ERROR, "error");
      } else {
        notify(ctx, `Cannot continue to /fix: ${reviewResult.error}`, "error");
      }
      return null;
    }
    reviewDetails = reviewResult.details;
    if (reviewDetails.staleness?.status === "stale") {
      notify(ctx, reviewDetails.staleness.nextStep, "warning");
      return null;
    }
  }

  if (reviewDetails.findings.length === 0) {
    const failedFocusCount = countFailedFocusRuns(reviewDetails);
    if (failedFocusCount > 0) {
      notify(
        ctx,
        `Latest partial review had ${failedFocusCount} failed focus run(s) and no findings. Rerun /review before /fix.`,
        "warning",
      );
      return null;
    }

    notify(ctx, "Review produced no findings. Nothing to fix.", "info");
    return null;
  }

  return reviewDetails;
}

function countFailedFocusRuns(reviewDetails: ReviewMessageDetails): number {
  return reviewDetails.focusStatus.filter((focus) => !focus.ok).length;
}

function notifyFixUsedPartialReview(ctx: ExtensionContext, failedFocusCount: number): void {
  if (failedFocusCount === 0) return;
  const failedLabel = `review${failedFocusCount === 1 ? "" : "s"}`;
  notify(
    ctx,
    `Fix pass used partial review results: ${failedFocusCount} ${failedLabel} failed.`,
    "warning",
  );
}

function queueFixPass(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reviewDetails: ReviewMessageDetails,
  additionalContext: string | undefined,
  options: { forceFollowUp?: boolean } = {},
): { startsImmediately: boolean } {
  const fixPrompt = buildFixPrompt(reviewDetails, additionalContext);
  const startsImmediately = ctx.isIdle();
  const delivery =
    options.forceFollowUp || !startsImmediately || ctx.hasPendingMessages()
      ? { deliverAs: "followUp" as const }
      : undefined;
  pi.sendUserMessage(fixPrompt, delivery);
  notify(ctx, "Queued autonomous fix pass from review findings.", "info");
  return { startsImmediately };
}

function getLastAssistantMessage(messages: AgentEndMessages): AgentEndMessage | undefined {
  return messages.findLast((message) => message?.role === "assistant");
}

function wasLastAssistantAborted(messages: AgentEndMessages): boolean {
  return getLastAssistantMessage(messages)?.stopReason === "aborted";
}

async function waitForPromptStartIfImmediate(
  agentTracker: FixPassAgentTracker,
  startCountBeforePrompt: number,
  startsImmediately: boolean,
): Promise<void> {
  if (!startsImmediately) return;
  await agentTracker.waitForStartAfter(startCountBeforePrompt, FIX_PASS_START_GRACE_MS);
}

async function waitForFixPassCompletion(
  agentTracker: FixPassAgentTracker,
): Promise<AgentEndMessages> {
  await agentTracker.waitForNextSettled();
  return agentTracker.getLastEnd()?.messages ?? [];
}

export async function runFixPassFromReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reviewDetails: ReviewMessageDetails,
  additionalContext: string | undefined,
  agentTracker: FixPassAgentTracker,
  reviewMessageQueue: ReviewMessageQueue,
): Promise<AgentEndMessages> {
  const failedFocusCount = countFailedFocusRuns(reviewDetails);
  const fixPassFinished = waitForFixPassCompletion(agentTracker);

  const startCountBeforeSteering = agentTracker.getStartCount();
  const steeringStartsImmediately = ctx.isIdle();
  const sentSteering = reviewMessageQueue.flushSteering(ctx, { forceFollowUp: true });
  await waitForPromptStartIfImmediate(
    agentTracker,
    startCountBeforeSteering,
    sentSteering && steeringStartsImmediately,
  );

  const startCountBeforeFix = agentTracker.getStartCount();
  const fixPass = queueFixPass(pi, ctx, reviewDetails, additionalContext, {
    forceFollowUp: sentSteering,
  });
  await waitForPromptStartIfImmediate(agentTracker, startCountBeforeFix, fixPass.startsImmediately);

  const fixMessages = await fixPassFinished;
  if (!wasLastAssistantAborted(fixMessages)) {
    notifyFixUsedPartialReview(ctx, failedFocusCount);
  }
  return fixMessages;
}

export async function runFixLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  request: ParsedRequest,
  agentTracker: FixPassAgentTracker,
  reviewMessageQueue: ReviewMessageQueue,
): Promise<void> {
  for (;;) {
    const reviewDetails = await prepareFixReviewDetails(pi, ctx, request, true);
    if (!reviewDetails) return;

    const beforeFixFingerprint = reviewDetails.fingerprint;
    const fixMessages = await runFixPassFromReview(
      pi,
      ctx,
      reviewDetails,
      request.additionalContext,
      agentTracker,
      reviewMessageQueue,
    );
    if (wasLastAssistantAborted(fixMessages)) {
      notify(ctx, "Fix loop stopped: fix pass was aborted.", "warning");
      return;
    }

    const afterFixFingerprint = await computeCurrentFingerprint(pi, ctx.cwd, true);
    if (fingerprintsEqual(beforeFixFingerprint, afterFixFingerprint)) {
      notify(ctx, "Fix loop stopped: fix pass made no repository changes.", "warning");
      return;
    }

    notify(ctx, "Fix loop continuing with a fresh review...", "info");
  }
}
