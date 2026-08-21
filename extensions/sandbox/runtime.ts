import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_PROMPT_MODE,
  SandboxConfigLoadError,
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  getSandboxConfigParseErrors,
  getSkippedUntrustedProjectConfigPaths,
  loadConfig,
  mutateStringList,
  normalizePromptMode,
  toRuntimeConfig,
  type LoadedSandboxConfig,
  type PromptMode,
  type SandboxConfig,
  type SandboxConfigPath,
} from "./config.js";

const STATUS_KEY = "sandbox";
const SANDBOX_EVENT_LIMIT = 50;

type PromptStatus = "completed" | "error";
type UiLevel = "info" | "warning" | "error";

export type SandboxEventOutcome = "blocked" | "allowed";
type SandboxBypassReason = "no-sandbox-flag" | "config-disabled" | "missing-dependencies";
type SandboxBlockedReason = "unsupported-platform" | "init-failed";
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
  start(ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  enable(ctx: ExtensionContext): Promise<void>;
  disable(ctx: ExtensionContext): Promise<void>;
  setPromptMode(ctx: ExtensionContext, mode: PromptMode): void;
  applyRuntimeConfigForSession(ctx: ExtensionContext, runtimeConfig: SandboxRuntimeConfig): void;
  recordEvent(event: SandboxEvent): void;
}

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

