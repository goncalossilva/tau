import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { cloneRuntimeConfig, type PromptMode } from "./config.js";
import {
  withPromptSignal,
  type SandboxEvent,
  type SandboxEventOutcome,
  type SandboxEventReason,
} from "./runtime.js";
import {
  applyFilesystemAllowAction,
  buildFilesystemAllowAction,
  buildFilesystemAllowCommand,
  buildMachLookupAllowCommand,
  classifyFilesystemEventReason,
  describeFilesystemEventSummary,
  describeFilesystemViolationTarget,
  describeMachLookupEventSummary,
  detectFilesystemViolations,
  formatFilesystemViolationSummary,
  formatMachLookupViolationSummary,
  isFilesystemAllowActionAlreadyApplied,
  isMachLookupAlreadyAllowed,
  isTraversalViolation,
  mutateMachLookupAllowList,
  type FilesystemViolation,
  type MachLookupViolation,
} from "./violations.js";

type ViolationResolutionKind = "allow-retry" | "allow-adapt" | "deny";

export type ViolationResolution =
  | {
      kind: "allow-retry";
      message: string;
      retrySuccessMessage: string;
      retryFailureMessage: string;
      retrySkippedMessage: string;
    }
  | { kind: "allow-adapt"; message: string }
  | { kind: "deny"; message: string };

const VIOLATION_ALLOW_RETRY_OPTION = "Allow and retry now";
const VIOLATION_ALLOW_ADAPT_OPTION = "Allow but adapt for side-effects";
const VIOLATION_DENY_OPTION = "Deny";

function getViolationPromptOptions(autoRetryAvailable: boolean): string[] {
  if (!autoRetryAvailable) {
    return [VIOLATION_ALLOW_ADAPT_OPTION, VIOLATION_DENY_OPTION];
  }

  return [VIOLATION_ALLOW_RETRY_OPTION, VIOLATION_ALLOW_ADAPT_OPTION, VIOLATION_DENY_OPTION];
}

function parseViolationPromptSelection(
  selection: string | undefined,
  autoRetryAvailable: boolean,
): ViolationResolutionKind {
  if (selection === VIOLATION_ALLOW_ADAPT_OPTION) return "allow-adapt";
  if (selection === VIOLATION_ALLOW_RETRY_OPTION && autoRetryAvailable) return "allow-retry";
  return "deny";
}

function formatViolationAllowRetryMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nGranting access and retrying the command per user request...\n\n`;
}

function formatViolationAllowAdaptMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session. Retry the command manually if appropriate.`;
}

function formatViolationDeniedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess remains denied for this session.`;
}

function formatViolationAlreadyAllowedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess had already been granted for this session. The remaining failure may be unrelated to sandbox policy.`;
}

function formatViolationRetrySucceededMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session and the command was retried successfully.`;
}

function formatViolationRetryFailedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session and the command was retried per user request, but the command still exited non-zero. The sandbox block was resolved; the remaining failure may be unrelated.`;
}

function formatViolationRetrySkippedMessage(blockedTarget: string): string {
  return `\n${blockedTarget}\n\nAccess granted for this session, but automatic retry was skipped because the timeout was exhausted. Retry the command manually if needed.`;
}

function formatFilesystemBlockedTarget(target: string): string {
  return `Sandbox blocked filesystem ${target}.`;
}

function formatMachLookupBlockedTarget(service: string): string {
  return `Sandbox blocked access to macOS service ${service}.`;
}

