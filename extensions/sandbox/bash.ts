import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  createLocalBashOperations,
  type BashOperations,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  cloneRuntimeConfig,
  inferSandboxRuleMatch,
  isSandboxWritablePath,
  mutateStringList,
  type PromptMode,
  type SandboxConfig,
} from "./config.js";
import type { PermissionResolution } from "./permissions/dialog.js";
import {
  detectFilesystemViolationFromLine,
  extractAppendedSandboxAnnotation,
  formatRuntimeProtectedWriteNotice,
  formatTraversalNotice,
  getRuntimeProtectedWriteViolations,
  getTraversalPaths,
  handleFilesystemViolation,
  isRuntimeProtectedWriteViolation,
  isTraversalViolation,
  type FilesystemViolation,
} from "./permissions/filesystem.js";
import {
  detectMachLookupViolations,
  handleMachLookupViolation,
} from "./permissions/mach-lookup.js";
import {
  formatUnsandboxedApproval,
  UNSANDBOXED_APPROVAL_CHOICES,
} from "./permissions/unsandboxed.js";
import { notify, type SandboxEvent, type SandboxRuntime } from "./runtime.js";

const IS_MACOS = process.platform === "darwin";
const MACOS_SANDBOX_SHELL = fileURLToPath(new URL("./macos-sandbox-shell.mjs", import.meta.url));
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const GIT_FILESYSTEM_PATHS_CACHE = new Map<string, GitFilesystemPaths | null>();

interface GitFilesystemPaths {
  gitDir: string;
  gitCommonDir: string;
}

function resolveGitFilesystemPaths(cwd: string): GitFilesystemPaths | null {
  if (GIT_FILESYSTEM_PATHS_CACHE.has(cwd)) {
    return GIT_FILESYSTEM_PATHS_CACHE.get(cwd) ?? null;
  }

  const result = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  if (result.status !== 0) {
    GIT_FILESYSTEM_PATHS_CACHE.set(cwd, null);
    return null;
  }

  const [gitDir, gitCommonDir] = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!gitDir || !gitCommonDir) {
    GIT_FILESYSTEM_PATHS_CACHE.set(cwd, null);
    return null;
  }

  const gitPaths = { gitDir, gitCommonDir };
  GIT_FILESYSTEM_PATHS_CACHE.set(cwd, gitPaths);
  return gitPaths;
}

function maybeAddGitMetadataWritePath(
  runtimeConfig: SandboxRuntimeConfig,
  path: string,
  cwd?: string,
): SandboxRuntimeConfig | null {
  if (isSandboxWritablePath(runtimeConfig, path, cwd)) return null;
  if (inferSandboxRuleMatch(path, runtimeConfig.filesystem.denyWrite, cwd)) return null;

  const nextConfig = cloneRuntimeConfig(runtimeConfig);
  if (!mutateStringList(nextConfig.filesystem.allowWrite, "add", path)) return null;
  return nextConfig;
}

function appendOutputPostamble(postamble: string, addition: string, output: string): string {
  if (!addition) return postamble;

  const needsSeparator =
    postamble.length > 0 ? !postamble.endsWith("\n") : output.length > 0 && !output.endsWith("\n");

  return `${postamble}${needsSeparator ? "\n" : ""}${addition}`;
}

function ensureTrailingNewline(text: string): string {
  if (!text || text.endsWith("\n")) return text;
  return `${text}\n`;
}

interface SandboxedBashOpsOptions {
  getContext: () => ExtensionContext | null;
  getSandboxConfig: () => SandboxConfig | null;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  getPromptMode: () => PromptMode;
  applyRuntimeConfigForSession: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent?: (event: SandboxEvent) => void;
}