function announceSandboxState(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  const text = `Sandbox ${enabled ? "enabled" : "disabled"}`;
  notify(ctx, text, "info");
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

function buildNetworkBlockCommand(reason: SandboxEventReason, host: string): string | undefined {
  if (reason === "explicit-deny-domain") {
    return `/sandbox network deny remove ${escapeSlashCommandArg(host)}`;
  }
  if (reason === "missing-allowed-domain") {
    return `/sandbox network allow add ${escapeSlashCommandArg(host)}`;
  }
  return undefined;
}

function describeNetworkEventSummary(
  reason: SandboxEventReason,
  outcome: SandboxEventOutcome,
): string {
  if (outcome === "allowed") return "user allowed network domain for this session";
  if (reason === "explicit-deny-domain") return "network access matched a deny list entry";
  if (reason === "missing-allowed-domain") {
    return "network access target is not in the allowed domain list";
  }
  return "sandbox blocked network access";
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
    if (state.reason === "config-disabled") return "bypassed (config disabled)";
    return "bypassed (missing dependencies)";
  }
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

function formatMissingSandboxDependenciesWarning(errors: string[]): string {
  return `Sandbox disabled: ${errors.join("; ")}`;
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
  const pendingNetworkApprovals = new Map<string, Promise<boolean>>();

  function recordSandboxEvent(event: SandboxEvent): void {
    sandboxEvents.push(event);
    if (sandboxEvents.length > SANDBOX_EVENT_LIMIT) {
      sandboxEvents.splice(0, sandboxEvents.length - SANDBOX_EVENT_LIMIT);
    }
  }

  function recordNetworkEvent(
    outcome: SandboxEventOutcome,
    reason: SandboxEventReason,
    host: string,
    port?: number,
  ): void {
    const target = port ? `${host}:${port}` : host;
    recordSandboxEvent({
      timestamp: Date.now(),
      kind: "network",
      outcome,
      reason,
      target,
      cwd: sessionCwd,
      summary: describeNetworkEventSummary(reason, outcome),
      suggestedCommand: outcome === "blocked" ? buildNetworkBlockCommand(reason, host) : undefined,
    });
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

  function createNetworkAskCallback(): SandboxAskCallback {
    return async ({ host, port }) => {
      if (sandboxState.status === "suspended") return true;

      const normalizedHost = host.toLowerCase();
      const key = normalizedHost;
      const existingDecision = pendingNetworkApprovals.get(key);
      if (existingDecision) return existingDecision;

      const decision = (async () => {
        try {
          const initialConfig = getStateRuntimeConfig(sandboxState);
          if (!initialConfig) return false;

          if (initialConfig.network.allowedDomains.includes(normalizedHost)) return true;
          if (initialConfig.network.deniedDomains.includes(normalizedHost)) {
            recordNetworkEvent("blocked", "explicit-deny-domain", normalizedHost, port);
            return false;
          }

          const suggestedCommand = buildNetworkBlockCommand(
            "missing-allowed-domain",
            normalizedHost,
          );
          const ctx = sessionContext;
          if (promptMode === "non-interactive" || !ctx || !ctx.hasUI) {
            recordNetworkEvent("blocked", "missing-allowed-domain", normalizedHost, port);
            const message = `Sandbox blocked network access to ${normalizedHost}. To temporarily allow for this session, run: ${suggestedCommand}`;
            if (ctx) notify(ctx, message, "warning");
            else console.warn(message);
            return false;
          }

          const target = port ? `${normalizedHost}:${port}` : normalizedHost;
          const approved = await withPromptSignal(pi, () =>
            ctx.ui.confirm(
              `Sandbox blocked network access to ${target}`,
              "\nAllow for this session?",
            ),
          );
          if (!approved) {
            recordNetworkEvent("blocked", "missing-allowed-domain", normalizedHost, port);
            return false;
          }

          const latestConfig = getStateRuntimeConfig(sandboxState);
          if (!latestConfig) return false;
          if (latestConfig.network.deniedDomains.includes(normalizedHost)) {
            recordNetworkEvent("blocked", "explicit-deny-domain", normalizedHost, port);
            notify(
              ctx,
              `Network access to ${normalizedHost} remains denied by current sandbox policy. Remove it from deny list to allow.`,
              "warning",
            );
            return false;
          }
          if (latestConfig.network.allowedDomains.includes(normalizedHost)) {
            recordNetworkEvent("allowed", "missing-allowed-domain", normalizedHost, port);
            return true;
          }

          const nextConfig = cloneRuntimeConfig(latestConfig);
          const changed = mutateStringList(
            nextConfig.network.allowedDomains,
            "add",
            normalizedHost,
          );
          if (changed) {
            applyRuntimeConfigForSession(ctx, nextConfig);
          }

          recordNetworkEvent("allowed", "missing-allowed-domain", normalizedHost, port);
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
  }

  async function initializeSandboxRuntime(
    ctx: ExtensionContext,
    config: SandboxConfig,
  ): Promise<SandboxRuntimeConfig | null> {
    promptMode = normalizePromptMode(config.mode);

    const dependencyErrors = getSandboxDependencyErrors(config);
    if (dependencyErrors.length > 0) {
      promptMode = DEFAULT_PROMPT_MODE;
      pendingNetworkApprovals.clear();
      sandboxState = { status: "bypassed", reason: "missing-dependencies" };
      recordRuntimeEvent(
        "init",
        "missing-dependencies",
        `sandbox dependencies missing: ${dependencyErrors.join("; ")}`,
      );
      setSandboxStatus(ctx, false);
      notify(ctx, formatMissingSandboxDependenciesWarning(dependencyErrors), "warning");
      return null;
    }

    const runtimeConfig = toRuntimeConfig(config);

    try {
      await SandboxManager.initialize(runtimeConfig, createNetworkAskCallback(), true);
      const activeConfig = cloneRuntimeConfig(runtimeConfig);
      sandboxState = { status: "active", runtimeConfig: activeConfig };
      return activeConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`;
      promptMode = DEFAULT_PROMPT_MODE;
      pendingNetworkApprovals.clear();
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
    pendingNetworkApprovals.clear();
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
    setSandboxStatus(ctx, false);
    sessionContext = ctx;
    resetRuntimeState();
    sessionCwd = ctx.cwd;

    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    if (noSandbox) {
      sandboxState = { status: "bypassed", reason: "no-sandbox-flag" };
      notify(ctx, "Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadCurrentConfig(ctx, { exitOnError: true });
    if (!config) return;

    if (!config.enabled) {
      sandboxState = { status: "bypassed", reason: "config-disabled" };
      notify(ctx, "Sandbox disabled via config", "info");
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
    notify(ctx, "Sandbox initialized", "info");
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
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
    pendingNetworkApprovals.clear();
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
    promptMode = mode;
    if (sandboxState.status === "active") {
      setSandboxStatus(ctx, true, sandboxState.runtimeConfig, promptMode);
    }
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
      if (!sessionContext) sessionContext = ctx;
    },
    start,
    shutdown,
    enable,
    disable,
    setPromptMode,
    applyRuntimeConfigForSession,
    recordEvent: recordSandboxEvent,
  };
}
