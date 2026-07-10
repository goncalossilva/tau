import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ChildProcess } from "node:child_process";

import type { ReviewRunOutcome, ReviewRunSource } from "./schema.js";

export const REVIEW_CANCELLED_ERROR = "Review aborted";

export const REVIEW_EVENT_START = "review:start";
export const REVIEW_EVENT_END = "review:end";

export const REVIEW_STATUS_KEY = "0-review";

export const STATUS_SPINNER_INTERVAL_MS = 80;

export const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type ReviewExecutionControl = {
  isCancelled: () => boolean;
  registerProcess: (proc: ChildProcess) => () => void;
};

export type ManagedReviewRun = {
  control: ReviewExecutionControl;
  markSuccessful: () => void;
  markCancelled: () => void;
};

export type AgentEndMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
};

export type AgentEndMessages = AgentEndMessage[];

export type AgentEndState = {
  messages: AgentEndMessages;
};

export type FixPassAgentTracker = {
  waitForNextSettled: () => Promise<void>;
  waitForStartAfter: (lastSeenStartCount: number, timeoutMs: number) => Promise<boolean>;
  getStartCount: () => number;
  getLastEnd: () => AgentEndState | undefined;
};

export type AgentRunTracker = FixPassAgentTracker & {
  handleStart: () => void;
  handleEnd: (state: AgentEndState) => void;
  handleSettled: () => void;
  reset: () => void;
};

const runtimeState = {
  activeReviewRuns: new Set<string>(),
  activeReviewCancels: new Map<string, () => void>(),
  activePromptCount: 0,
};

export async function withManagedReviewRun<T>(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  source: ReviewRunSource,
  run: (managed: ManagedReviewRun) => Promise<T>,
): Promise<T> {
  const sessionKey = getReviewSessionKey(ctx);
  const activeProcesses = new Set<ChildProcess>();
  let cancelRequested = false;
  let outcome: ReviewRunOutcome = "failed";

  const cancelActiveProcesses = () => {
    for (const proc of activeProcesses) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Best effort.
      }
    }
    activeProcesses.clear();
  };

  const requestCancellation = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    cancelActiveProcesses();
  };

  const control: ReviewExecutionControl = {
    isCancelled: () => cancelRequested,
    registerProcess: (proc) => {
      activeProcesses.add(proc);
      return () => {
        activeProcesses.delete(proc);
      };
    },
  };

  pi.events.emit(REVIEW_EVENT_START, { sessionKey, source });
  runtimeState.activeReviewCancels.set(sessionKey, requestCancellation);
  const unsubscribeInterrupt = ctx.hasUI
    ? ctx.ui.onTerminalInput((data) => {
        if (!matchesKey(data, "escape")) return undefined;
        if (runtimeState.activePromptCount > 0) return undefined;
        requestCancellation();
        return { consume: true };
      })
    : undefined;

  try {
    return await run({
      control,
      markSuccessful: () => {
        outcome = "success";
      },
      markCancelled: () => {
        outcome = "cancelled";
      },
    });
  } finally {
    unsubscribeInterrupt?.();
    cancelActiveProcesses();
    if (runtimeState.activeReviewCancels.get(sessionKey) === requestCancellation) {
      runtimeState.activeReviewCancels.delete(sessionKey);
    }
    pi.events.emit(REVIEW_EVENT_END, { sessionKey, source, outcome });
  }
}

export function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
) {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

export function getReviewSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
}

export async function withSpinner<T>(
  ctx: ExtensionContext,
  buildStatusText: () => string,
  run: () => Promise<T>,
): Promise<T> {
  if (!ctx.hasUI) return run();

  let frame = 0;
  const render = () => {
    const spinner = STATUS_SPINNER_FRAMES[frame % STATUS_SPINNER_FRAMES.length];
    ctx.ui.setStatus(REVIEW_STATUS_KEY, `${spinner} ${buildStatusText()}`);
  };

  render();
  const timer = setInterval(() => {
    frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
    render();
  }, STATUS_SPINNER_INTERVAL_MS);

  try {
    return await run();
  } finally {
    clearInterval(timer);
    ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
  }
}

export function acquireReviewRunLock(ctx: ExtensionContext, busyMessage: string): string | null {
  const sessionKey = getReviewSessionKey(ctx);
  if (runtimeState.activeReviewRuns.has(sessionKey)) {
    notify(ctx, busyMessage, "warning");
    return null;
  }

  runtimeState.activeReviewRuns.add(sessionKey);
  return sessionKey;
}

export function releaseReviewRunLock(sessionKey: string): void {
  runtimeState.activeReviewRuns.delete(sessionKey);
}

export function createAgentRunTracker(): AgentRunTracker {
  let resolveNextAgentSettled: (() => void) | undefined;
  let resolveNextAgentStart: (() => void) | undefined;
  let lastAgentEnd: AgentEndState | undefined;
  let agentStartCount = 0;

  function waitForNextSettled(): Promise<void> {
    return new Promise((resolve) => {
      resolveNextAgentSettled = resolve;
    });
  }

  function waitForStartAfter(lastSeenStartCount: number, timeoutMs: number): Promise<boolean> {
    if (agentStartCount > lastSeenStartCount) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let onStart: (() => void) | undefined;

      const finish = (started: boolean) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (resolveNextAgentStart === onStart) resolveNextAgentStart = undefined;
        resolve(started);
      };

      onStart = () => finish(true);
      timeoutId = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      resolveNextAgentStart = onStart;
    });
  }

  return {
    waitForNextSettled,
    waitForStartAfter,
    getStartCount: () => agentStartCount,
    getLastEnd: () => lastAgentEnd,
    handleStart: () => {
      agentStartCount += 1;
      const resolve = resolveNextAgentStart;
      if (!resolve) return;
      resolveNextAgentStart = undefined;
      resolve();
    },
    handleEnd: (state) => {
      lastAgentEnd = state;
    },
    handleSettled: () => {
      const resolve = resolveNextAgentSettled;
      if (!resolve) return;
      resolveNextAgentSettled = undefined;
      resolve();
    },
    reset: () => {
      resolveNextAgentSettled = undefined;
      resolveNextAgentStart = undefined;
      lastAgentEnd = undefined;
      agentStartCount = 0;
    },
  };
}

export function recordPromptStart(): void {
  runtimeState.activePromptCount += 1;
}

export function recordPromptEnd(): void {
  runtimeState.activePromptCount = Math.max(0, runtimeState.activePromptCount - 1);
}

export function handleReviewSessionStart(ctx: ExtensionContext): void {
  runtimeState.activePromptCount = 0;
  const sessionKey = getReviewSessionKey(ctx);
  for (const [key, cancel] of runtimeState.activeReviewCancels) {
    if (key !== sessionKey) cancel();
  }
}

export function handleReviewSessionShutdown(ctx: ExtensionContext): void {
  const sessionKey = getReviewSessionKey(ctx);
  runtimeState.activeReviewCancels.get(sessionKey)?.();
  runtimeState.activeReviewCancels.delete(sessionKey);
  runtimeState.activeReviewRuns.delete(sessionKey);
  runtimeState.activePromptCount = 0;
}
