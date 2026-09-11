/**
 * Ghostty terminal title integration.
 *
 * - Shows project/session in the terminal title
 * - Shows a braille spinner in the title while the agent is working
 * - Shows the braille spinner backwards while context is compacting
 * - Shows a ? marker while an extension prompt is waiting for input
 * - Updates title with the current tool name during tool execution
 * - Includes background Review and Subagent work via their session-scoped lifecycle events
 *
 * Pi now emits native OSC 9;4 progress indicators, so this extension only manages the title.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function (pi: ExtensionAPI) {
  let sessionName: string | undefined;
  let sessionCwd: string | undefined;
  const activeTools = new Map<string, string>();
  let isWorking = false;
  let isCompacting = false;
  let frameIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let promptPending = false;
  let latestCtx: ExtensionContext | undefined;
  let currentSessionKey: string | undefined;
  const activeBackgroundSessions = new Map([
    ["review", new Set<string>()],
    ["subagent", new Set<string>()],
  ]);

  function buildTitle(extra?: string, marker = "π"): string {
    const cwd = sessionCwd ?? process.cwd();
    const segments: string[] = [marker, path.basename(cwd)];
    if (sessionName) segments.push(sessionName);
    if (extra) segments.push(extra);
    return segments.join(" · ");
  }

  function clearSpinnerTimer(): void {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  function currentFrame(): string {
    return STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length];
  }

  function resetFrame(): void {
    frameIndex = 0;
  }

  function advanceFrame(): void {
    const step = isCompacting ? -1 : 1;
    frameIndex = (frameIndex + step + STATUS_SPINNER_FRAMES.length) % STATUS_SPINNER_FRAMES.length;
  }

  function hasPendingPrompts(): boolean {
    return promptPending;
  }

  function getActiveBackgroundRun(): string | undefined {
    for (const [kind, sessions] of activeBackgroundSessions) {
      if (currentSessionKey && sessions.has(currentSessionKey)) return kind;
    }
    return undefined;
  }

  function isBusy(): boolean {
    return isWorking || isCompacting || getActiveBackgroundRun() !== undefined;
  }

  function getWorkingExtra(): string | undefined {
    const currentTool = [...activeTools.values()].at(-1);
    if (currentTool) return currentTool;
    if (isCompacting) return "compacting";
    if (!isWorking) return getActiveBackgroundRun();
    return undefined;
  }

  function renderWorkingTitle(ctx: ExtensionContext): void {
    ctx.ui.setTitle(buildTitle(getWorkingExtra(), currentFrame()));
  }

  function renderPromptTitle(ctx: ExtensionContext): void {
    const extra = isBusy() ? getWorkingExtra() : undefined;
    ctx.ui.setTitle(buildTitle(extra, "?"));
  }

  function renderActiveTitle(ctx: ExtensionContext): void {
    if (hasPendingPrompts()) {
      renderPromptTitle(ctx);
      return;
    }

    if (isBusy()) {
      renderWorkingTitle(ctx);
      return;
    }

    ctx.ui.setTitle(buildTitle());
  }

  function startSpinnerTimer(ctx: ExtensionContext): void {
    clearSpinnerTimer();
    spinnerTimer = setInterval(() => {
      if (!isBusy() || hasPendingPrompts()) return;
      advanceFrame();
      renderWorkingTitle(ctx);
    }, STATUS_SPINNER_INTERVAL_MS);
  }

  function startSpinner(ctx: ExtensionContext): void {
    clearSpinnerTimer();
    isWorking = true;
    activeTools.clear();
    resetFrame();
    renderActiveTitle(ctx);

    if (!hasPendingPrompts()) {
      startSpinnerTimer(ctx);
    }
  }

  function stopSpinner(ctx: ExtensionContext): void {
    isWorking = false;
    activeTools.clear();
    clearSpinnerTimer();

    if (hasPendingPrompts()) {
      renderActiveTitle(ctx);
      return;
    }

    if (isBusy()) {
      renderWorkingTitle(ctx);
      startSpinnerTimer(ctx);
      return;
    }

    renderActiveTitle(ctx);
  }

  function handlePromptStart(ctx: ExtensionContext): void {
    clearSpinnerTimer();
    renderActiveTitle(ctx);
  }

  function handlePromptEnd(ctx: ExtensionContext): void {
    if (hasPendingPrompts()) {
      renderActiveTitle(ctx);
      return;
    }

    if (isBusy()) {
      renderWorkingTitle(ctx);
      startSpinnerTimer(ctx);
      return;
    }

    renderActiveTitle(ctx);
  }

  function startCompaction(ctx: ExtensionContext, signal: AbortSignal): void {
    isCompacting = true;
    activeTools.clear();
    resetFrame();
    signal.addEventListener("abort", () => stopCompaction(ctx), { once: true });

    renderActiveTitle(ctx);
    if (!hasPendingPrompts()) {
      startSpinnerTimer(ctx);
    }
  }

  function stopCompaction(ctx: ExtensionContext, options?: { render?: boolean }): void {
    if (!isCompacting) return;

    isCompacting = false;

    if (options?.render === false) return;

    if (isBusy()) {
      renderActiveTitle(ctx);
      if (!hasPendingPrompts()) {
        startSpinnerTimer(ctx);
      }
      return;
    }

    clearSpinnerTimer();
    renderActiveTitle(ctx);
  }

  function syncSessionTitle(ctx: ExtensionContext): void {
    renderActiveTitle(ctx);
  }

  function handleBackgroundStart(ctx: ExtensionContext): void {
    renderActiveTitle(ctx);
    if (!hasPendingPrompts()) {
      startSpinnerTimer(ctx);
    }
  }

  function handleBackgroundEnd(ctx: ExtensionContext): void {
    if (hasPendingPrompts()) {
      renderActiveTitle(ctx);
      return;
    }

    if (isBusy()) {
      renderActiveTitle(ctx);
      startSpinnerTimer(ctx);
      return;
    }

    clearSpinnerTimer();
    renderActiveTitle(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    currentSessionKey = getSessionKey(ctx);
    sessionCwd = ctx.cwd;
    sessionName = pi.getSessionName();
    syncSessionTitle(ctx);
    clearSpinnerTimer();
    if (isBusy() && !hasPendingPrompts()) {
      startSpinnerTimer(ctx);
    }
  });

  pi.on("session_info_changed", (event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    sessionName = event.name;
    renderActiveTitle(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    stopCompaction(ctx, { render: false });
    startSpinner(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    stopSpinner(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    activeTools.set(event.toolCallId, event.toolName);
    latestCtx = ctx;
    if (!isWorking) return;
    renderActiveTitle(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    activeTools.delete(event.toolCallId);
    latestCtx = ctx;
    if (!isWorking) return;
    renderActiveTitle(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    startCompaction(ctx, event.signal);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    stopCompaction(ctx);
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    stopCompaction(ctx);
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    promptPending = true;
    latestCtx = ctx;
    if (!ctx.hasUI) return;
    handlePromptStart(ctx);
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    promptPending = false;
    latestCtx = ctx;
    if (!ctx.hasUI) return;
    handlePromptEnd(ctx);
  });

  for (const [kind, sessions] of activeBackgroundSessions) {
    pi.events.on(`${kind}:start`, (data) => {
      const sessionKey = extractSessionKey(data);
      if (!sessionKey) return;
      sessions.add(sessionKey);

      const ctx = latestCtx;
      if (!ctx || !ctx.hasUI || currentSessionKey !== sessionKey) return;
      handleBackgroundStart(ctx);
    });

    pi.events.on(`${kind}:end`, (data) => {
      const sessionKey = extractSessionKey(data);
      if (!sessionKey) return;
      sessions.delete(sessionKey);

      const ctx = latestCtx;
      if (!ctx || !ctx.hasUI || currentSessionKey !== sessionKey) return;
      handleBackgroundEnd(ctx);
    });
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    clearSpinnerTimer();
    isWorking = false;
    isCompacting = false;
    activeTools.clear();
    promptPending = false;
    const sessionKey = getSessionKey(ctx);
    for (const sessions of activeBackgroundSessions.values()) sessions.delete(sessionKey);
    if (currentSessionKey === sessionKey) {
      currentSessionKey = undefined;
      sessionCwd = undefined;
      sessionName = undefined;
    }
    latestCtx = undefined;
  });
}

function getSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
}

function extractSessionKey(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const payload = data as { sessionKey?: unknown };
  if (typeof payload.sessionKey !== "string") return undefined;
  const sessionKey = payload.sessionKey.trim();
  return sessionKey.length > 0 ? sessionKey : undefined;
}
