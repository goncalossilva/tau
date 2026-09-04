import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  inferExactSandboxRuleMatch,
  inferSandboxRuleMatch,
  isSandboxWritablePath,
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

const READ_TRAVERSAL_PROCESSES = new Set(["find", "ls", "fd", "fdfind"]);

type FilesystemViolationKind = "read" | "write" | "unknown";
type FilesystemReadAccess = "metadata" | "data" | "unknown";
type FilesystemWriteAccess = "unlink" | "unknown";

export interface FilesystemViolation {
  kind: FilesystemViolationKind;
  path?: string;
  processName?: string;
  readAccess?: FilesystemReadAccess;
  writeAccess?: FilesystemWriteAccess;
}

export type FilesystemList = "deny-read" | "allow-write" | "deny-write";

export function isRuntimeProtectedWriteViolation(
  runtimeConfig: SandboxRuntimeConfig | null,
  violation: FilesystemViolation,
  cwd?: string,
): boolean {
  if (
    !runtimeConfig ||
    runtimeConfig.filesystem.disabled ||
    !violation.path ||
    violation.kind !== "write"
  ) {
    return false;
  }

  return isSandboxWritablePath(runtimeConfig, violation.path, cwd);
}

export function getRuntimeProtectedWriteViolations(
  runtimeConfig: SandboxRuntimeConfig | null,
  violations: FilesystemViolation[],
  cwd?: string,
): FilesystemViolation[] {
  const violationsByPath = new Map<string, FilesystemViolation>();

  for (const violation of violations) {
    if (!isRuntimeProtectedWriteViolation(runtimeConfig, violation, cwd) || !violation.path) {
      continue;
    }
    if (!violationsByPath.has(violation.path)) {
      violationsByPath.set(violation.path, violation);
    }
  }

  return Array.from(violationsByPath.values());
}

function extractSandboxViolationLines(output: string): string[] {
  // sandbox-runtime annotateStderrWithSandboxFailures wraps violations in this tag.
  const match = output.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/i);
  if (!match?.[1]) return [];

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripSandboxViolationAnnotations(text: string): string {
  return text
    .replace(/\n?<sandbox_violations>[\s\S]*?<\/sandbox_violations>\n?/gi, "\n")
    .replace(/^\n+|\n+$/g, "");
}

export function extractAppendedSandboxAnnotation(original: string, annotated: string): string {
  if (annotated === original) return "";

  if (annotated.startsWith(original)) {
    return stripSandboxViolationAnnotations(annotated.slice(original.length));
  }

  const violationLines = extractSandboxViolationLines(annotated);
  if (violationLines.length === 0) return "";

  // Sandbox violations are summarized elsewhere via compact extension messages,
  // so suppress the verbose synthetic annotation block.
  return "";
}

function sanitizeExtractedPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const withoutDelimiter = trimmed.replace(/:+$/g, "");
  return withoutDelimiter.length > 0 ? withoutDelimiter : undefined;
}

function extractPathLikeValueFromLine(line: string): string | undefined {
  const sandboxViolationMatch = line.match(/\bfile-(?:read|write)[^\s]*\s+((?:~\/|\/).+)$/i);
  if (sandboxViolationMatch?.[1]) return sanitizeExtractedPath(sandboxViolationMatch[1]);

  const operationNotPermittedMatch = line.match(
    /^(?:[^:\n]+:\s+)*((?:~\/|\/).+?):\s+Operation not permitted$/i,
  );
  if (operationNotPermittedMatch?.[1]) return sanitizeExtractedPath(operationNotPermittedMatch[1]);

  const quotedPathMatch = line.match(/["']((?:~\/|\/)[^"']+)["']/);
  if (quotedPathMatch?.[1]) return sanitizeExtractedPath(quotedPathMatch[1]);

  const rawPathMatch = line.match(/((?:~\/|\/)[^\s,)]+)/);
  if (rawPathMatch?.[1]) return sanitizeExtractedPath(rawPathMatch[1]);

  return undefined;
}

