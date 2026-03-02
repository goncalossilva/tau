/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Note: list fields are overridden (replaced), not concatenated.
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "mode": "interactive",
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show command help
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

type PromptMode = "interactive" | "non-interactive";

type SandboxBypassReason = "no-sandbox-flag" | "config-disabled";
type SandboxBlockedReason = "unsupported-platform" | "init-failed";

type SandboxRunMode = "sandbox" | "user-disabled" | SandboxBypassReason | SandboxBlockedReason;

type SandboxState =
  | { status: "pending" }
  | { status: "active"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "suspended"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "bypassed"; reason: SandboxBypassReason }
  | { status: "blocked"; reason: SandboxBlockedReason };

interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
  mode?: PromptMode;
}

const DEFAULT_PROMPT_MODE: PromptMode = "interactive";

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  mode: DEFAULT_PROMPT_MODE,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

const STATUS_KEY = "sandbox";

type PromptStatus = "completed" | "error";

async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
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

type UiLevel = "info" | "warning" | "error";

type ListOp = "add" | "remove";
type NetworkList = "allow" | "deny";
type FilesystemList = "deny-read" | "allow-write" | "deny-write";

type FilesystemViolationKind = "read" | "write" | "unknown";

interface FilesystemViolation {
  kind: FilesystemViolationKind;
  path?: string;
}

function normalizePromptMode(value: unknown): PromptMode {
  return value === "non-interactive" ? "non-interactive" : "interactive";
}

function setSandboxStatus(
  ctx: ExtensionContext,
  enabled: boolean,
  runtimeConfig?: SandboxRuntimeConfig,
  promptMode: PromptMode = DEFAULT_PROMPT_MODE,
): void {
  if (!ctx.hasUI) return;

  if (!enabled || !runtimeConfig) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const networkCount = runtimeConfig.network.allowedDomains.length;
  const writeCount = runtimeConfig.filesystem.allowWrite.length;
  const text = `sandbox: enabled (${promptMode}, ${networkCount} domains, ${writeCount} write paths)`;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
}

function notify(ctx: ExtensionContext, text: string, level: UiLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }

  if (level === "error" || level === "warning") console.error(text);
  else console.log(text);
}

function showHelp(ctx: ExtensionContext): void {
  const lines = [
    "Usage:",
    "  /sandbox enable",
    "  /sandbox disable",
    "  /sandbox show",
    "  /sandbox mode <interactive|non-interactive>",
    "  /sandbox network <allow|deny> <add|remove> <domain>",
    "  /sandbox filesystem <deny-read|allow-write|deny-write> <add|remove> <path>",
  ];
  notify(ctx, lines.join("\n"), "info");
}

function parseCommandArgs(args?: string): string[] {
  if (!args?.trim()) return [];

  const input = args.trim();
  const tokens: string[] = [];
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s])+)/g;

  for (const match of input.matchAll(tokenPattern)) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\(.)/g, "$1"));
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else if (match[3] !== undefined) {
      tokens.push(match[3].replace(/\\(.)/g, "$1"));
    }
  }

  return tokens;
}

