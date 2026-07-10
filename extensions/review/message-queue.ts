import {
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

import { getReviewSessionKey } from "./runtime.js";

const WIDGET_KEY = "review-message-queue";
const PREVIEW_MAX_LENGTH = 180;

type QueueMode = "steer" | "followUp";
type FlushOptions = { forceFollowUp?: boolean };
type QueuedReviewMessage = {
  mode: QueueMode;
  text: string;
  images?: NonNullable<InputEvent["images"]>;
};
type QueueState = {
  active: boolean;
  messages: QueuedReviewMessage[];
  unsubscribeFollowUpShortcut?: () => void;
};

export type ReviewMessageQueue = ReturnType<typeof createReviewMessageQueue>;

export function createReviewMessageQueue(pi: ExtensionAPI) {
  const states = new Map<string, QueueState>();

  function start(ctx: ExtensionContext): () => void {
    const sessionKey = getReviewSessionKey(ctx);
    const state = getState(sessionKey);
    state.active = true;

    if (ctx.hasUI && !state.unsubscribeFollowUpShortcut) {
      state.unsubscribeFollowUpShortcut = ctx.ui.onTerminalInput((data) => {
        if (!isActive(sessionKey)) return undefined;

        if (matchesConfiguredKey(data, "app.message.dequeue")) {
          return restoreMessagesToEditor(ctx) ? { consume: true } : undefined;
        }

        if (!matchesConfiguredKey(data, "app.message.followUp")) return undefined;

        const text = ctx.ui.getEditorText().trim();
        if (!text) return { consume: true };
        if (isImmediateCommand(text)) return undefined;

        queueMessage(ctx, "followUp", { text });
        ctx.ui.setEditorText("");
        return { consume: true };
      });
    }

    render(ctx);

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      stop(ctx);
    };
  }

  function handleInput(event: InputEvent, ctx: ExtensionContext): boolean {
    const sessionKey = getReviewSessionKey(ctx);
    if (!isActive(sessionKey)) return false;
    if (event.source === "extension") return false;

    // When the main agent is already streaming, Pi's built-in steering/follow-up
    // queues are available. Only provide the review-owned queue while review work
    // is running in the background and the main session is idle.
    if (event.streamingBehavior) return false;
    if (!ctx.isIdle()) return false;
    if (isImmediateCommand(event.text)) return false;
    if (!event.text.trim() && !event.images?.length) return false;

    queueMessage(ctx, "steer", {
      text: event.text,
      images: event.images?.length ? [...event.images] : undefined,
    });
    return true;
  }

  function flushSteering(ctx: ExtensionContext, options: FlushOptions = {}): boolean {
    return flush(ctx, (message) => message.mode === "steer", options);
  }

  function flushAll(ctx: ExtensionContext, options: FlushOptions = {}): boolean {
    return flush(ctx, () => true, options);
  }

  function clear(ctx: ExtensionContext): void {
    const sessionKey = getReviewSessionKey(ctx);
    const state = states.get(sessionKey);
    state?.unsubscribeFollowUpShortcut?.();
    states.delete(sessionKey);
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function stop(ctx: ExtensionContext): void {
    const sessionKey = getReviewSessionKey(ctx);
    const state = states.get(sessionKey);
    if (!state) return;

    state.active = false;
    state.unsubscribeFollowUpShortcut?.();
    state.unsubscribeFollowUpShortcut = undefined;
    render(ctx);
  }

  function queueMessage(
    ctx: ExtensionContext,
    mode: QueueMode,
    message: Omit<QueuedReviewMessage, "mode">,
  ): void {
    const sessionKey = getReviewSessionKey(ctx);
    const state = getState(sessionKey);
    state.messages.push({ mode, ...message });
    render(ctx);
  }

  function restoreMessagesToEditor(ctx: ExtensionContext): boolean {
    const state = states.get(getReviewSessionKey(ctx));
    if (!state?.messages.length) return false;

    const queuedText = state.messages.map((message) => message.text).join("\n\n");
    const currentText = ctx.ui.getEditorText();
    const combinedText = [queuedText, currentText].filter((text) => text.trim()).join("\n\n");
    state.messages = [];
    ctx.ui.setEditorText(combinedText);
    render(ctx);
    return true;
  }

  function flush(
    ctx: ExtensionContext,
    predicate: (message: QueuedReviewMessage) => boolean,
    options: FlushOptions = {},
  ): boolean {
    const sessionKey = getReviewSessionKey(ctx);
    const state = states.get(sessionKey);
    if (!state?.messages.length) return false;

    const selected: QueuedReviewMessage[] = [];
    const remaining: QueuedReviewMessage[] = [];
    for (const message of state.messages) {
      if (predicate(message)) selected.push(message);
      else remaining.push(message);
    }
    if (selected.length === 0) return false;

    state.messages = remaining;
    render(ctx);

    const text = selected
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const images = selected.flatMap((message) => message.images ?? []);
    const content = images.length ? [{ type: "text" as const, text }, ...images] : text;
    const deliveryMode = options.forceFollowUp ? "followUp" : selected[0]?.mode;
    const delivery =
      !options.forceFollowUp && ctx.isIdle() && !ctx.hasPendingMessages()
        ? undefined
        : { deliverAs: deliveryMode ?? "followUp" };
    pi.sendUserMessage(content, delivery);
    return true;
  }

  function getState(sessionKey: string): QueueState {
    let state = states.get(sessionKey);
    if (!state) {
      state = { active: false, messages: [] };
      states.set(sessionKey, state);
    }
    return state;
  }

  function isActive(sessionKey: string): boolean {
    return states.get(sessionKey)?.active ?? false;
  }

  function render(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const messages = states.get(getReviewSessionKey(ctx))?.messages ?? [];
    if (messages.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const lines = messages.map((message) => {
      const label = message.mode === "steer" ? "Steering" : "Follow-up";
      return ctx.ui.theme.fg("dim", `${label}: ${formatPreview(message)}`);
    });
    lines.push(
      ctx.ui.theme.fg(
        "dim",
        `↳ ${appKeyDisplay("app.message.dequeue")} to edit all queued messages`,
      ),
    );
    ctx.ui.setWidget(WIDGET_KEY, lines);
  }

  return {
    start,
    handleInput,
    flushSteering,
    flushAll,
    clear,
  };
}

function matchesConfiguredKey(data: string, keybinding: Parameters<typeof keyText>[0]): boolean {
  return getKeybindings().matches(data, keybinding);
}

function isImmediateCommand(text: string): boolean {
  return text.trimStart().startsWith("!");
}

function appKeyDisplay(keybinding: Parameters<typeof keyText>[0]): string {
  return capitalizeKey(keyText(keybinding));
}

function capitalizeKey(key: string): string {
  return key
    .split("/")
    .map((k) =>
      k
        .split("+")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("+"),
    )
    .join("/");
}

function formatPreview(message: QueuedReviewMessage): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  const truncated =
    text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : text;
  const imageCount = message.images?.length ?? 0;
  if (imageCount === 0) return truncated || "[empty message]";
  const imageLabel = `${imageCount} image${imageCount === 1 ? "" : "s"}`;
  return truncated ? `${truncated} [${imageLabel}]` : `[${imageLabel}]`;
}
