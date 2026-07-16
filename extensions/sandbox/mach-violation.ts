import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ListOp,
  PromptMode,
  SandboxEventBase,
  ViolationResolution,
  ViolationResolutionKind,
} from "./types.js";

export interface MachLookupViolation {
  service: string;
}

export type MachLookupListOp = ListOp;
export type MachPromptDecision = ViolationResolutionKind;
export type MachViolationResolution = ViolationResolution;
export type MachSandboxEventReason =
  | "missing-mach-lookup"
  | "already-approved-still-failed"
  | "unknown";
export type MachSandboxEvent = SandboxEventBase<"mach", MachSandboxEventReason>;

export function detectMachLookupViolationFromLine(line: string): MachLookupViolation | null {
  const match = line.match(/\bdeny\(\d+\)\s+mach-lookup\s+([^\s()"'*]+)/i);
  const service = match?.[1];
  return service ? { service } : null;
}

export function detectMachLookupViolations(lines: string[]): MachLookupViolation[] {
  const violationsByService = new Map<string, MachLookupViolation>();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const violation = detectMachLookupViolationFromLine(lines[index]);
    if (violation && !violationsByService.has(violation.service)) {
      violationsByService.set(violation.service, violation);
    }
  }

  return Array.from(violationsByService.values());
}

export function isValidMachLookupRule(rule: string): boolean {
  const trimmed = rule.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;

  const prefix = trimmed.endsWith("*") ? trimmed.slice(0, -1) : trimmed;
  return !prefix.includes("*");
}

export function matchesMachLookupRule(service: string, rule: string): boolean {
  if (rule === "*") return true;
  if (rule.endsWith("*")) return service.startsWith(rule.slice(0, -1));
  return service === rule;
}

export function mutateMachLookupAllowList(
  runtimeConfig: SandboxRuntimeConfig,
  op: MachLookupListOp,
  service: string,
): boolean {
  const allowList = getMachLookupAllowList(runtimeConfig);
  if (op === "add") {
    if (allowList.includes(service)) return false;
    allowList.push(service);
    return true;
  }

  const index = allowList.indexOf(service);
  if (index === -1) return false;
  allowList.splice(index, 1);
  return true;
}

export function getMachLookupArgumentCompletions(options: {
  tokens: string[];
  endsWithSpace: boolean;
  runtimeConfig: SandboxRuntimeConfig | null;
  operationOptions: Array<{ value: string; label?: string; description?: string }>;
  getCommandCompletions: (
    base: string,
    partial: string,
    options: Array<{ value: string; label?: string; description?: string }>,
  ) => Array<{ value: string; label: string; description?: string }> | null;
  getStringValueCompletions: (
    base: string,
    partial: string,
    values: string[],
  ) => Array<{ value: string; label: string }> | null;
}): Array<{ value: string; label: string; description?: string }> | null {
  const {
    tokens,
    endsWithSpace,
    runtimeConfig,
    operationOptions,
    getCommandCompletions,
    getStringValueCompletions,
  } = options;

  if (tokens.length === 1 && endsWithSpace) {
    return getCommandCompletions("mach-lookup ", "", operationOptions);
  }
  if (tokens.length === 2 && !endsWithSpace) {
    return getCommandCompletions("mach-lookup ", tokens[1] ?? "", operationOptions);
  }

  if (tokens[1]?.toLowerCase() !== "remove") return null;

  const values = runtimeConfig?.network.allowMachLookup ?? [];
  const valueBase = "mach-lookup remove ";
  if (tokens.length === 2 && endsWithSpace) {
    return getStringValueCompletions(valueBase, "", values);
  }
  if (tokens.length === 3 && !endsWithSpace) {
    return getStringValueCompletions(valueBase, tokens[2] ?? "", values);
  }
  return null;
}

export async function handleMachLookupViolation(options: {
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  violations: MachLookupViolation[];
  command: string;
  cwd?: string;
  pendingPrompts?: Map<string, Promise<MachViolationResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent?: (event: MachSandboxEvent) => void;
  autoRetryAvailable?: boolean;
  withPromptSignal: <T>(run: () => Promise<T>) => Promise<T>;
  getPromptOptions: (autoRetryAvailable: boolean) => string[];
  parsePromptSelection: (
    selection: string | undefined,
    autoRetryAvailable: boolean,
  ) => MachPromptDecision;
  escapeSlashCommandArg: (value: string) => string;
}): Promise<MachViolationResolution | null> {
  const {
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
    withPromptSignal,
    getPromptOptions,
    parsePromptSelection,
    escapeSlashCommandArg,
  } = options;

  if (violations.length === 0) return null;

  const violation =
    violations.find((candidate) => !isMachLookupAlreadyAllowed(runtimeConfig, candidate.service)) ??
    violations[0];
  const allowCommand = buildMachLookupAllowCommand(violation.service, escapeSlashCommandArg);
  const alreadyApproved = isMachLookupAlreadyAllowed(runtimeConfig, violation.service);
  const eventReason = alreadyApproved ? "already-approved-still-failed" : "missing-mach-lookup";

  const recordMachEvent = (outcome: MachSandboxEvent["outcome"]): void => {
    recordEvent?.({
      timestamp: Date.now(),
      kind: "mach",
      outcome,
      reason: eventReason,
      target: violation.service,
      command,
      cwd,
      summary: describeMachLookupEventSummary(eventReason, outcome),
      suggestedCommand: outcome === "blocked" && !alreadyApproved ? allowCommand : undefined,
    });
  };

  if (promptMode === "non-interactive" || !ctx?.hasUI) {
    recordMachEvent("blocked");
    return {
      kind: "deny",
      message: formatMachLookupAllowHint(violation, allowCommand),
    };
  }

  if (alreadyApproved) {
    recordMachEvent("blocked");
    return { kind: "allow-adapt", message: MACH_LOOKUP_MESSAGES.alreadyAllowed };
  }

  const interactiveContext = ctx;
  if (!interactiveContext) return null;

  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  const existingPrompt = pendingPrompts?.get(promptKey);
  if (existingPrompt) return existingPrompt;

  const promptTask: Promise<MachViolationResolution | null> = (async () => {
    try {
      const selection = await withPromptSignal(() =>
        interactiveContext.ui.select(
          `Sandbox blocked Mach service ${describeMachLookupTarget(violation)}`,
          getPromptOptions(autoRetryAvailable),
        ),
      );
      const decision = parsePromptSelection(selection, autoRetryAvailable);
      if (decision === "deny") {
        recordMachEvent("blocked");
        return { kind: "deny", message: MACH_LOOKUP_MESSAGES.denied };
      }

      const nextConfig = structuredClone(runtimeConfig);
      const changed = mutateMachLookupAllowList(nextConfig, "add", violation.service);
      if (changed) {
        applyRuntimeConfigForSession?.(interactiveContext, nextConfig);
      }

      recordMachEvent("allowed");

      if (decision === "allow-retry") {
        return {
          kind: "allow-retry",
          message: MACH_LOOKUP_MESSAGES.allowRetry,
          retrySuccessMessage: "",
          retryFailureMessage: MACH_LOOKUP_MESSAGES.retryFailed,
          retrySkippedMessage: MACH_LOOKUP_MESSAGES.retrySkipped,
        };
      }

      return {
        kind: "allow-adapt",
        message: changed ? MACH_LOOKUP_MESSAGES.allowAdapt : MACH_LOOKUP_MESSAGES.alreadyAllowed,
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

function getMachLookupAllowList(runtimeConfig: SandboxRuntimeConfig): string[] {
  if (!runtimeConfig.network.allowMachLookup) {
    runtimeConfig.network.allowMachLookup = [];
  }
  return runtimeConfig.network.allowMachLookup;
}

function isMachLookupAlreadyAllowed(runtimeConfig: SandboxRuntimeConfig, service: string): boolean {
  return (runtimeConfig.network.allowMachLookup ?? []).some((rule) =>
    matchesMachLookupRule(service, rule),
  );
}

function buildMachLookupAllowCommand(
  service: string,
  escapeSlashCommandArg: (value: string) => string,
): string {
  return `/sandbox mach-lookup add ${escapeSlashCommandArg(service)}`;
}

function formatMachLookupViolationSummary(violation: MachLookupViolation): string {
  return `[sandbox] Blocked Mach service lookup: ${violation.service}`;
}

function formatMachLookupAllowHint(violation: MachLookupViolation, allowCommand: string): string {
  return `${formatMachLookupViolationSummary(violation)}\n[sandbox] To temporarily allow for this session, run: ${allowCommand}`;
}

function describeMachLookupTarget(violation: MachLookupViolation): string {
  return `lookup of ${violation.service}`;
}

function describeMachLookupEventSummary(
  reason: MachSandboxEvent["reason"],
  outcome: MachSandboxEvent["outcome"],
): string {
  if (outcome === "allowed") return "user allowed Mach service lookup for this session";
  if (reason === "already-approved-still-failed") {
    return "Mach service lookup was previously allowed for this session but is still failing";
  }
  if (reason === "missing-mach-lookup") {
    return "Mach service lookup is not in the allowed service list";
  }
  return "sandbox blocked Mach service lookup";
}

const MACH_LOOKUP_BLOCKED_PREFIX = "\nSandbox blocked Mach service lookup.\n\n";

const MACH_LOOKUP_MESSAGES = {
  allowRetry: `${MACH_LOOKUP_BLOCKED_PREFIX}Granting access and retrying the command per user request...\n\n`,
  allowAdapt: `${MACH_LOOKUP_BLOCKED_PREFIX}Access granted for this session. Retry the command manually if appropriate.`,
  denied: `${MACH_LOOKUP_BLOCKED_PREFIX}Access remains denied for this session.`,
  alreadyAllowed:
    "\nSandbox blocked Mach service lookup again after permission had already been granted. The remaining failure may be unrelated to sandbox policy.",
  retryFailed:
    "\nAccess granted and command retried per user request, but the command still exited non-zero. The sandbox block was resolved; the remaining failure may be unrelated.",
  retrySkipped:
    "\nAccess granted for this session, but automatic retry was skipped because the timeout was exhausted. Retry the command manually if needed.",
} as const;
