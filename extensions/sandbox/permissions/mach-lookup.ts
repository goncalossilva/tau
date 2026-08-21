import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  mutateStringList,
  type ListOp,
  type PromptMode,
} from "../config.js";
import type { SandboxEvent, SandboxEventOutcome, SandboxEventReason } from "../runtime.js";
import {
  createPermissionResolution,
  showPermissionDialog,
  type PermissionResolution,
} from "./dialog.js";

interface MachLookupViolation {
  service: string;
}

function detectMachLookupViolationFromLine(line: string): MachLookupViolation | null {
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

function matchesMachLookupRule(service: string, rule: string): boolean {
  if (rule === "*") return true;
  if (rule.endsWith("*")) return service.startsWith(rule.slice(0, -1));
  return service === rule;
}

export function mutateMachLookupAllowList(
  runtimeConfig: SandboxRuntimeConfig,
  op: ListOp,
  service: string,
): boolean {
  runtimeConfig.network.allowMachLookup ??= [];
  return mutateStringList(runtimeConfig.network.allowMachLookup, op, service);
}

function isMachLookupAlreadyAllowed(
  runtimeConfig: SandboxRuntimeConfig | null,
  service: string,
): boolean {
  return (runtimeConfig?.network.allowMachLookup ?? []).some((rule) =>
    matchesMachLookupRule(service, rule),
  );
}

function buildMachLookupAllowCommand(service: string): string {
  return `/sandbox mach-lookup add ${escapeSlashCommandArg(service)}`;
}

function formatMachLookupViolationSummary(service: string): string {
  return `[sandbox] Blocked macOS service lookup: ${service}`;
}

function describeMachLookupEventSummary(
  reason: SandboxEventReason,
  outcome: SandboxEventOutcome,
): string {
  if (outcome === "allowed") return "user allowed macOS service lookup for this session";
  if (reason === "already-approved-still-failed") {
    return "macOS service lookup was previously allowed for this session but is still failing";
  }
  return "macOS service lookup is not in the allowed service list";
}

function formatMachLookupBlockedTarget(service: string): string {
  return `Sandbox blocked access to macOS service ${service}.`;
}

export async function handleMachLookupViolation(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  violations: MachLookupViolation[];
  command: string;
  cwd?: string;
  pendingDialogs?: Map<string, Promise<PermissionResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent?: (event: SandboxEvent) => void;
  autoRetryAvailable?: boolean;
}): Promise<PermissionResolution | null> {
  const {
    pi,
    ctx,
    promptMode,
    runtimeConfig,
    violations,
    command,
    cwd,
    pendingDialogs,
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
    return createPermissionResolution("allow-adapt", blockedTarget, false);
  }

  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  return showPermissionDialog({
    pi,
    ctx,
    title: `Sandbox blocked access to macOS service ${service}`,
    promptKey,
    pendingDialogs,
    autoRetryAvailable,
    onDecision(decision) {
      if (decision === "deny") {
        recordMachLookupEvent("blocked");
        return createPermissionResolution(decision, blockedTarget);
      }

      const nextConfig = cloneRuntimeConfig(runtimeConfig);
      const changed = mutateMachLookupAllowList(nextConfig, "add", service);
      if (changed) {
        applyRuntimeConfigForSession?.(ctx, nextConfig);
      }

      recordMachLookupEvent("allowed");
      return createPermissionResolution(decision, blockedTarget, changed);
    },
  });
}
