import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PromptStatus = "completed" | "error";

type PermissionDecision = "allow-retry" | "allow-adapt" | "deny";

export type PermissionResolution =
  | {
      kind: "allow-retry";
      message: string;
      retrySuccessMessage: string;
      retryFailureMessage: string;
      retrySkippedMessage: string;
    }
  | { kind: "allow-adapt"; message: string }
  | { kind: "deny"; message: string };

const ALLOW_RETRY_OPTION = "Allow and retry now";
const ALLOW_ADAPT_OPTION = "Allow but adapt for side-effects";
const DENY_OPTION = "Deny";

export async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
  pi.events.emit("ui:prompt_start", { source: "sandbox" });

  let status: PromptStatus = "completed";
  try {
    return await run();
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    pi.events.emit("ui:prompt_end", { source: "sandbox", status });
  }
}

export async function showPermissionDialog<T>(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  title: string;
  promptKey: string;
  pendingDialogs?: Map<string, Promise<T | null>>;
  autoRetryAvailable: boolean;
  onDecision: (decision: PermissionDecision) => T | Promise<T>;
}): Promise<T | null> {
  const { pi, ctx, title, promptKey, pendingDialogs, autoRetryAvailable, onDecision } = options;
  if (!ctx.hasUI) return null;

  const existingDialog = pendingDialogs?.get(promptKey);
  if (existingDialog) return existingDialog;

  const dialogTask: Promise<T | null> = (async () => {
    try {
      const selection = await withPromptSignal(pi, () =>
        ctx.ui.select(title, getPermissionDialogOptions(autoRetryAvailable)),
      );
      return await onDecision(parsePermissionDialogSelection(selection, autoRetryAvailable));
    } catch {
      return null;
    }
  })();

  if (!pendingDialogs) return dialogTask;

  pendingDialogs.set(promptKey, dialogTask);
  try {
    return await dialogTask;
  } finally {
    pendingDialogs.delete(promptKey);
  }
}

export function createPermissionResolution(
  decision: PermissionDecision,
  blockedTarget: string,
  changed = true,
): PermissionResolution {
  if (decision === "deny") {
    return { kind: "deny", message: formatDeniedMessage(blockedTarget) };
  }

  if (decision === "allow-retry") {
    return {
      kind: "allow-retry",
      message: formatAllowRetryMessage(blockedTarget),
      retrySuccessMessage: formatRetrySucceededMessage(blockedTarget),
      retryFailureMessage: formatRetryFailedMessage(blockedTarget),
      retrySkippedMessage: formatRetrySkippedMessage(blockedTarget),
    };
  }

  return {
    kind: "allow-adapt",
    message: changed
      ? formatAllowAdaptMessage(blockedTarget)
      : formatAlreadyAllowedMessage(blockedTarget),
  };
}

function getPermissionDialogOptions(autoRetryAvailable: boolean): string[] {
  if (!autoRetryAvailable) return [ALLOW_ADAPT_OPTION, DENY_OPTION];
  return [ALLOW_RETRY_OPTION, ALLOW_ADAPT_OPTION, DENY_OPTION];
}

function parsePermissionDialogSelection(
  selection: string | undefined,
  autoRetryAvailable: boolean,
): PermissionDecision {
  if (selection === ALLOW_ADAPT_OPTION) return "allow-adapt";
  if (selection === ALLOW_RETRY_OPTION && autoRetryAvailable) return "allow-retry";
  return "deny";
}

function formatAllowRetryMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nGranting access and retrying the command per user request...\n\n`;
}

function formatAllowAdaptMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session. Retry the command manually if appropriate.`;
}

function formatDeniedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess remains denied for this session.`;
}

function formatAlreadyAllowedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess had already been granted for this session. The remaining failure may be unrelated to sandbox policy.`;
}

function formatRetrySucceededMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session and the command was retried successfully.`;
}

function formatRetryFailedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session and the command was retried per user request, but the command still exited non-zero. The sandbox block was resolved; the remaining failure may be unrelated.`;
}

function formatRetrySkippedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session, but automatic retry was skipped because the timeout was exhausted. Retry the command manually if needed.`;
}
