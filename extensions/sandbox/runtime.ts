import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_PROMPT_MODE,
  SandboxConfigLoadError,
  cloneRuntimeConfig,
  getSandboxConfigParseErrors,
  getSkippedUntrustedProjectConfigPaths,
  loadConfig,
  normalizePromptMode,
  toRuntimeConfig,
  type LoadedSandboxConfig,
  type PromptMode,
  type SandboxConfig,
  type SandboxConfigPath,
} from "./config.js";
import { createNetworkPermissions } from "./permissions/network.js";
import { isUnsandboxedApproval, showUnsandboxedApproval } from "./permissions/unsandboxed.js";

const STATUS_KEY = "sandbox";
const SANDBOX_EVENT_LIMIT = 50;

type UiLevel = "info" | "warning" | "error";

export type SandboxEventOutcome = "blocked" | "allowed";
type SandboxBypassReason = "no-sandbox-flag" | "config-disabled";
type SandboxBlockedReason = "unsupported-platform" | "init-failed" | "missing-dependencies";
type SandboxRunMode = "sandbox" | "user-disabled" | SandboxBypassReason | SandboxBlockedReason;

export type SandboxState =
  | { status: "pending" }
  | { status: "active"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "suspended" }
  | { status: "bypassed"; reason: SandboxBypassReason }
  | { status: "blocked"; reason: SandboxBlockedReason };

type SandboxEventKind = "filesystem" | "network" | "mach-lookup" | "init" | "runtime";
export type SandboxEventReason =
  | "explicit-deny-read"
  | "explicit-deny-write"
  | "explicit-deny-domain"
  | "missing-allow-write"
  | "missing-allowed-domain"
  | "missing-mach-lookup"
  | "missing-dependencies"
  | "unsupported-platform"
  | "init-failed"
  | "runtime-protected-write"
  | "already-approved-still-failed"
  | "unknown";

export interface SandboxEvent {
  timestamp: number;
  kind: SandboxEventKind;
  outcome: SandboxEventOutcome;
  reason: SandboxEventReason;
  target?: string;
  command?: string;
  cwd?: string;
  summary: string;
  suggestedCommand?: string;
}

export interface SandboxRuntime {
  readonly state: SandboxState;
  readonly config: SandboxConfig | null;
  readonly promptMode: PromptMode;
  readonly context: ExtensionContext | null;
  readonly configPaths: SandboxConfigPath[];
  readonly events: SandboxEvent[];
  getRuntimeConfig(): SandboxRuntimeConfig | null;
  captureContext(ctx: ExtensionContext): void;
  withPermissionContext<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    run: (ctx: ExtensionContext, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  start(ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  enable(ctx: ExtensionContext): Promise<void>;
  disable(ctx: ExtensionContext): Promise<void>;
  setPromptMode(ctx: ExtensionContext, mode: PromptMode): void;
  applyRuntimeConfigForSession(ctx: ExtensionContext, runtimeConfig: SandboxRuntimeConfig): void;
  recordEvent(event: SandboxEvent): void;
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
  const text = `sandbox (${promptMode}, ${networkCount} domains, ${writeCount} write paths)`;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
}

export function notify(ctx: ExtensionContext, text: string, level: UiLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }

  if (level === "error" || level === "warning") console.error(text);
  else console.log(text);
}

function announceSandboxState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  enabled: boolean,
  notification?: string,
  level: UiLevel = "info",
): void {
  const text = `Sandbox ${enabled ? "enabled" : "disabled"}`;
  notify(ctx, notification ?? text, level);
  pi.sendMessage(
    {
      customType: "sandbox-state",
      content: text,
      display: false,
    },
    { triggerTurn: false },
  );
}

function getStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getSandboxRunMode(state: SandboxState): SandboxRunMode {
  if (state.status === "active" || state.status === "pending") return "sandbox";
  if (state.status === "suspended") return "user-disabled";
  return state.reason;
}

function getStateRuntimeConfig(state: SandboxState): SandboxRuntimeConfig | null {
  return state.status === "active" ? state.runtimeConfig : null;
}

export function formatSandboxEventTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function describeSandboxRuntimeState(state: SandboxState, promptMode: PromptMode): string {
  if (state.status === "active") return `active (${promptMode})`;
  if (state.status === "pending") return "pending";
  if (state.status === "suspended") return `suspended (${promptMode})`;
  if (state.status === "bypassed") {
    if (state.reason === "no-sandbox-flag") return "bypassed (--no-sandbox)";
    return "bypassed (config disabled)";
  }
  if (state.reason === "missing-dependencies") return "blocked (missing dependencies)";
  return state.reason === "unsupported-platform"
    ? "blocked (unsupported platform)"
    : "blocked (init failed)";
}