function extractPathLikeValue(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const path = extractPathLikeValueFromLine(lines[index]);
    if (path) return path;
  }

  return undefined;
}

function extractViolationProcessName(line: string): string | undefined {
  const match = line.match(/^([^\s(]+)\(/);
  const processName = match?.[1]?.trim();
  if (!processName) return undefined;
  return processName.split("/").pop() || processName;
}

export function detectFilesystemViolationFromLine(line: string): FilesystemViolation | null {
  // Runtime emits concrete op variants (e.g. file-write-create/unlink, file-read-data).
  const lower = line.toLowerCase();
  const path = extractPathLikeValue(line);
  const processName = extractViolationProcessName(line);

  if (lower.includes("file-write-unlink")) {
    return { kind: "write", path, processName, writeAccess: "unlink" };
  }

  if (lower.includes("file-write")) {
    return { kind: "write", path, processName, writeAccess: "unknown" };
  }

  if (lower.includes("file-read-metadata")) {
    return { kind: "read", path, processName, readAccess: "metadata" };
  }

  if (lower.includes("file-read-data")) {
    return { kind: "read", path, processName, readAccess: "data" };
  }

  if (lower.includes("file-read")) {
    return { kind: "read", path, processName, readAccess: "unknown" };
  }

  return null;
}

function detectFilesystemViolations(
  output: string,
  fallbackOutput: string = output,
  allowOutputFallback = true,
): FilesystemViolation[] {
  const violations: FilesystemViolation[] = [];
  const violationLines = extractSandboxViolationLines(output);

  for (let index = violationLines.length - 1; index >= 0; index -= 1) {
    const violation = detectFilesystemViolationFromLine(violationLines[index]);
    if (violation) violations.push(violation);
  }

  if (violations.length > 0 || !allowOutputFallback) return violations;

  const hasEperm = /\bEPERM\b/i.test(fallbackOutput);
  const hasOperationNotPermitted = /(?:^|\n)[^\n]*Operation not permitted(?:$|\n)/i.test(
    fallbackOutput,
  );
  if (hasEperm || hasOperationNotPermitted) {
    const path = extractPathLikeValue(fallbackOutput);
    if (path) violations.push({ kind: "unknown", path });
  }

  return violations;
}

export function isTraversalViolation(
  runtimeConfig: SandboxRuntimeConfig | null,
  violation: FilesystemViolation,
  cwd?: string,
): boolean {
  if (!runtimeConfig || !violation.path) return false;
  if (!READ_TRAVERSAL_PROCESSES.has(violation.processName ?? "")) return false;

  if (violation.kind === "read") {
    return inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd) !== null;
  }

  if (violation.kind !== "write" || violation.writeAccess !== "unlink") return false;

  // Seatbelt can emit file-write-unlink checks for protected directory roots
  // while traversal commands enumerate them. Only exact protected roots are
  // treated as skipped traversal so writes under protected trees still prompt.
  return (
    inferExactSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd) !== null ||
    inferExactSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd) !== null
  );
}

export function getTraversalPaths(options: {
  runtimeConfig: SandboxRuntimeConfig | null;
  output: string;
  cwd?: string;
}): string[] | null {
  const { runtimeConfig, output, cwd } = options;
  if (!runtimeConfig) return null;

  const violationLines = extractSandboxViolationLines(output);
  if (violationLines.length === 0) return null;

  const skippedPaths: string[] = [];
  for (const line of violationLines) {
    const violation = detectFilesystemViolationFromLine(line);
    if (!violation || !isTraversalViolation(runtimeConfig, violation, cwd)) {
      return null;
    }
    if (violation.path && !skippedPaths.includes(violation.path)) {
      skippedPaths.push(violation.path);
    }
  }

  return skippedPaths.length > 0 ? skippedPaths : null;
}