interface SandboxedBashOperations extends BashOperations {
  runSerially<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

interface BashAttemptResult {
  exitCode: number | null;
  combinedOutput: string;
  interruptedByFilesystemViolation: boolean;
  runtimeProtectedWriteViolations: FilesystemViolation[];
}

interface ProcessedSandboxAttempt {
  exitCode: number | null;
  postamble: string;
  resolution: PermissionResolution | null;
  runtimeProtectedWriteViolations: FilesystemViolation[];
}

interface PreparedSandboxAttempt {
  attempt: BashAttemptResult;
  commandId: string;
  runtimeConfig: SandboxRuntimeConfig | null;
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGKILL",
): void {
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

let sandboxAttemptSequence = 0;

function createSandboxCommandId(): string {
  sandboxAttemptSequence += 1;
  return `tau-${process.pid}-${sandboxAttemptSequence}`;
}

function safeCleanupAfterCommand(): void {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    // Ignore cleanup errors.
  }
}

function maybeAllowGitMetadataWriteForSession(options: {
  ctx: ExtensionContext | null;
  cwd: string;
  runtimeConfig: SandboxRuntimeConfig | null;
  allowGitCommonDir: boolean;
  applyRuntimeConfigForSession: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
}): void {
  const { ctx, cwd, runtimeConfig, allowGitCommonDir, applyRuntimeConfigForSession } = options;
  if (!ctx || !runtimeConfig) return;
  if (!isSandboxWritablePath(runtimeConfig, cwd, cwd)) return;

  const gitPaths = resolveGitFilesystemPaths(cwd);
  if (!gitPaths) return;

  let nextConfig = maybeAddGitMetadataWritePath(runtimeConfig, gitPaths.gitDir, cwd);
  if (allowGitCommonDir && gitPaths.gitCommonDir !== gitPaths.gitDir) {
    nextConfig =
      maybeAddGitMetadataWritePath(nextConfig ?? runtimeConfig, gitPaths.gitCommonDir, cwd) ??
      nextConfig;
  }

  if (!nextConfig) return;
  applyRuntimeConfigForSession(ctx, nextConfig);
}

/** Create a single-invocation native backend whose approval covers the resolved spawn context. */
export function createUnsandboxedBashOps(
  runtime: SandboxRuntime,
  sandboxedOps: SandboxedBashOperations,
  ctx: ExtensionContext,
  invocationSignal: AbortSignal,
): BashOperations {
  function assertAvailable(): void {
    if (invocationSignal.aborted) throw new Error("aborted");
    if (runtime.state.status !== "active") {
      throw new Error("Unsandboxed request denied: the sandbox must be active.");
    }
    if (runtime.promptMode !== "interactive" || !ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) {
      throw new Error("Unsandboxed request denied: interactive human approval is required.");
    }
    if (
      ctx.mode === "rpc" &&
      process.env.PI_SUBAGENT === "1" &&
      process.env.TAU_SUBAGENT_UNSANDBOXED_APPROVAL !== "1"
    ) {
      throw new Error(
        "Unsandboxed request denied: the parent does not advertise a safe approval broker. Reload the parent and start a new subagent before requesting approval.",
      );
    }
  }

  assertAvailable();
  const local = createLocalBashOperations();
  return {
    exec(command, cwd, options) {
      const absoluteCwd = resolve(cwd);
      return sandboxedOps.runSerially(async () => {
        assertAvailable();
        if (options.signal?.aborted) throw new Error("aborted");
        const title = formatUnsandboxedApproval(command, absoluteCwd);
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select(title, [...UNSANDBOXED_APPROVAL_CHOICES], {
            signal: invocationSignal,
          });
        } catch (error) {
          throw new Error("Unsandboxed request denied: human approval was unavailable.", {
            cause: error,
          });
        }
        assertAvailable();
        if (options.signal?.aborted) throw new Error("aborted");
        if (choice !== "Run once outside sandbox") {
          throw new Error("Unsandboxed request denied: this invocation was not approved.");
        }
        return local.exec(command, absoluteCwd, options);
      }, invocationSignal);
    },
  };
}

