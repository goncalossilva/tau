import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKeyRelease,
  type TuiMainScreen,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

interface InterruptRequest {
  sessionKey: string;
  cancel?: boolean;
  active: boolean;
  confirming?: boolean;
}

/** Each extension owns its guard; optional peers contribute work through the event bus. */
export function createInterruptGuard(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tui: TUI & Partial<Pick<TuiMainScreen, "getFocusedComponent">>,
  isWorking: () => boolean,
  cancel: () => void,
  isPromptActive: () => boolean,
) {
  const sessionKey =
    ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
  let closed = false;
  let pending:
    | { controller: AbortController; editor: Component; completion: Promise<void> }
    | undefined;
  const unsubscribeWork = pi.events.on("tau:interrupt", (data) => {
    const request = data as InterruptRequest;
    if (request.sessionKey !== sessionKey || closed) return;
    if (pending) request.confirming = true;
    if (!isWorking()) return;
    request.active = true;
    if (request.cancel) cancel();
  });
  const unsubscribeChanged = pi.events.on("tau:work-changed", (data) => {
    if ((data as { sessionKey: string }).sessionKey === sessionKey && pending && !hasWork())
      pending.controller.abort();
  });
  const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
    if (isKeyRelease(data) || !getKeybindings().matches(data, "app.interrupt")) return;
    const editor = tui.getFocusedComponent?.();
    // A dismissed native dialog restores focus before its promise settles. Swallow a rapid
    // extra Escape in that gap instead of accidentally interrupting the parent.
    if (pending) return editor === pending.editor ? { consume: true } : undefined;
    if (
      closed ||
      isPromptActive() ||
      !editor ||
      !("getText" in editor) ||
      !("setText" in editor) ||
      ("isShowingAutocomplete" in editor &&
        typeof editor.isShowingAutocomplete === "function" &&
        editor.isShowingAutocomplete()) ||
      !hasWork()
    )
      return;
    const current = {
      controller: new AbortController(),
      editor,
      completion: Promise.resolve(),
    };
    pending = current;
    current.completion = (async () => {
      try {
        const request: {
          run: (signal: AbortSignal) => Promise<void>;
          signal: AbortSignal;
          result?: Promise<unknown>;
        } = {
          signal: current.controller.signal,
          async run(signal) {
            const confirmed = await ctx.ui.confirm("Cancel all ongoing work?", "", { signal });
            if (!confirmed || closed || signal.aborted || !hasWork()) return;
            pi.events.emit("tau:interrupt", { sessionKey, active: false, cancel: true });
            // Reuse the editor's native interrupt, including queue restoration, Bash and retries.
            editor.handleInput?.(data);
          },
        };
        // Keep queued approvals blocked until the confirmed cancellation has been applied.
        pi.events.emit("subagent:permission", request);
        await (request.result ?? request.run(request.signal));
      } catch (error) {
        if (!closed && !current.controller.signal.aborted)
          ctx.ui.notify(`Could not confirm cancellation: ${String(error)}`, "warning");
      } finally {
        if (pending === current) pending = undefined;
      }
    })();
    return { consume: true };
  });

  return {
    refresh() {
      if (!closed) pi.events.emit("tau:work-changed", { sessionKey });
    },
    async dispose() {
      closed = true;
      unsubscribeInput();
      unsubscribeWork();
      unsubscribeChanged();
      pending?.controller.abort();
      pi.events.emit("tau:work-changed", { sessionKey });
      await pending?.completion;
    },
  };

  function hasWork(): boolean {
    const request: InterruptRequest = { sessionKey, active: false };
    pi.events.emit("tau:interrupt", request);
    return request.active;
  }
}