export async function handleFilesystemViolation(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  output: string;
  rawOutput: string;
  command: string;
  cwd?: string;
  pendingPrompts?: Map<string, Promise<ViolationResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent?: (event: SandboxEvent) => void;
  autoRetryAvailable?: boolean;
  runtimeProtectedWriteViolations?: FilesystemViolation[];
  allowOutputFallback?: boolean;
}): Promise<ViolationResolution | null> {
  const {
    pi,
    ctx,
    promptMode,
    runtimeConfig,
    output,
    rawOutput,
    command,
    cwd,
    pendingPrompts,
    applyRuntimeConfigForSession,
    recordEvent,
    autoRetryAvailable = true,
    runtimeProtectedWriteViolations = [],
    allowOutputFallback = true,
  } = options;
  const violations = detectFilesystemViolations(output, rawOutput, allowOutputFallback);
  const runtimeProtectedWritePaths = new Set(
    runtimeProtectedWriteViolations.map((violation) => violation.path).filter(Boolean),
  );
  const actionableViolations = violations.filter((violation) => {
    const isRuntimeProtectedWrite =
      violation.kind !== "read" && runtimeProtectedWritePaths.has(violation.path);
    return !isRuntimeProtectedWrite && !isTraversalViolation(runtimeConfig, violation, cwd);
  });
  if (actionableViolations.length === 0) return null;

  const violation =
    actionableViolations.find((candidate) => {
      const candidateAction = buildFilesystemAllowAction(runtimeConfig, candidate, cwd);
      if (!candidateAction) return false;
      return !isFilesystemAllowActionAlreadyApplied(runtimeConfig, candidateAction);
    }) ?? actionableViolations[0];

  const summary = formatFilesystemViolationSummary(violation);
  const target = describeFilesystemViolationTarget(violation);
  const blockedTarget = formatFilesystemBlockedTarget(target);
  const allowAction = buildFilesystemAllowAction(runtimeConfig, violation, cwd);
  const allowCommand = allowAction ? buildFilesystemAllowCommand(allowAction) : null;
  const alreadyApproved = allowAction
    ? isFilesystemAllowActionAlreadyApplied(runtimeConfig, allowAction)
    : false;
  const eventReason = classifyFilesystemEventReason(runtimeConfig, violation, cwd, alreadyApproved);
  const blockedSuggestedCommand = alreadyApproved ? undefined : (allowCommand ?? undefined);

  const recordFilesystemEvent = (outcome: SandboxEventOutcome): void => {
    recordEvent?.({
      timestamp: Date.now(),
      kind: "filesystem",
      outcome,
      reason: eventReason,
      target: violation.path,
      command,
      cwd,
      summary: describeFilesystemEventSummary(eventReason, violation, outcome),
      suggestedCommand: outcome === "blocked" ? blockedSuggestedCommand : undefined,
    });
  };

  if (promptMode === "non-interactive" || !ctx?.hasUI) {
    recordFilesystemEvent("blocked");
    if (!allowCommand) return { kind: "deny", message: summary };
    return {
      kind: "deny",
      message: `${summary}\n[sandbox] To temporarily allow for this session, run: ${allowCommand}`,
    };
  }

  if (!allowAction || !allowCommand) {
    recordFilesystemEvent("blocked");
    return { kind: "deny", message: summary };
  }

  if (alreadyApproved) {
    recordFilesystemEvent("blocked");
    return { kind: "allow-adapt", message: formatViolationAlreadyAllowedMessage(blockedTarget) };
  }

  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  const existingPrompt = pendingPrompts?.get(promptKey);
  if (existingPrompt) return existingPrompt;

  const promptTask: Promise<ViolationResolution | null> = (async () => {
    try {
      const selection = await withPromptSignal(pi, () =>
        ctx.ui.select(
          `Sandbox blocked filesystem ${target}`,
          getViolationPromptOptions(autoRetryAvailable),
        ),
      );
      const decision = parseViolationPromptSelection(selection, autoRetryAvailable);
      if (decision === "deny") {
        recordFilesystemEvent("blocked");
        return { kind: "deny", message: formatViolationDeniedMessage(blockedTarget) };
      }

      const nextConfig = cloneRuntimeConfig(runtimeConfig);
      const changed = applyFilesystemAllowAction(nextConfig, allowAction);
      if (changed) {
        applyRuntimeConfigForSession?.(ctx, nextConfig);
      }

      recordFilesystemEvent("allowed");

      if (decision === "allow-retry") {
        return {
          kind: "allow-retry",
          message: formatViolationAllowRetryMessage(blockedTarget),
          retrySuccessMessage: formatViolationRetrySucceededMessage(blockedTarget),
          retryFailureMessage: formatViolationRetryFailedMessage(blockedTarget),
          retrySkippedMessage: formatViolationRetrySkippedMessage(blockedTarget),
        };
      }

      return {
        kind: "allow-adapt",
        message: changed
          ? formatViolationAllowAdaptMessage(blockedTarget)
          : formatViolationAlreadyAllowedMessage(blockedTarget),
      };
    } catch {
      return null;
    }
  })();

  if (!pendingPrompts) return promptTask;

  pendingPrompts.set(promptKey, promptTask);
  try {
    return await promptTask;
  } finally {
    pendingPrompts.delete(promptKey);
  }
}