export function createSandboxedBashOps(options: SandboxedBashOpsOptions): SandboxedBashOperations {
  const {
    getContext,
    getSandboxConfig,
    getRuntimeConfig,
    getPromptMode,
    applyRuntimeConfigForSession,
    recordEvent,
  } = options;
  const pendingFilesystemDialogs = new Map<string, Promise<PermissionResolution | null>>();
  const pendingMachLookupDialogs = new Map<string, Promise<PermissionResolution | null>>();

  let executionQueue: Promise<void> = Promise.resolve();

  function runSerially<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let pending = true;
      const cancel = () => {
        if (!pending) return;
        pending = false;
        signal?.removeEventListener("abort", cancel);
        reject(new Error("aborted"));
      };
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      const start = async () => {
        if (!pending) return;
        pending = false;
        signal?.removeEventListener("abort", cancel);
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      };
      executionQueue = executionQueue.then(start, start);
    });
  }

  function withSandboxDefaultEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const baseEnv = env ?? process.env;
    if (baseEnv.GIT_OPTIONAL_LOCKS !== undefined) return baseEnv;
    return { ...baseEnv, GIT_OPTIONAL_LOCKS: "0" };
  }

  async function runSandboxAttempt(
    commandId: string,
    wrappedCommand: string,
    cwd: string,
    runtimeConfig: SandboxRuntimeConfig | null,
    onData: (data: Buffer) => void,
    signal?: AbortSignal,
    timeout?: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<BashAttemptResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", wrappedCommand], {
        cwd,
        env: withSandboxDefaultEnv(env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let timedOut = false;
      let interruptedByFilesystemViolation = false;
      let seenViolationCount = 0;
      const runtimeProtectedWriteViolations = new Map<string, FilesystemViolation>();
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timeoutEscalationHandle: NodeJS.Timeout | undefined;
      let filesystemStopEscalationHandle: NodeJS.Timeout | undefined;

      const stopForFilesystemViolation = (): void => {
        if (interruptedByFilesystemViolation) return;

        interruptedByFilesystemViolation = true;
        killProcessGroup(child, "SIGTERM");
        filesystemStopEscalationHandle = setTimeout(() => {
          killProcessGroup(child, "SIGKILL");
        }, 500);
      };

      // The Linux monitor filters attempts against configured write rules and does not
      // report mandatory runtime denies within already-allowed paths, so runtime-protected
      // continuation remains macOS-only.
      const unsubscribeViolations =
        process.platform !== "darwin"
          ? () => undefined
          : SandboxManager.getSandboxViolationStore().subscribe(() => {
              const violations =
                SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
              if (violations.length <= seenViolationCount) return;

              const newViolations = violations.slice(seenViolationCount);
              seenViolationCount = violations.length;

              for (const violation of newViolations) {
                const filesystemViolation = detectFilesystemViolationFromLine(violation.line);
                if (filesystemViolation) {
                  if (isTraversalViolation(runtimeConfig, filesystemViolation, cwd)) continue;

                  if (isRuntimeProtectedWriteViolation(runtimeConfig, filesystemViolation, cwd)) {
                    if (filesystemViolation.path) {
                      runtimeProtectedWriteViolations.set(
                        filesystemViolation.path,
                        filesystemViolation,
                      );
                    }
                    continue;
                  }

                  stopForFilesystemViolation();
                }
              }
            });

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
        if (filesystemStopEscalationHandle) clearTimeout(filesystemStopEscalationHandle);
        unsubscribeViolations();
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
        if (filesystemStopEscalationHandle) clearTimeout(filesystemStopEscalationHandle);
        unsubscribeViolations();
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }

        resolve({
          exitCode: interruptedByFilesystemViolation && code === null ? 1 : code,
          combinedOutput: Buffer.concat(chunks).toString("utf-8"),
          interruptedByFilesystemViolation,
          runtimeProtectedWriteViolations: Array.from(runtimeProtectedWriteViolations.values()),
        });
      });
    });
  }

  function validateTimeout(timeout: number | undefined): void {
    if (timeout === undefined) return;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("Invalid timeout: must be a finite number of seconds");
    }
    if (timeout * 1000 > MAX_TIMEOUT_MS) {
      throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
    }
  }

  function getRemainingTimeout(timeout: number | undefined, startedAt: number): number | undefined {
    if (timeout === undefined) return undefined;

    return Math.max(0, timeout - (Date.now() - startedAt) / 1000);
  }

  function reportPostProcessingError(error: unknown): void {
    const message = `[sandbox] Post-processing error: ${error instanceof Error ? error.message : error}`;
    const ctx = getContext();
    if (ctx) notify(ctx, message, "warning");
    else console.warn(message);
  }

  async function prepareAndRunSandboxAttempt(options: {
    command: string;
    cwd: string;
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<PreparedSandboxAttempt> {
    const { command, cwd, onData, signal, timeout, env } = options;

    maybeAllowGitMetadataWriteForSession({
      ctx: getContext(),
      cwd,
      runtimeConfig: getRuntimeConfig(),
      allowGitCommonDir: getSandboxConfig()?.filesystem.allowGitCommonDir === true,
      applyRuntimeConfigForSession,
    });

    const runtimeConfig = getRuntimeConfig();
    const attemptRuntimeConfig = runtimeConfig ? cloneRuntimeConfig(runtimeConfig) : null;
    const commandId = createSandboxCommandId();

    try {
      const wrappedCommand = await SandboxManager.wrapWithSandbox(
        command,
        IS_MACOS ? MACOS_SANDBOX_SHELL : undefined,
        attemptRuntimeConfig ?? undefined,
        signal,
        { commandId, commandText: command },
      );
      const attempt = await runSandboxAttempt(
        commandId,
        wrappedCommand,
        cwd,
        attemptRuntimeConfig,
        onData,
        signal,
        timeout,
        env,
      );
      return { attempt, commandId, runtimeConfig: attemptRuntimeConfig };
    } catch (err) {
      safeCleanupAfterCommand();
      throw err;
    }
  }

  async function processSandboxAttempt(options: {
    attempt: BashAttemptResult;
    command: string;
    commandId: string;
    cwd: string;
    runtimeConfig: SandboxRuntimeConfig | null;
    autoRetryAvailable: boolean;
  }): Promise<ProcessedSandboxAttempt> {
    const { attempt, command, commandId, cwd, runtimeConfig, autoRetryAvailable } = options;
    const annotatedOutput = SandboxManager.annotateStderrWithSandboxFailures(
      commandId,
      attempt.combinedOutput,
    );
    // Capture violations delivered after the child closed but before post-processing.
    const storedViolationLines = SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(commandId)
      .map((violation) => violation.line);
    const storedFilesystemViolations = storedViolationLines
      .map((line) => detectFilesystemViolationFromLine(line))
      .filter((violation): violation is FilesystemViolation => violation !== null);
    const runtimeProtectedWriteViolations = getRuntimeProtectedWriteViolations(
      runtimeConfig,
      [...attempt.runtimeProtectedWriteViolations, ...storedFilesystemViolations],
      cwd,
    );
    const machLookupViolations = detectMachLookupViolations(storedViolationLines);
    let postamble = extractAppendedSandboxAnnotation(attempt.combinedOutput, annotatedOutput);

    if (runtimeProtectedWriteViolations.length > 0) {
      const notice = formatRuntimeProtectedWriteNotice(
        runtimeProtectedWriteViolations,
        !attempt.interruptedByFilesystemViolation,
      );
      postamble = appendOutputPostamble(postamble, notice, attempt.combinedOutput);

      for (const violation of runtimeProtectedWriteViolations) {
        recordEvent?.({
          timestamp: Date.now(),
          kind: "filesystem",
          outcome: "blocked",
          reason: "runtime-protected-write",
          target: violation.path,
          command,
          cwd,
          summary: "filesystem write is protected by the sandbox runtime",
        });
      }
    }

    const commandSucceeded = attempt.exitCode === 0 && !attempt.interruptedByFilesystemViolation;
    if (commandSucceeded) {
      return {
        exitCode: attempt.exitCode,
        postamble,
        resolution: null,
        runtimeProtectedWriteViolations,
      };
    }

    if (
      /\bsandbox-exec:\s+sandbox_apply:\s+Operation not permitted\b/i.test(attempt.combinedOutput)
    ) {
      const notice =
        "[sandbox] macOS sandbox initialization failed in a child process. An inherited sandbox can cause this.";
      recordEvent?.({
        timestamp: Date.now(),
        kind: "runtime",
        outcome: "blocked",
        reason: "init-failed",
        command,
        cwd,
        summary: "command reported a sandbox initialization failure",
      });
      return {
        exitCode: attempt.exitCode,
        postamble: appendOutputPostamble(postamble, notice, attempt.combinedOutput),
        resolution: null,
        runtimeProtectedWriteViolations,
      };
    }

    const traversalPaths = getTraversalPaths({
      runtimeConfig,
      output: annotatedOutput,
      cwd,
    });
    const continuedTraversal = machLookupViolations.length === 0 ? traversalPaths : null;
    const effectiveExitCode = continuedTraversal ? 0 : attempt.exitCode;
    let resolution: PermissionResolution | null = null;

    if (continuedTraversal) {
      const notice = formatTraversalNotice(continuedTraversal);
      postamble = appendOutputPostamble(postamble, notice, attempt.combinedOutput);
    } else {
      const currentRuntimeConfig = getRuntimeConfig();
      if (!currentRuntimeConfig) {
        return {
          exitCode: effectiveExitCode,
          postamble,
          resolution,
          runtimeProtectedWriteViolations,
        };
      }

      resolution = await handleFilesystemViolation({
        ctx: getContext(),
        promptMode: getPromptMode(),
        runtimeConfig: currentRuntimeConfig,
        getRuntimeConfig,
        output: annotatedOutput,
        rawOutput: attempt.combinedOutput,
        command,
        cwd,
        pendingDialogs: pendingFilesystemDialogs,
        applyRuntimeConfigForSession,
        recordEvent,
        autoRetryAvailable,
        runtimeProtectedWriteViolations,
        allowOutputFallback: machLookupViolations.length === 0,
      });

      if (!resolution) {
        resolution = await handleMachLookupViolation({
          ctx: getContext(),
          promptMode: getPromptMode(),
          runtimeConfig: currentRuntimeConfig,
          violations: machLookupViolations,
          command,
          cwd,
          pendingDialogs: pendingMachLookupDialogs,
          applyRuntimeConfigForSession,
          recordEvent,
          autoRetryAvailable,
        });
      }

      if (resolution) {
        postamble = appendOutputPostamble(postamble, resolution.message, attempt.combinedOutput);
      }
    }

    return {
      exitCode: effectiveExitCode,
      postamble,
      resolution,
      runtimeProtectedWriteViolations,
    };
  }

  return {
    runSerially,
    async exec(command, cwd, { onData, signal, timeout, env }) {
      validateTimeout(timeout);
      return runSerially(async () => {
        if (!existsSync(cwd)) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }

        const attemptStartedAt = Date.now();
        const initialRun = await prepareAndRunSandboxAttempt({
          command,
          cwd,
          onData,
          signal,
          timeout,
          env,
        });
        const retryTimeout = getRemainingTimeout(timeout, attemptStartedAt);

        let processedAttempt: ProcessedSandboxAttempt;
        try {
          processedAttempt = await processSandboxAttempt({
            attempt: initialRun.attempt,
            command,
            commandId: initialRun.commandId,
            cwd,
            runtimeConfig: initialRun.runtimeConfig,
            autoRetryAvailable: true,
          });
        } catch (postProcessError) {
          reportPostProcessingError(postProcessError);
          safeCleanupAfterCommand();
          return { exitCode: initialRun.attempt.exitCode };
        }

        const retryResolution = processedAttempt.resolution;
        if (retryResolution?.kind !== "allow-retry") {
          if (processedAttempt.postamble) onData(Buffer.from(processedAttempt.postamble));
          safeCleanupAfterCommand();
          return { exitCode: processedAttempt.exitCode };
        }

        if (processedAttempt.postamble) {
          onData(Buffer.from(ensureTrailingNewline(processedAttempt.postamble)));
        }

        initialRun.attempt.combinedOutput = "";
        safeCleanupAfterCommand();

        if (retryTimeout !== undefined && retryTimeout <= 0) {
          onData(Buffer.from(retryResolution.retrySkippedMessage));
          return { exitCode: processedAttempt.exitCode };
        }

        const retryRun = await prepareAndRunSandboxAttempt({
          command,
          cwd,
          onData,
          signal,
          timeout: retryTimeout,
          env,
        });

        let processedRetry: ProcessedSandboxAttempt;
        try {
          processedRetry = await processSandboxAttempt({
            attempt: retryRun.attempt,
            command,
            commandId: retryRun.commandId,
            cwd,
            runtimeConfig: retryRun.runtimeConfig,
            autoRetryAvailable: false,
          });
        } catch (postProcessError) {
          reportPostProcessingError(postProcessError);
          safeCleanupAfterCommand();
          return { exitCode: retryRun.attempt.exitCode };
        }

        let retryPostamble = processedRetry.postamble;
        if (processedRetry.exitCode === 0) {
          retryPostamble = appendOutputPostamble(
            retryPostamble,
            retryResolution.retrySuccessMessage,
            retryRun.attempt.combinedOutput,
          );
        } else if (
          !processedRetry.resolution &&
          processedRetry.runtimeProtectedWriteViolations.length === 0
        ) {
          retryPostamble = appendOutputPostamble(
            retryPostamble,
            retryResolution.retryFailureMessage,
            retryRun.attempt.combinedOutput,
          );
        }

        if (retryPostamble) onData(Buffer.from(retryPostamble));
        safeCleanupAfterCommand();
        return { exitCode: processedRetry.exitCode };
      }, signal);
    },
  };
}