function coerceStringArray(value: unknown, fallback: string[], field: string): string[] {
  if (!Array.isArray(value)) {
    console.error(`Warning: Expected ${field} to be a string[]; using defaults.`);
    return [...fallback];
  }

  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const droppedCount = value.length - cleaned.length;
  if (droppedCount > 0) {
    console.error(`Warning: Ignoring ${droppedCount} invalid values in ${field}.`);
  }

  return cleaned;
}

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
    }
  }

  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);

  // Sanitize config.
  return {
    ...merged,
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
    mode: normalizePromptMode(merged.mode),
    network: {
      ...merged.network,
      allowedDomains: coerceStringArray(merged.network?.allowedDomains, DEFAULT_CONFIG.network.allowedDomains, "network.allowedDomains"),
      deniedDomains: coerceStringArray(merged.network?.deniedDomains, DEFAULT_CONFIG.network.deniedDomains, "network.deniedDomains"),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead: coerceStringArray(merged.filesystem?.denyRead, DEFAULT_CONFIG.filesystem.denyRead, "filesystem.denyRead"),
      allowWrite: coerceStringArray(merged.filesystem?.allowWrite, DEFAULT_CONFIG.filesystem.allowWrite, "filesystem.allowWrite"),
      denyWrite: coerceStringArray(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem.denyWrite, "filesystem.denyWrite"),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.mode !== undefined) {
    result.mode = normalizePromptMode(overrides.mode);
  }
  if (isPlainObject(overrides.network)) {
    result.network = {
      ...base.network,
      ...(overrides.network as Partial<SandboxRuntimeConfig["network"]>),
    };
  }
  if (isPlainObject(overrides.filesystem)) {
    result.filesystem = {
      ...base.filesystem,
      ...(overrides.filesystem as Partial<SandboxRuntimeConfig["filesystem"]>),
    };
  }
  if (overrides.ignoreViolations !== undefined) {
    result.ignoreViolations = overrides.ignoreViolations;
  }
  if (overrides.enableWeakerNestedSandbox !== undefined) {
    result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
  }
  if (overrides.enableWeakerNetworkIsolation !== undefined) {
    result.enableWeakerNetworkIsolation = overrides.enableWeakerNetworkIsolation;
  }

  return result;
}

function toRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
  return {
    network: config.network,
    filesystem: config.filesystem,
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: config.enableWeakerNetworkIsolation,
  };
}

function cloneRuntimeConfig(config: SandboxRuntimeConfig): SandboxRuntimeConfig {
  return structuredClone(config);
}

function expandTildePath(value: string): string {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function inferLiteralRuleMatch(path: string, rules: string[], cwd?: string): string | null {
  const normalizedPath = expandTildePath(path);

  for (const rule of rules) {
    if (rule.includes("*") || rule.includes("?") || rule.includes("[")) continue;

    const normalizedRuleBase = expandTildePath(rule);
    const normalizedRule =
      cwd && !normalizedRuleBase.startsWith("/") ? resolve(cwd, normalizedRuleBase) : normalizedRuleBase;

    if (normalizedPath === normalizedRule) return rule;

    const prefix = normalizedRule.endsWith("/") ? normalizedRule : `${normalizedRule}/`;
    if (normalizedPath.startsWith(prefix)) return rule;
  }

  return null;
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

function extractAppendedSandboxAnnotation(
  original: string,
  annotated: string,
  skipViolationLines = 0,
): string {
  if (annotated === original) return "";

  if (skipViolationLines <= 0 && annotated.startsWith(original)) {
    return annotated.slice(original.length);
  }

  const violationLines = extractSandboxViolationLines(annotated);
  const newViolationLines =
    skipViolationLines > 0 ? violationLines.slice(Math.min(skipViolationLines, violationLines.length)) : violationLines;
  if (newViolationLines.length === 0) return "";

  return `\n<sandbox_violations>\n${newViolationLines.join("\n")}\n</sandbox_violations>`;
}

function sanitizeExtractedPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const withoutDelimiter = trimmed.replace(/:+$/g, "");
  return withoutDelimiter.length > 0 ? withoutDelimiter : undefined;
}

function extractPathLikeValue(text: string): string | undefined {
  const quotedPathMatch = text.match(/["']((?:~\/|\/)[^"']+)["']/);
  if (quotedPathMatch?.[1]) return quotedPathMatch[1].trim() || undefined;

  const rawPathMatch = text.match(/((?:~\/|\/)[^\s,)]+)/);
  if (rawPathMatch?.[1]) return sanitizeExtractedPath(rawPathMatch[1]);

  return undefined;
}

function detectFilesystemViolationFromLine(line: string): FilesystemViolation | null {
  // Runtime emits concrete op variants (e.g. file-write-create/unlink, file-read-data).
  const lower = line.toLowerCase();
  if (lower.includes("file-write")) return { kind: "write", path: extractPathLikeValue(line) };
  if (lower.includes("file-read")) return { kind: "read", path: extractPathLikeValue(line) };
  return null;
}