export function formatTraversalNotice(paths: string[]): string {
  if (paths.length === 0) return "";

  const visiblePaths = paths.slice(0, 3).join(", ");
  const suffix = paths.length > 3 ? ", ..." : "";
  const label = paths.length === 1 ? "path" : "paths";
  return `[sandbox] Continued after skipping protected ${label}: ${visiblePaths}${suffix}`;
}

export function formatRuntimeProtectedWriteNotice(
  violations: FilesystemViolation[],
  continued: boolean,
): string {
  const paths = violations
    .map((violation) => violation.path)
    .filter((path): path is string => path !== undefined);
  if (paths.length === 0) return "";

  const visiblePaths = paths.slice(0, 3).join(", ");
  const suffix = paths.length > 3 ? ", ..." : "";
  const label = paths.length === 1 ? "write" : "writes";
  const prefix = continued ? "Continued after blocking" : "Blocked";
  return `[sandbox] ${prefix} runtime-protected ${label} that sandbox config cannot override: ${visiblePaths}${suffix}`;
}

interface FilesystemAllowAction {
  list: FilesystemList;
  op: ListOp;
  value: string;
}

function buildFilesystemAllowAction(
  runtimeConfig: SandboxRuntimeConfig,
  violation: FilesystemViolation,
  cwd?: string,
): FilesystemAllowAction | null {
  if (!violation.path) return null;

  if (violation.kind === "read") {
    const matchedRule = inferSandboxRuleMatch(
      violation.path,
      runtimeConfig.filesystem.denyRead,
      cwd,
    );
    return { list: "deny-read", op: "remove", value: matchedRule ?? violation.path };
  }

  if (violation.kind === "write") {
    const matchedDeny = inferSandboxRuleMatch(
      violation.path,
      runtimeConfig.filesystem.denyWrite,
      cwd,
    );
    if (matchedDeny) {
      return { list: "deny-write", op: "remove", value: matchedDeny };
    }

    return { list: "allow-write", op: "add", value: violation.path };
  }

  const matchedDenyWrite = inferSandboxRuleMatch(
    violation.path,
    runtimeConfig.filesystem.denyWrite,
    cwd,
  );
  if (matchedDenyWrite) {
    return { list: "deny-write", op: "remove", value: matchedDenyWrite };
  }

  const matchedDenyRead = inferSandboxRuleMatch(
    violation.path,
    runtimeConfig.filesystem.denyRead,
    cwd,
  );
  if (matchedDenyRead) {
    return { list: "deny-read", op: "remove", value: matchedDenyRead };
  }

  return { list: "allow-write", op: "add", value: violation.path };
}

function buildFilesystemAllowCommand(action: FilesystemAllowAction): string {
  return `/sandbox filesystem ${action.list} ${action.op} ${escapeSlashCommandArg(action.value)}`;
}

function getFilesystemListValues(
  runtimeConfig: SandboxRuntimeConfig,
  list: FilesystemList,
): string[] {
  if (list === "deny-read") return runtimeConfig.filesystem.denyRead;
  if (list === "allow-write") return runtimeConfig.filesystem.allowWrite;
  return runtimeConfig.filesystem.denyWrite;
}

function applyFilesystemAllowAction(
  runtimeConfig: SandboxRuntimeConfig,
  action: FilesystemAllowAction,
): boolean {
  const values = getFilesystemListValues(runtimeConfig, action.list);
  return mutateStringList(values, action.op, action.value);
}

function isFilesystemAllowActionAlreadyApplied(
  runtimeConfig: SandboxRuntimeConfig,
  action: FilesystemAllowAction,
): boolean {
  const values = getFilesystemListValues(runtimeConfig, action.list);
  return action.op === "add" ? values.includes(action.value) : !values.includes(action.value);
}

function describeFilesystemViolationTarget(violation: FilesystemViolation): string {
  if (violation.kind === "read") {
    if (violation.path) return `read from ${violation.path}`;
    return "read";
  }

  if (violation.kind === "write") {
    if (violation.path) return `write to ${violation.path}`;
    return "write";
  }

  if (violation.path) return `access to ${violation.path}`;
  return "access";
}

