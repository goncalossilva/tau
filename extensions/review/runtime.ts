import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ReviewRunOutcome, ReviewRunSource } from "./schema.js";

export const REVIEW_CANCELLED_ERROR = "Review aborted";

export const REVIEW_EVENT_START = "review:start";
export const REVIEW_EVENT_END = "review:end";

export const REVIEW_PROGRESS_WIDGET_KEY = "review-progress";

export const STATUS_SPINNER_INTERVAL_MS = 80;

export const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

export type ReviewRuntime = ReturnType<typeof createReviewRuntime>;

export function createReviewRuntime(pi: ExtensionAPI) {
  let busy = false;
  let closed = false;
  let promptActive = false;
  let active: { controller: AbortController; completion: Promise<void> } | undefined;

  return {
    get closed() {
      return closed;
    },
    acquire(ctx: ExtensionContext, busyMessage: string): boolean {
      if (closed) return false;
      if (busy) {
        notify(ctx, busyMessage, "warning");
        return false;
      }
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    setPromptActive(value: boolean) {
      promptActive = value;
    },
    async run<T extends { ok: boolean }>(
      ctx: ExtensionCommandContext,
      source: ReviewRunSource,
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<T | { ok: false; error: string }> {
      if (closed) return { ok: false, error: REVIEW_CANCELLED_ERROR };
      const sessionKey = getReviewSessionKey(ctx);
      const controller = new AbortController();
      const { signal } = controller;
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      active = { controller, completion };
      let outcome: ReviewRunOutcome = "failed";
      let started = false;
      let unsubscribeInterrupt: (() => void) | undefined;
      try {
        if (ctx.mode === "tui") {
          unsubscribeInterrupt = ctx.ui.onTerminalInput((data) => {
            if (!matchesKey(data, "escape") || promptActive) return undefined;
            controller.abort();
            return { consume: true };
          });
        }
        started = true;
        pi.events.emit(REVIEW_EVENT_START, { sessionKey, source });
        signal.throwIfAborted();
        const result = await run(signal);
        signal.throwIfAborted();
        outcome = result.ok ? "success" : "failed";
        return result;
      } catch (error) {
        if (!signal.aborted) throw error;
        outcome = "cancelled";
        return { ok: false, error: REVIEW_CANCELLED_ERROR };
      } finally {
        try {
          unsubscribeInterrupt?.();
          controller.abort();
          active = undefined;
          if (started) pi.events.emit(REVIEW_EVENT_END, { sessionKey, source, outcome });
        } finally {
          resolveCompletion();
        }
      }
    },
    async shutdown() {
      closed = true;
      const current = active;
      current?.controller.abort();
      await current?.completion;
    },
  };
}

/** Join every sibling before propagating failure, so cancellation cannot leave background work behind. */
export async function joinAll<T extends readonly unknown[] | []>(
  tasks: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results = await Promise.allSettled(tasks);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }) as { -readonly [P in keyof T]: Awaited<T[P]> };
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
    ctx.ui.setWidget(REVIEW_PROGRESS_WIDGET_KEY, [`${spinner} ${buildStatusText()}`], {
      placement: "aboveEditor",
    });
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
    ctx.ui.setWidget(REVIEW_PROGRESS_WIDGET_KEY, undefined);
  }
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