function detectFilesystemViolations(
  output: string,
  fallbackOutput: string = output,
  skipViolationLines = 0,
): FilesystemViolation[] {
  const violations: FilesystemViolation[] = [];
  const allViolationLines = extractSandboxViolationLines(output);
  const violationLines =
    skipViolationLines > 0
      ? allViolationLines.slice(Math.min(skipViolationLines, allViolationLines.length))
      : allViolationLines;

  for (let index = violationLines.length - 1; index >= 0; index -= 1) {
    const violation = detectFilesystemViolationFromLine(violationLines[index]);
    if (violation) violations.push(violation);
  }

  if (violations.length > 0) return violations;

  const hasEperm = /\bEPERM\b/i.test(fallbackOutput);
  const hasOperationNotPermitted = /(?:^|\n)[^\n]*Operation not permitted(?:$|\n)/i.test(fallbackOutput);
  if (hasEperm || hasOperationNotPermitted) {
    const path = extractPathLikeValue(fallbackOutput);
    if (path) violations.push({ kind: "unknown", path });
  }

  return violations;
}

function escapeSlashCommandArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+\-~]+$/.test(value)) return value;
  return JSON.stringify(value);
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
    const matchedRule = inferLiteralRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd);
    return { list: "deny-read", op: "remove", value: matchedRule ?? violation.path };
  }

  if (violation.kind === "write") {
    const matchedDeny = inferLiteralRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd);
    if (matchedDeny) {
      return { list: "deny-write", op: "remove", value: matchedDeny };
    }

    return { list: "allow-write", op: "add", value: violation.path };
  }

  const matchedDenyWrite = inferLiteralRuleMatch(violation.path, runtimeConfig.filesystem.denyWrite, cwd);
  if (matchedDenyWrite) {
    return { list: "deny-write", op: "remove", value: matchedDenyWrite };
  }

  const matchedDenyRead = inferLiteralRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd);
  if (matchedDenyRead) {
    return { list: "deny-read", op: "remove", value: matchedDenyRead };
  }

  return { list: "allow-write", op: "add", value: violation.path };
}

function buildFilesystemAllowCommand(action: FilesystemAllowAction): string {
  return `/sandbox filesystem ${action.list} ${action.op} ${escapeSlashCommandArg(action.value)}`;
}

function getFilesystemListValues(runtimeConfig: SandboxRuntimeConfig, list: FilesystemList): string[] {
  if (list === "deny-read") return runtimeConfig.filesystem.denyRead;
  if (list === "allow-write") return runtimeConfig.filesystem.allowWrite;
  return runtimeConfig.filesystem.denyWrite;
}

function applyFilesystemAllowAction(runtimeConfig: SandboxRuntimeConfig, action: FilesystemAllowAction): boolean {
  const values = getFilesystemListValues(runtimeConfig, action.list);
  return mutateStringList(values, action.op, action.value);
}