function formatFilesystemViolationSummary(violation: FilesystemViolation): string {
  if (violation.kind === "read") {
    if (violation.path) return `[sandbox] Blocked filesystem read: ${violation.path}`;
    return "[sandbox] Blocked filesystem read.";
  }

  if (violation.kind === "write") {
    if (violation.path) return `[sandbox] Blocked filesystem write: ${violation.path}`;
    return "[sandbox] Blocked filesystem write.";
  }

  if (violation.path) return `[sandbox] Blocked filesystem access: ${violation.path}`;
  return "[sandbox] Blocked filesystem access (EPERM).";
}

function classifyFilesystemEventReason(
  runtimeConfig: SandboxRuntimeConfig,
  violation: FilesystemViolation,
  cwd?: string,
  alreadyApproved = false,
): SandboxEventReason {
  if (alreadyApproved) return "already-approved-still-failed";

  if (violation.path) {
    if (inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd)) {
      return "explicit-deny-write";
    }
    if (inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd)) {
      return "explicit-deny-read";
    }
  }

  if (violation.kind === "write" || violation.kind === "unknown") return "missing-allow-write";
  return "unknown";
}

function describeFilesystemEventSummary(
  reason: SandboxEventReason,
  violation: FilesystemViolation,
  outcome: SandboxEventOutcome,
): string {
  if (outcome === "allowed") {
    if (reason === "explicit-deny-read") return "user allowed filesystem read for this session";
    if (reason === "explicit-deny-write") return "user allowed filesystem write for this session";
    if (reason === "missing-allow-write") {
      return violation.kind === "unknown"
        ? "user allowed filesystem access for this session"
        : "user allowed filesystem write path for this session";
    }
    return "user allowed filesystem access for this session";
  }

  if (reason === "explicit-deny-read") return "filesystem read matched a deny-read rule";
  if (reason === "explicit-deny-write") return "filesystem write matched a deny-write rule";
  if (reason === "runtime-protected-write") {
    return "filesystem write is protected by the sandbox runtime";
  }
  if (reason === "already-approved-still-failed") {
    return "filesystem access was previously allowed for this session but is still failing";
  }
  if (reason === "missing-allow-write") {
    return violation.kind === "unknown"
      ? "filesystem access fell outside the current allow-write paths"
      : "filesystem write fell outside the current allow-write paths";
  }
  return "sandbox blocked filesystem access";
}

function formatFilesystemBlockedTarget(target: string): string {
  return `Sandbox blocked filesystem ${target}.`;
}

export async function handleFilesystemViolation(options: {
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  output: string;
  rawOutput: string;
  command: string;
  cwd?: string;
  pendingDialogs?: Map<string, Promise<PermissionResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent?: (event: SandboxEvent) => void;
  autoRetryAvailable?: boolean;
  runtimeProtectedWriteViolations?: FilesystemViolation[];
  allowOutputFallback?: boolean;
}): Promise<PermissionResolution | null> {
  const {
    ctx,
    promptMode,
    runtimeConfig,
    output,
    rawOutput,
    command,
    cwd,
    pendingDialogs,
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
    return createPermissionResolution("allow-adapt", blockedTarget, false);
  }

  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  return showPermissionDialog({
    ctx,
    title: `Sandbox blocked filesystem ${target}`,
    promptKey,
    pendingDialogs,
    autoRetryAvailable,
    onDecision(decision) {
      if (decision === "deny") {
        recordFilesystemEvent("blocked");
        return createPermissionResolution(decision, blockedTarget);
      }

      const nextConfig = cloneRuntimeConfig(runtimeConfig);
      const changed = applyFilesystemAllowAction(nextConfig, allowAction);
      if (changed) {
        applyRuntimeConfigForSession?.(ctx, nextConfig);
      }

      recordFilesystemEvent("allowed");
      return createPermissionResolution(decision, blockedTarget, changed);
    },
  });
}
