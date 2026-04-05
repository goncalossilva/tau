/**
 * Ghostty terminal title + progress integration.
 *
 * - Shows project/session in the terminal title
 * - Shows a braille spinner in the title while the agent is working
 * - Shows a ? marker while an extension prompt is waiting for input
 * - Updates title with the current tool name during tool execution
 * - Pulses Ghostty's native progress bar while working
 * - Treats background /review runs as working state via review:start/review:end events
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "node:fs";
import path from "node:path";

const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMPLETION_FLASH_MS = 800;
const REVIEW_EVENT_START = "review:start";
const REVIEW_EVENT_END = "review:end";

let sessionName: string | undefined;
let currentTool: string | undefined;
let isWorking = false;
let frameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPromptCount = 0;
let latestCtx: ExtensionContext | undefined;
let currentSessionKey: string | undefined;
const activeReviewSessions = new Set<string>();

function ghosttyWrite(seq: string): void {
  try {
    writeFileSync("/dev/tty", seq);
  } catch {
    // /dev/tty may be unavailable (e.g. subagent context)
  }
}

function setProgress(state: number, value?: number): void {
  const args = value !== undefined ? `${state};${value}` : `${state}`;
  ghosttyWrite(`\x1b]9;4;${args}\x07`);
}

function buildTitle(extra?: string, marker = "π"): string {
  const segments: string[] = [marker, path.basename(process.cwd())];
  if (sessionName) segments.push(sessionName);
  if (extra) segments.push(extra);
  return segments.join(" · ");
}

function clearSpinnerTimer(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = undefined;
}

function clearCompletionTimer(): void {
  if (!completionTimer) return;
  clearTimeout(completionTimer);
  completionTimer = undefined;
}

function currentFrame(): string {
  return STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length];
}

function hasPendingPrompts(): boolean {
  return pendingPromptCount > 0;
}

function getSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
}

function extractReviewSessionKey(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const payload = data as { sessionKey?: unknown };
  if (typeof payload.sessionKey !== "string") return undefined;
  const sessionKey = payload.sessionKey.trim();
  return sessionKey.length > 0 ? sessionKey : undefined;
}

function hasActiveReviewRuns(): boolean {
  if (!currentSessionKey) return false;
  return activeReviewSessions.has(currentSessionKey);
}

function isBusy(): boolean {
  return isWorking || hasActiveReviewRuns();
}

function getWorkingExtra(): string | undefined {
  if (currentTool) return currentTool;
  if (!isWorking && hasActiveReviewRuns()) return "review";
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
    frameIndex = (frameIndex + 1) % STATUS_SPINNER_FRAMES.length;
    renderWorkingTitle(ctx);
  }, STATUS_SPINNER_INTERVAL_MS);
}

function startSpinner(ctx: ExtensionContext): void {
  clearSpinnerTimer();
  clearCompletionTimer();

  isWorking = true;
  currentTool = undefined;
  frameIndex = 0;

  setProgress(hasPendingPrompts() ? 0 : 3);
  renderActiveTitle(ctx);

  if (!hasPendingPrompts()) {
    startSpinnerTimer(ctx);
  }
}

function renderCompletionFlash(ctx: ExtensionContext): void {
  clearSpinnerTimer();
  setProgress(1, 100);
  ctx.ui.setTitle(buildTitle());

  clearCompletionTimer();
  completionTimer = setTimeout(() => {
    setProgress(0);
    completionTimer = undefined;
  }, COMPLETION_FLASH_MS);
}

function stopSpinner(ctx: ExtensionContext): void {
  isWorking = false;
  currentTool = undefined;
  clearSpinnerTimer();

  if (hasPendingPrompts()) {
    setProgress(0);
    renderActiveTitle(ctx);
    return;
  }

  if (hasActiveReviewRuns()) {
    setProgress(3);
    renderWorkingTitle(ctx);
    startSpinnerTimer(ctx);
    return;
  }

  renderCompletionFlash(ctx);
}

function handlePromptStart(ctx: ExtensionContext): void {
  clearCompletionTimer();
  clearSpinnerTimer();
  setProgress(0);
  renderActiveTitle(ctx);
}

function handlePromptEnd(ctx: ExtensionContext): void {
  if (hasPendingPrompts()) {
    renderActiveTitle(ctx);
    return;
  }

  clearCompletionTimer();

  if (isBusy()) {
    setProgress(3);
    renderWorkingTitle(ctx);
    startSpinnerTimer(ctx);
    return;
  }

  renderActiveTitle(ctx);
}

function syncSessionTitle(ctx: ExtensionContext): void {
  renderActiveTitle(ctx);
}

function markReviewSessionActive(sessionKey: string): void {
  activeReviewSessions.add(sessionKey);
}

function markReviewSessionInactive(sessionKey: string): void {
  activeReviewSessions.delete(sessionKey);
}

function handleReviewStart(ctx: ExtensionContext): void {
  clearCompletionTimer();
  setProgress(hasPendingPrompts() ? 0 : 3);
  renderActiveTitle(ctx);
  if (!hasPendingPrompts()) {
    startSpinnerTimer(ctx);
  }
}

function handleReviewEnd(ctx: ExtensionContext): void {
  if (isWorking) {
    renderActiveTitle(ctx);
    return;
  }

  if (hasPendingPrompts()) {
    setProgress(0);
    renderActiveTitle(ctx);
    return;
  }

  if (hasActiveReviewRuns()) {
    setProgress(3);
    renderActiveTitle(ctx);
    startSpinnerTimer(ctx);
    return;
  }

  renderCompletionFlash(ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    currentSessionKey = getSessionKey(ctx);
    sessionName = pi.getSessionName();
    syncSessionTitle(ctx);
    clearSpinnerTimer();
    if (isBusy() && !hasPendingPrompts()) {
      startSpinnerTimer(ctx);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    startSpinner(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    stopSpinner(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    currentTool = event.toolName;
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    if (!isWorking) return;
    renderActiveTitle(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    currentTool = undefined;
    if (!ctx.hasUI) return;
    latestCtx = ctx;
    if (!isWorking) return;
    renderActiveTitle(ctx);
  });

  pi.events.on("ui:prompt_start", () => {
    pendingPromptCount += 1;

    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    handlePromptStart(ctx);
  });

  pi.events.on("ui:prompt_end", () => {
    if (pendingPromptCount === 0) return;
    pendingPromptCount -= 1;

    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    handlePromptEnd(ctx);
  });

  pi.events.on(REVIEW_EVENT_START, (data) => {
    const sessionKey = extractReviewSessionKey(data);
    if (!sessionKey) return;

    markReviewSessionActive(sessionKey);

    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    if (currentSessionKey !== sessionKey) return;
    handleReviewStart(ctx);
  });

  pi.events.on(REVIEW_EVENT_END, (data) => {
    const sessionKey = extractReviewSessionKey(data);
    if (!sessionKey) return;

    markReviewSessionInactive(sessionKey);

    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    if (currentSessionKey !== sessionKey) return;
    handleReviewEnd(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearSpinnerTimer();
    clearCompletionTimer();
    isWorking = false;
    currentTool = undefined;
    pendingPromptCount = 0;
    const sessionKey = getSessionKey(ctx);
    activeReviewSessions.delete(sessionKey);
    if (currentSessionKey === sessionKey) {
      currentSessionKey = undefined;
    }
    latestCtx = undefined;
    setProgress(0);
  });
}