function isFilesystemAllowActionAlreadyApplied(runtimeConfig: SandboxRuntimeConfig, action: FilesystemAllowAction): boolean {
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

async function handleFilesystemViolation(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  output: string;
  rawOutput: string;
  command: string;
  cwd?: string;
  pendingPrompts?: Map<string, Promise<string | null>>;
  applyRuntimeConfigForSession?: (ctx: ExtensionContext, runtimeConfig: SandboxRuntimeConfig) => void;
  existingViolationCount?: number;
}): Promise<string | null> {
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
    existingViolationCount,
  } = options;
  const violations = detectFilesystemViolations(output, rawOutput, existingViolationCount ?? 0);
  if (violations.length === 0) return null;

  const violation =
    violations.find((candidate) => {
      const candidateAction = buildFilesystemAllowAction(runtimeConfig, candidate, cwd);
      if (!candidateAction) return false;
      return !isFilesystemAllowActionAlreadyApplied(runtimeConfig, candidateAction);
    }) ?? violations[0];

  const summary = formatFilesystemViolationSummary(violation);
  const target = describeFilesystemViolationTarget(violation);
  const allowAction = buildFilesystemAllowAction(runtimeConfig, violation, cwd);
  const allowCommand = allowAction ? buildFilesystemAllowCommand(allowAction) : null;
  const commandInfo = `\n[sandbox] Blocked command: ${command}`;
  const retryHint = "\n[sandbox] Retry running the command (or an updated one if there could be side effects).";

  if (promptMode === "non-interactive" || !ctx?.hasUI) {
    if (!allowCommand) return summary;
    return `${summary}\n[sandbox] To temporarily allow for this session, run: ${allowCommand}`;
  }

  if (!allowAction || !allowCommand) return summary;

  if (isFilesystemAllowActionAlreadyApplied(runtimeConfig, allowAction)) {
    return `[sandbox] Filesystem ${target} is already allowed for this session.${commandInfo}${retryHint}`;
  }

  const promptKey = allowCommand;
  const existingPrompt = pendingPrompts?.get(promptKey);
  if (existingPrompt) return existingPrompt;

  const promptTask = (async () => {
    try {
      const approved = await withPromptSignal(pi, () =>
        ctx.ui.confirm(`Sandbox blocked filesystem ${target}`, "\nAllow for this session?"),
      );
      if (!approved) return null;

      const nextConfig = cloneRuntimeConfig(runtimeConfig);
      const changed = applyFilesystemAllowAction(nextConfig, allowAction);

      if (changed) {
        applyRuntimeConfigForSession?.(ctx, nextConfig);
        return `[sandbox] Allowed filesystem ${target} for this session.${commandInfo}${retryHint}`;
      }

      return `[sandbox] Filesystem ${target} is already allowed for this session.${commandInfo}${retryHint}`;
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

interface SandboxedBashOpsOptions {
  pi: ExtensionAPI;
  getContext: () => ExtensionContext | null;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  getPromptMode: () => PromptMode;
  getCwd: () => string;
  applyRuntimeConfigForSession: (ctx: ExtensionContext, runtimeConfig: SandboxRuntimeConfig) => void;
}

interface BashAttemptResult {
  exitCode: number | null;
  combinedOutput: string;
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child.pid) return;

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process likely already exited.
    }
  }
}

function safeCleanupAfterCommand(): void {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    // Ignore cleanup errors.
  }
}

function createSandboxedBashOps(options: SandboxedBashOpsOptions): BashOperations {
  const { pi, getContext, getRuntimeConfig, getPromptMode, getCwd, applyRuntimeConfigForSession } = options;
  const pendingFilesystemPrompts = new Map<string, Promise<string | null>>();

  let executionQueue: Promise<void> = Promise.resolve();

  function runSerially<T>(task: () => Promise<T>): Promise<T> {
    const run = executionQueue.then(task, task);
    executionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function runSandboxAttempt(
    wrappedCommand: string,
    cwd: string,
    onData: (data: Buffer) => void,
    signal?: AbortSignal,
    timeout?: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<BashAttemptResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", wrappedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timeoutEscalationHandle: NodeJS.Timeout | undefined;

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child, "SIGTERM");
          timeoutEscalationHandle = setTimeout(() => {
            killProcessGroup(child, "SIGKILL");
          }, 2000);
        }, timeout * 1000);
      }

      child.stdout?.on("data", (data) => {
        chunks.push(data);
        onData(data);
      });
      child.stderr?.on("data", (data) => {
        chunks.push(data);
        onData(data);
      });

      const onAbort = () => {
        killProcessGroup(child, "SIGKILL");
      };

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timeoutEscalationHandle) clearTimeout(timeoutEscalationHandle);
        signal?.removeEventListener("abort", onAbort);
        killProcessGroup(child, "SIGKILL");
        reject(err);
      });

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timeoutEscalationHandle) clearTimeout(timeoutEscalationHandle);
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }

        resolve({ exitCode: code, combinedOutput: Buffer.concat(chunks).toString("utf-8") });
      });
    });
  }

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      return runSerially(async () => {
        if (!existsSync(cwd)) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }

        const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
        const existingViolationCount = SandboxManager.getSandboxViolationStore().getViolationsForCommand(command).length;

        let attempt: BashAttemptResult;
        try {
          attempt = await runSandboxAttempt(wrappedCommand, cwd, onData, signal, timeout, env);
        } catch (err) {
          safeCleanupAfterCommand();
          throw err;
        }

        try {
          const annotatedOutput = SandboxManager.annotateStderrWithSandboxFailures(command, attempt.combinedOutput);
          const commandSucceeded = attempt.exitCode === 0;
          let postamble =
            commandSucceeded
              ? ""
              : extractAppendedSandboxAnnotation(attempt.combinedOutput, annotatedOutput, existingViolationCount);

          if (attempt.exitCode !== 0 && attempt.exitCode !== null) {
            const runtimeConfig = getRuntimeConfig();

            if (runtimeConfig) {
              const advice = await handleFilesystemViolation({
                pi,
                ctx: getContext(),
                promptMode: getPromptMode(),
                runtimeConfig,
                output: annotatedOutput,
                rawOutput: attempt.combinedOutput,
                command,
                cwd: getCwd(),
                pendingPrompts: pendingFilesystemPrompts,
                applyRuntimeConfigForSession,
                existingViolationCount,
              });

              if (advice) {
                const needsSeparator =
                  postamble.length > 0
                    ? !postamble.endsWith("\n")
                    : attempt.combinedOutput.length > 0 && !attempt.combinedOutput.endsWith("\n");

                if (needsSeparator) postamble += "\n";
                postamble += advice;
              }
            }
          }

          if (postamble) onData(Buffer.from(postamble));
        } catch (postProcessError) {
          const message = `[sandbox] Post-processing error: ${postProcessError instanceof Error ? postProcessError.message : postProcessError}`;
          const ctx = getContext();
          if (ctx) notify(ctx, message, "warning");
          else console.warn(message);
        } finally {
          safeCleanupAfterCommand();
        }

        return { exitCode: attempt.exitCode };
      });
    },
  };
}