function notifySandboxConfigParseErrors(ctx: ExtensionContext, paths: SandboxConfigPath[]): void {
  const details = paths
    .map((configPath) => `${configPath.label.toLowerCase()} (${configPath.path})`)
    .join(", ");
  notify(ctx, `Could not parse sandbox config: ${details}`, "warning");
}

function requestShutdownWithError(ctx: ExtensionContext, message: string): void {
  // Validate during session_start so we can use Pi's registered flag values and shutdown path.
  // This briefly renders startup UI, but Pi exits through its normal cleanup path instead of
  // leaving the terminal in a broken state.
  notify(ctx, message, "error");
  process.exitCode = 1;
  ctx.shutdown();
}

function loadSandboxConfigForContext(
  ctx: ExtensionContext,
  cwd: string,
  overrideConfigPath: string | undefined,
  options: { exitOnError?: boolean } = {},
): LoadedSandboxConfig | null {
  const { exitOnError = false } = options;

  try {
    return loadConfig(cwd, overrideConfigPath, { projectTrusted: ctx.isProjectTrusted() });
  } catch (error) {
    if (!(error instanceof SandboxConfigLoadError)) throw error;

    if (exitOnError) {
      requestShutdownWithError(ctx, error.message);
    } else {
      notify(ctx, error.message, "error");
    }
    return null;
  }
}

function getSandboxDependencyErrors(config: SandboxConfig): string[] {
  return SandboxManager.checkDependencies(config.ripgrep).errors;
}

function isSupportedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function createSandboxRuntime(pi: ExtensionAPI): SandboxRuntime {
  let sessionCwd = process.cwd();
  let sandboxState: SandboxState = { status: "pending" };
  let sandboxConfig: SandboxConfig | null = null;
  let promptMode: PromptMode = DEFAULT_PROMPT_MODE;
  let sessionContext: ExtensionContext | null = null;
  let sandboxConfigPaths: SandboxConfigPath[] = [];
  let sandboxEvents: SandboxEvent[] = [];
  const warnedSkippedProjectConfigPaths = new Set<string>();
  let permissionLifetime = new AbortController();
  const permissionInvocations = new Set<Promise<unknown>>();

  function recordSandboxEvent(event: SandboxEvent): void {
    sandboxEvents.push(event);
    if (sandboxEvents.length > SANDBOX_EVENT_LIMIT) {
      sandboxEvents.splice(0, sandboxEvents.length - SANDBOX_EVENT_LIMIT);
    }
  }

  function recordRuntimeEvent(
    kind: SandboxEventKind,
    reason: SandboxEventReason,
    summary: string,
  ): void {
    recordSandboxEvent({
      timestamp: Date.now(),
      kind,
      outcome: "blocked",
      reason,
      cwd: sessionCwd,
      summary,
    });
  }

  function notifySkippedUntrustedProjectConfigs(ctx: ExtensionContext): void {
    const skippedConfigs = getSkippedUntrustedProjectConfigPaths(sandboxConfigPaths).filter(
      (configPath) => !warnedSkippedProjectConfigPaths.has(configPath.path),
    );
    if (skippedConfigs.length === 0) return;

    for (const configPath of skippedConfigs) {
      warnedSkippedProjectConfigPaths.add(configPath.path);
    }

    const details = skippedConfigs.map((configPath) => configPath.path).join(", ");
    notify(
      ctx,
      `Ignoring project sandbox config because this project is not trusted: ${details}`,
      "warning",
    );
  }

  function applyRuntimeConfigForSession(
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ): void {
    const nextConfig = cloneRuntimeConfig(runtimeConfig);
    sandboxState = { status: "active", runtimeConfig: nextConfig };
    SandboxManager.updateConfig(nextConfig);
    setSandboxStatus(ctx, true, nextConfig, promptMode);
  }

  const networkPermissions = createNetworkPermissions({
    getContext: () => sessionContext,
    getPromptMode: () => promptMode,
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    isSuspended: () => sandboxState.status === "suspended",
    applyRuntimeConfigForSession,
    recordEvent: (event) => {
      recordSandboxEvent({
        timestamp: Date.now(),
        kind: "network",
        cwd: sessionCwd,
        ...event,
      });
    },
    notify,
  });

  async function initializeSandboxRuntime(
    ctx: ExtensionContext,
    config: SandboxConfig,
  ): Promise<SandboxRuntimeConfig | null> {
    promptMode = normalizePromptMode(config.mode);

    const dependencyErrors = getSandboxDependencyErrors(config);
    if (dependencyErrors.length > 0) {
      promptMode = DEFAULT_PROMPT_MODE;
      networkPermissions.clear();
      sandboxState = { status: "blocked", reason: "missing-dependencies" };
      recordRuntimeEvent(
        "init",
        "missing-dependencies",
        `sandbox dependencies missing: ${dependencyErrors.join("; ")}`,
      );
      setSandboxStatus(ctx, false);
      notify(
        ctx,
        `Sandbox dependencies missing: ${dependencyErrors.join("; ")}. Shell execution is blocked until setup is fixed or sandboxing is explicitly disabled.`,
        "error",
      );
      return null;
    }

    const runtimeConfig = toRuntimeConfig(config);

    try {
      await SandboxManager.initialize(runtimeConfig, networkPermissions.ask, true);
      const activeConfig = cloneRuntimeConfig(runtimeConfig);
      sandboxState = { status: "active", runtimeConfig: activeConfig };
      return activeConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`;
      promptMode = DEFAULT_PROMPT_MODE;
      networkPermissions.clear();
      sandboxState = { status: "blocked", reason: "init-failed" };
      recordRuntimeEvent("init", "init-failed", `sandbox initialization failed: ${errorMessage}`);
      setSandboxStatus(ctx, false);
      notify(ctx, `Sandbox initialization failed: ${errorMessage}`, "error");
      return null;
    }
  }

  function resetRuntimeState(): void {
    sandboxState = { status: "pending" };
    sandboxConfig = null;
    promptMode = DEFAULT_PROMPT_MODE;
    sandboxConfigPaths = [];
    sandboxEvents = [];
    networkPermissions.clear();
  }

  function loadCurrentConfig(
    ctx: ExtensionContext,
    options: { exitOnError?: boolean } = {},
  ): SandboxConfig | null {
    const sandboxConfigOverride = getStringFlag(pi, "sandbox-config");
    const loadedConfig = loadSandboxConfigForContext(ctx, ctx.cwd, sandboxConfigOverride, options);
    if (!loadedConfig) return null;

    sandboxConfigPaths = loadedConfig.paths;
    notifySkippedUntrustedProjectConfigs(ctx);
    const parseErrors = getSandboxConfigParseErrors(sandboxConfigPaths);
    if (parseErrors.length > 0) {
      notifySandboxConfigParseErrors(ctx, parseErrors);
    }
    sandboxConfig = loadedConfig.config;
    return loadedConfig.config;
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    await cancelPermissionInvocations();
    permissionLifetime = new AbortController();
    setSandboxStatus(ctx, false);
    sessionContext = permissionContext(ctx);
    resetRuntimeState();
    sessionCwd = ctx.cwd;

    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    if (noSandbox) {
      sandboxState = { status: "bypassed", reason: "no-sandbox-flag" };
      announceSandboxState(pi, ctx, false, "Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadCurrentConfig(ctx, { exitOnError: true });
    if (!config) return;

    if (!config.enabled) {
      sandboxState = { status: "bypassed", reason: "config-disabled" };
      announceSandboxState(pi, ctx, false, "Sandbox disabled via config");
      return;
    }

    if (!isSupportedPlatform()) {
      sandboxState = { status: "blocked", reason: "unsupported-platform" };
      recordRuntimeEvent(
        "init",
        "unsupported-platform",
        `sandbox not supported on ${process.platform}`,
      );
      notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
      return;
    }

    const runtimeConfig = await initializeSandboxRuntime(ctx, config);
    if (!runtimeConfig) return;

    setSandboxStatus(ctx, true, runtimeConfig, promptMode);
    announceSandboxState(pi, ctx, true, "Sandbox initialized");
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    await cancelPermissionInvocations();
    setSandboxStatus(ctx, false);
    if (getStateRuntimeConfig(sandboxState)) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }

    resetRuntimeState();
    sessionContext = null;
    sessionCwd = process.cwd();
  }

  async function enable(ctx: ExtensionContext): Promise<void> {
    if (sandboxState.status === "active") {
      notify(ctx, "Sandbox is already enabled", "info");
      return;
    }

    if (!isSupportedPlatform()) {
      sandboxState = { status: "blocked", reason: "unsupported-platform" };
      recordRuntimeEvent(
        "init",
        "unsupported-platform",
        `sandbox not supported on ${process.platform}`,
      );
      notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
      return;
    }

    const config = loadCurrentConfig(ctx);
    if (!config) return;

    const runtimeConfig = await initializeSandboxRuntime(ctx, config);
    if (!runtimeConfig) return;

    setSandboxStatus(ctx, true, runtimeConfig, promptMode);
    announceSandboxState(pi, ctx, true);
  }

  async function disable(ctx: ExtensionContext): Promise<void> {
    if (sandboxState.status !== "active") {
      notify(ctx, `Sandbox is not active (mode: ${getSandboxRunMode(sandboxState)})`, "info");
      return;
    }

    sandboxState = { status: "suspended" };
    await cancelPermissionInvocations();
    permissionLifetime = new AbortController();
    networkPermissions.clear();
    setSandboxStatus(ctx, false);

    try {
      await SandboxManager.reset();
    } catch (error) {
      notify(
        ctx,
        `Sandbox disabled, but cleanup failed: ${error instanceof Error ? error.message : error}`,
        "warning",
      );
      return;
    }

    announceSandboxState(pi, ctx, false);
  }

  function setPromptMode(ctx: ExtensionContext, mode: PromptMode): void {
    if (promptMode !== mode) {
      permissionLifetime.abort();
      permissionLifetime = new AbortController();
    }
    promptMode = mode;
    if (sandboxState.status === "active") {
      setSandboxStatus(ctx, true, sandboxState.runtimeConfig, promptMode);
    }
  }

  /** Own invocation-local permission work until its dialog or command has settled. */
  function withPermissionContext<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    run: (ctx: ExtensionContext, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signals = [permissionLifetime.signal, ctx.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const combined = AbortSignal.any(signals);
    const invocationContext = permissionContext(ctx, combined);
    const invocation = (async () => {
      if (combined.aborted) throw new Error("aborted");
      return run(invocationContext, combined);
    })();
    permissionInvocations.add(invocation);
    return invocation.finally(() => permissionInvocations.delete(invocation));
  }

  async function cancelPermissionInvocations(): Promise<void> {
    permissionLifetime.abort();
    await Promise.allSettled(permissionInvocations);
  }

  function permissionContext(ctx: ExtensionContext, contextSignal = ctx.signal): ExtensionContext {
    function queued<T>(
      run: (signal?: AbortSignal) => Promise<T>,
      cancelled: T,
      signal?: AbortSignal,
    ): Promise<T> {
      const signals = [contextSignal, signal].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      const combined = signals.length ? AbortSignal.any(signals) : undefined;
      const guardedRun = async (queuedSignal?: AbortSignal): Promise<T> => {
        if (queuedSignal?.aborted) return cancelled;
        const result = await run(queuedSignal);
        return queuedSignal?.aborted ? cancelled : result;
      };
      const request = {
        run: guardedRun,
        signal: combined,
        result: undefined as Promise<T> | undefined,
      };
      pi.events.emit("subagent:permission", request);
      return (request.result ?? guardedRun(combined)).catch((error: unknown) => {
        if (combined?.aborted || (error instanceof Error && error.name === "AbortError"))
          return cancelled;
        throw error;
      });
    }
    const overrides: Pick<ExtensionContext["ui"], "select" | "confirm"> = {
      select: (title, options, opts) =>
        queued(
          (signal) =>
            isUnsandboxedApproval(options) && ctx.mode === "tui"
              ? showUnsandboxedApproval(ctx, title, signal)
              : ctx.ui.select(title, options, { ...opts, signal }),
          undefined,
          opts?.signal,
        ),
      confirm: (title, message, opts) =>
        queued(
          (signal) => ctx.ui.confirm(title, message, { ...opts, signal }),
          false,
          opts?.signal,
        ),
    };
    const ui = new Proxy(ctx.ui, {
      get(_target, key) {
        const current = ctx.ui;
        return Reflect.get(overrides, key) ?? Reflect.get(current, key);
      },
    });
    return Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(ctx),
        ui: {
          enumerable: true,
          configurable: true,
          get() {
            void ctx.ui;
            return ui;
          },
        },
      },
    ) as ExtensionContext;
  }

  return {
    get state() {
      return sandboxState;
    },
    get config() {
      return sandboxConfig;
    },
    get promptMode() {
      return promptMode;
    },
    get context() {
      return sessionContext;
    },
    get configPaths() {
      return sandboxConfigPaths;
    },
    get events() {
      return sandboxEvents;
    },
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    captureContext(ctx) {
      sessionContext = permissionContext(ctx);
    },
    withPermissionContext,
    start,
    shutdown,
    enable,
    disable,
    setPromptMode,
    applyRuntimeConfigForSession,
    recordEvent: recordSandboxEvent,
  };
}