export async function handleMachLookupViolation(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  violations: MachLookupViolation[];
  command: string;
  cwd?: string;
  pendingPrompts?: Map<string, Promise<ViolationResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent?: (event: SandboxEvent) => void;
  autoRetryAvailable?: boolean;
}): Promise<ViolationResolution | null> {
  const {
    pi,
    ctx,
    promptMode,
    runtimeConfig,
    violations,
    command,
    cwd,
    pendingPrompts,
    applyRuntimeConfigForSession,
    recordEvent,
    autoRetryAvailable = true,
  } = options;
  if (violations.length === 0) return null;

  const violation =
    violations.find((candidate) => !isMachLookupAlreadyAllowed(runtimeConfig, candidate.service)) ??
    violations[0];
  const { service } = violation;
  const blockedTarget = formatMachLookupBlockedTarget(service);
  const allowCommand = buildMachLookupAllowCommand(service);
  const alreadyApproved = isMachLookupAlreadyAllowed(runtimeConfig, service);
  const eventReason: SandboxEventReason = alreadyApproved
    ? "already-approved-still-failed"
    : "missing-mach-lookup";

  const recordMachLookupEvent = (outcome: SandboxEventOutcome): void => {
    recordEvent?.({
      timestamp: Date.now(),
      kind: "mach-lookup",
      outcome,
      reason: eventReason,
      target: service,
      command,
      cwd,
      summary: describeMachLookupEventSummary(eventReason, outcome),
      suggestedCommand: outcome === "blocked" && !alreadyApproved ? allowCommand : undefined,
    });
  };

  if (promptMode === "non-interactive" || !ctx?.hasUI) {
    recordMachLookupEvent("blocked");
    return {
      kind: "deny",
      message: `${formatMachLookupViolationSummary(service)}\n[sandbox] To temporarily allow for this session, run: ${allowCommand}`,
    };
  }

  if (alreadyApproved) {
    recordMachLookupEvent("blocked");
    return { kind: "allow-adapt", message: formatViolationAlreadyAllowedMessage(blockedTarget) };
  }

  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  const existingPrompt = pendingPrompts?.get(promptKey);
  if (existingPrompt) return existingPrompt;

  const promptTask: Promise<ViolationResolution | null> = (async () => {
    try {
      const selection = await withPromptSignal(pi, () =>
        ctx.ui.select(
          `Sandbox blocked access to macOS service ${service}`,
          getViolationPromptOptions(autoRetryAvailable),
        ),
      );
      const decision = parseViolationPromptSelection(selection, autoRetryAvailable);
      if (decision === "deny") {
        recordMachLookupEvent("blocked");
        return { kind: "deny", message: formatViolationDeniedMessage(blockedTarget) };
      }

      const nextConfig = cloneRuntimeConfig(runtimeConfig);
      const changed = mutateMachLookupAllowList(nextConfig, "add", service);
      if (changed) {
        applyRuntimeConfigForSession?.(ctx, nextConfig);
      }

      recordMachLookupEvent("allowed");

      if (decision === "allow-retry") {
        return {
          kind: "allow-retry",
          message: formatViolationAllowRetryMessage(blockedTarget),
          retrySuccessMessage: formatViolationRetrySucceededMessage(blockedTarget),
          retryFailureMessage: formatViolationRetryFailedMessage(blockedTarget),
          retrySkippedMessage: formatViolationRetrySkippedMessage(blockedTarget),
        };
      }

      return {
        kind: "allow-adapt",
        message: changed
          ? formatViolationAllowAdaptMessage(blockedTarget)
          : formatViolationAlreadyAllowedMessage(blockedTarget),
      };
    } catch {
      return null;
    }
  })();

  if (!pendingPrompts) return promptTask;

  pendingPrompts.set(promptKey, promptTask);
  try {
    return await promptTask;
  } finally {
    pendingPrompts.delete(promptKey);
  }
}