function getSandboxRunMode(state: SandboxState): SandboxRunMode {
  if (state.status === "active" || state.status === "pending") return "sandbox";
  if (state.status === "suspended") return "user-disabled";
  return state.reason;
}

function getStateRuntimeConfig(state: SandboxState): SandboxRuntimeConfig | null {
  if (state.status === "active" || state.status === "suspended") return state.runtimeConfig;
  return null;
}

function requireRuntimeConfig(ctx: ExtensionContext, state: SandboxState): SandboxRuntimeConfig | null {
  const runtimeConfig = getStateRuntimeConfig(state);
  if (!runtimeConfig) {
    notify(ctx, "Sandbox is not initialized", "info");
    return null;
  }
  return runtimeConfig;
}

function mutateStringList(values: string[], op: ListOp, value: string): boolean {
  if (op === "add") {
    if (values.includes(value)) return false;
    values.push(value);
    return true;
  }

  const index = values.indexOf(value);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  let sessionCwd = process.cwd();
  let sandboxState: SandboxState = { status: "pending" };
  let promptMode: PromptMode = DEFAULT_PROMPT_MODE;
  let sessionContext: ExtensionContext | null = null;

  const pendingNetworkApprovals = new Map<string, Promise<boolean>>();

  function applyRuntimeConfigForSession(
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
    targetStatus: "active" | "suspended" = sandboxState.status === "suspended" ? "suspended" : "active",
  ): void {
    const nextConfig = cloneRuntimeConfig(runtimeConfig);
    sandboxState = { status: targetStatus, runtimeConfig: nextConfig };
    SandboxManager.updateConfig(nextConfig);
    setSandboxStatus(ctx, targetStatus === "active", nextConfig, promptMode);
  }

  const createNetworkAskCallback = (): SandboxAskCallback => {
    return async ({ host, port }) => {
      const normalizedHost = host.toLowerCase();
      const key = normalizedHost;

      const existingDecision = pendingNetworkApprovals.get(key);
      if (existingDecision) return existingDecision;

      const decision = (async () => {
        try {
          const initialConfig = getStateRuntimeConfig(sandboxState);
          if (!initialConfig) return false;

          if (initialConfig.network.allowedDomains.includes(normalizedHost)) return true;
          if (initialConfig.network.deniedDomains.includes(normalizedHost)) return false;

          const ctx = sessionContext;
          if (promptMode === "non-interactive" || !ctx || !ctx.hasUI) {
            if (ctx) {
              notify(
                ctx,
                `Sandbox blocked network access to ${normalizedHost}. To temporarily allow for this session, run: /sandbox network allow add ${normalizedHost}`,
                "warning",
              );
            } else {
              console.warn(
                `Sandbox blocked network access to ${normalizedHost}. To temporarily allow for this session, run: /sandbox network allow add ${normalizedHost}`,
              );
            }
            return false;
          }

          const target = port ? `${normalizedHost}:${port}` : normalizedHost;
          const approved = await withPromptSignal(pi, () =>
            ctx.ui.confirm(`Sandbox blocked network access to ${target}`, "\nAllow for this session?"),
          );
          if (!approved) return false;

          const latestConfig = getStateRuntimeConfig(sandboxState);
          if (!latestConfig) return false;
          if (latestConfig.network.deniedDomains.includes(normalizedHost)) {
            notify(
              ctx,
              `Network access to ${normalizedHost} remains denied by current sandbox policy. Remove it from deny list to allow.`,
              "warning",
            );
            return false;
          }
          if (latestConfig.network.allowedDomains.includes(normalizedHost)) return true;

          const nextConfig = cloneRuntimeConfig(latestConfig);
          const changed = mutateStringList(nextConfig.network.allowedDomains, "add", normalizedHost);
          if (changed) {
            applyRuntimeConfigForSession(ctx, nextConfig);
          }

          notify(ctx, `Allowed network domain for this session: ${normalizedHost}`, "info");
          return true;
        } catch (error) {
          const ctx = sessionContext;
          const message = `Sandbox permission prompt failed for ${normalizedHost}: ${error instanceof Error ? error.message : error}`;
          if (ctx) notify(ctx, message, "warning");
          else console.warn(message);
          return false;
        }
      })();

      pendingNetworkApprovals.set(key, decision);
      try {
        return await decision;
      } finally {
        pendingNetworkApprovals.delete(key);
      }
    };
  };

  const initializeSandboxRuntime = async (ctx: ExtensionContext, config: SandboxConfig): Promise<SandboxRuntimeConfig | null> => {
    promptMode = normalizePromptMode(config.mode);
    const runtimeConfig = toRuntimeConfig(config);

    try {
      await SandboxManager.initialize(runtimeConfig, createNetworkAskCallback(), true);
      const activeConfig = cloneRuntimeConfig(runtimeConfig);
      sandboxState = { status: "active", runtimeConfig: activeConfig };
      return activeConfig;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : `${err}`;
      promptMode = DEFAULT_PROMPT_MODE;
      pendingNetworkApprovals.clear();
      sandboxState = { status: "blocked", reason: "init-failed" };
      setSandboxStatus(ctx, false);
      notify(ctx, `Sandbox initialization failed: ${errorMessage}`, "error");
      return null;
    }
  };

  const sandboxedOps = createSandboxedBashOps({
    pi,
    getContext: () => sessionContext,
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    getPromptMode: () => promptMode,
    getCwd: () => sessionCwd,
    applyRuntimeConfigForSession,
  });

  let localBashTool = createBashTool(sessionCwd);
  let sandboxedBashTool = createBashTool(sessionCwd, { operations: sandboxedOps });

  const rebuildBashTools = (cwd: string): void => {
    sessionCwd = cwd;
    localBashTool = createBashTool(sessionCwd);
    sandboxedBashTool = createBashTool(sessionCwd, { operations: sandboxedOps });
  };

  const resetRuntimeState = (): void => {
    sandboxState = { status: "pending" };
    promptMode = DEFAULT_PROMPT_MODE;
    pendingNetworkApprovals.clear();
  };

  const isSupportedPlatform = (): boolean => process.platform === "darwin" || process.platform === "linux";

  pi.registerTool({
    ...localBashTool,
    label: "bash (sandbox-aware)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (sandboxState.status !== "active") {
        const allowsUnsandboxed = sandboxState.status === "bypassed" || sandboxState.status === "suspended";
        if (!allowsUnsandboxed) {
          const runMode = getSandboxRunMode(sandboxState);

          let reason = "Sandbox is not active and unsandboxed execution is blocked. Fix sandbox setup and run /sandbox enable, or restart with --no-sandbox.";
          if (runMode === "unsupported-platform") {
            reason = "Sandbox is unsupported on this platform. Re-run with --no-sandbox to allow unsandboxed execution.";
          } else if (runMode === "init-failed") {
            reason = "Sandbox initialization failed. Run /sandbox enable to retry, or restart with --no-sandbox.";
          } else if (runMode === "sandbox") {
            reason = "Sandbox session initialization is incomplete. Retry after session startup or run /sandbox enable.";
          }

          throw new Error(reason);
        }
        return localBashTool.execute(id, params, signal, onUpdate);
      }

      if (!sessionContext) sessionContext = ctx;
      return sandboxedBashTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    setSandboxStatus(ctx, false);
    sessionContext = ctx;
    resetRuntimeState();
    rebuildBashTools(ctx.cwd);

    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    if (noSandbox) {
      sandboxState = { status: "bypassed", reason: "no-sandbox-flag" };
      notify(ctx, "Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      sandboxState = { status: "bypassed", reason: "config-disabled" };
      notify(ctx, "Sandbox disabled via config", "info");
      return;
    }

    if (!isSupportedPlatform()) {
      sandboxState = { status: "blocked", reason: "unsupported-platform" };
      notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
      return;
    }

    const runtimeConfig = await initializeSandboxRuntime(ctx, config);
    if (!runtimeConfig) return;

    setSandboxStatus(ctx, true, runtimeConfig, promptMode);
    notify(ctx, "Sandbox initialized", "info");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    setSandboxStatus(ctx, false);
    if (getStateRuntimeConfig(sandboxState)) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }

    resetRuntimeState();
    sessionContext = null;
    rebuildBashTools(process.cwd());
  });

  pi.registerCommand("sandbox", {
    description: "Manage sandbox runtime overrides",
    handler: async (args, ctx) => {
      const tokens = parseCommandArgs(args);
      const subcommand = tokens[0]?.toLowerCase();

      if (!subcommand || subcommand === "help") {
        showHelp(ctx);
        return;
      }

      if (subcommand === "enable") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox enable", "warning");
          return;
        }

        if (sandboxState.status === "active") {
          notify(ctx, "Sandbox is already enabled", "info");
          return;
        }

        let runtimeConfig: SandboxRuntimeConfig | null = null;
        let initializedNow = false;

        if (sandboxState.status === "suspended") {
          runtimeConfig = sandboxState.runtimeConfig;
        } else {
          if (!isSupportedPlatform()) {
            sandboxState = { status: "blocked", reason: "unsupported-platform" };
            notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
            return;
          }

          const config = loadConfig(ctx.cwd);
          runtimeConfig = await initializeSandboxRuntime(ctx, config);
          if (!runtimeConfig) return;
          initializedNow = true;
        }

        if (!runtimeConfig) return;

        if (initializedNow) {
          setSandboxStatus(ctx, true, runtimeConfig, promptMode);
        } else {
          applyRuntimeConfigForSession(ctx, runtimeConfig, "active");
        }

        notify(ctx, "Sandbox enabled for this session", "info");
        return;
      }

      if (subcommand === "disable") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox disable", "warning");
          return;
        }

        if (sandboxState.status !== "active") {
          notify(ctx, `Sandbox is not active (mode: ${getSandboxRunMode(sandboxState)})`, "info");
          return;
        }

        sandboxState = { status: "suspended", runtimeConfig: sandboxState.runtimeConfig };
        setSandboxStatus(ctx, false);
        notify(ctx, "Sandbox disabled for this session", "info");
        return;
      }

      if (subcommand === "show") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox show", "warning");
          return;
        }

        if (sandboxState.status !== "active") {
          notify(ctx, `Sandbox is disabled (mode: ${getSandboxRunMode(sandboxState)})`, "info");
          return;
        }

        const runtimeConfig = sandboxState.runtimeConfig;
        const lines = [
          "Sandbox Configuration (session):",
          `  State: enabled`,
          `  Mode: ${promptMode}`,
          `  Runtime state: ${getSandboxRunMode(sandboxState)}`,
          "",
          "  Network:",
          `    Allowed: ${runtimeConfig.network.allowedDomains.join(", ") || "(none)"}`,
          `    Denied: ${runtimeConfig.network.deniedDomains.join(", ") || "(none)"}`,
          "",
          "  Filesystem:",
          `    Deny Read: ${runtimeConfig.filesystem.denyRead.join(", ") || "(none)"}`,
          `    Allow Write: ${runtimeConfig.filesystem.allowWrite.join(", ") || "(none)"}`,
          `    Deny Write: ${runtimeConfig.filesystem.denyWrite.join(", ") || "(none)"}`,
          "",
          "  Advanced:",
          `    ignoreViolations: ${runtimeConfig.ignoreViolations ? "configured" : "(none)"}`,
          `    enableWeakerNestedSandbox: ${runtimeConfig.enableWeakerNestedSandbox ? "true" : "false"}`,
          `    enableWeakerNetworkIsolation: ${runtimeConfig.enableWeakerNetworkIsolation ? "true" : "false"}`,
        ];

        notify(ctx, lines.join("\n"), "info");
        return;
      }

      if (subcommand === "mode") {
        if (tokens.length !== 2) {
          notify(ctx, "Usage: /sandbox mode <interactive|non-interactive>", "warning");
          return;
        }

        const modeToken = tokens[1].toLowerCase();
        if (modeToken !== "interactive" && modeToken !== "non-interactive") {
          notify(ctx, "Usage: /sandbox mode <interactive|non-interactive>", "warning");
          return;
        }

        promptMode = normalizePromptMode(modeToken);

        if (sandboxState.status === "active") {
          setSandboxStatus(ctx, true, sandboxState.runtimeConfig, promptMode);
        }

        notify(ctx, `Sandbox mode set to ${promptMode}`, "info");
        return;
      }

      if (subcommand === "network") {
        const runtimeConfig = requireRuntimeConfig(ctx, sandboxState);
        if (!runtimeConfig) return;

        const list = tokens[1]?.toLowerCase() as NetworkList | undefined;
        const op = tokens[2]?.toLowerCase() as ListOp | undefined;
        const domain = tokens[3]?.trim() ?? "";

        if (
          (list !== "allow" && list !== "deny") ||
          (op !== "add" && op !== "remove") ||
          tokens.length !== 4 ||
          !domain ||
          /\s/.test(domain)
        ) {
          notify(ctx, "Usage: /sandbox network <allow|deny> <add|remove> <domain>", "warning");
          return;
        }

        const nextConfig = cloneRuntimeConfig(runtimeConfig);
        const values = list === "allow" ? nextConfig.network.allowedDomains : nextConfig.network.deniedDomains;
        const changed = mutateStringList(values, op, domain);
        if (!changed) {
          notify(ctx, `No change: network ${list} list already ${op === "add" ? "contains" : "omits"} ${domain}`);
          return;
        }

        applyRuntimeConfigForSession(ctx, nextConfig);
        notify(ctx, `Updated network ${list} list (${op}: ${domain})`, "info");
        return;
      }

      if (subcommand === "filesystem") {
        const runtimeConfig = requireRuntimeConfig(ctx, sandboxState);
        if (!runtimeConfig) return;

        const list = tokens[1]?.toLowerCase() as FilesystemList | undefined;
        const op = tokens[2]?.toLowerCase() as ListOp | undefined;
        const targetPath = tokens.slice(3).join(" ").trim();

        if (
          (list !== "deny-read" && list !== "allow-write" && list !== "deny-write") ||
          (op !== "add" && op !== "remove") ||
          !targetPath
        ) {
          notify(
            ctx,
            "Usage: /sandbox filesystem <deny-read|allow-write|deny-write> <add|remove> <path>",
            "warning",
          );
          return;
        }

        const nextConfig = cloneRuntimeConfig(runtimeConfig);
        const values =
          list === "deny-read"
            ? nextConfig.filesystem.denyRead
            : list === "allow-write"
              ? nextConfig.filesystem.allowWrite
              : nextConfig.filesystem.denyWrite;
        const changed = mutateStringList(values, op, targetPath);
        if (!changed) {
          notify(
            ctx,
            `No change: filesystem ${list} list already ${op === "add" ? "contains" : "omits"} ${targetPath}`,
          );
          return;
        }

        applyRuntimeConfigForSession(ctx, nextConfig);
        notify(ctx, `Updated filesystem ${list} list (${op}: ${targetPath})`, "info");
        return;
      }

      notify(ctx, `Unknown subcommand: ${subcommand}. Use /sandbox for help`, "error");
    },
  });
}
