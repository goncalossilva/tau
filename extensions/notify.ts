/**
 * Pi Notify Extension
 *
 * Sends native terminal notifications when Pi is waiting for input.
 * - Agent finished and ready for the next prompt
 * - Extension prompt is waiting for a question/confirmation answer
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const REVIEW_EVENT_START = "review:start";
const REVIEW_EVENT_END = "review:end";

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
  const { execFile } = require("child_process");
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else {
    notifyOSC777(title, body);
  }
}

function getPromptSource(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const source = (event as Record<string, unknown>).source;
  if (typeof source !== "string") return undefined;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function extractReviewOutcome(data: unknown): "success" | "failed" | "cancelled" | undefined {
  if (!data || typeof data !== "object") return undefined;
  const payload = data as { outcome?: unknown };
  if (
    payload.outcome === "success" ||
    payload.outcome === "failed" ||
    payload.outcome === "cancelled"
  ) {
    return payload.outcome;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let pendingPromptCount = 0;
  const activeReviewSessions = new Set<string>();
  let currentSessionKey: string | undefined;

  const hasCurrentSessionReviewRun = () => {
    if (!currentSessionKey) return false;
    return activeReviewSessions.has(currentSessionKey);
  };

  pi.on("session_start", async (_event, ctx) => {
    currentSessionKey = getSessionKey(ctx);
  });

  pi.events.on("ui:prompt_start", (data) => {
    const wasIdle = pendingPromptCount === 0;
    pendingPromptCount += 1;

    if (!wasIdle) return;
    const source = getPromptSource(data);
    notify("Pi", source ? `Question pending (${source})` : "Question pending");
  });

  pi.events.on("ui:prompt_end", () => {
    if (pendingPromptCount === 0) return;
    pendingPromptCount -= 1;
  });

  pi.events.on(REVIEW_EVENT_START, (data) => {
    const sessionKey = extractReviewSessionKey(data);
    if (!sessionKey) return;
    activeReviewSessions.add(sessionKey);
  });

  pi.events.on(REVIEW_EVENT_END, (data) => {
    const sessionKey = extractReviewSessionKey(data);
    if (!sessionKey) return;

    activeReviewSessions.delete(sessionKey);

    if (pendingPromptCount > 0) return;
    if (!currentSessionKey || sessionKey !== currentSessionKey) return;

    const outcome = extractReviewOutcome(data);
    if (outcome === "success") {
      notify("Pi", "Review completed");
      return;
    }
    if (outcome === "cancelled") {
      notify("Pi", "Review cancelled");
      return;
    }
    notify("Pi", "Review failed");
  });

  pi.on("agent_end", async (_event, ctx) => {
    currentSessionKey = getSessionKey(ctx);
    if (pendingPromptCount > 0) return;
    if (hasCurrentSessionReviewRun()) return;
    notify("Pi", "Ready for input");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    pendingPromptCount = 0;
    const sessionKey = getSessionKey(ctx);
    activeReviewSessions.delete(sessionKey);
    if (currentSessionKey === sessionKey) {
      currentSessionKey = undefined;
    }
  });
}
