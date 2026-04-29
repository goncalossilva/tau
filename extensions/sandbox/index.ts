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
 * If `--sandbox-config <path>` is provided, that file replaces the global/project
 * config files for the session. Relative paths resolve from the session cwd.
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
 *     "denyWrite": [".env"],
 *     "allowGitCommonDir": true
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `pi -e ./sandbox --sandbox-config ./sandbox.json` - use a custom sandbox config file
 * - `/sandbox` - show command help
 *
 * Setup for source checkouts:
 * - Run `npm install` from the repository root.
 *
 * macOS also requires: ripgrep
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
// Deep import for parity with sandbox-runtime's own path normalization and glob matching.
// The public package exports do not expose these helpers, but using the same internals keeps
// the extension's policy checks aligned with the runtime's actual sandbox behavior.
import {
  containsGlobChars,
  globToRegex,
  normalizePathForSandbox,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

// --- Constants ---

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
    allowGitCommonDir: false,
  },
};

const STATUS_KEY = "sandbox";
const SANDBOX_EVENT_LIMIT = 50;
const METADATA_TRAVERSAL_PROCESSES = new Set(["find", "ls", "fd", "fdfind"]);
const GIT_FILESYSTEM_PATHS_CACHE = new Map<string, GitFilesystemPaths | null>();

// --- Types ---

type PromptMode = "interactive" | "non-interactive";

type SandboxBypassReason = "no-sandbox-flag" | "config-disabled" | "missing-dependencies";
type SandboxBlockedReason = "unsupported-platform" | "init-failed";

type SandboxRunMode = "sandbox" | "user-disabled" | SandboxBypassReason | SandboxBlockedReason;

type SandboxState =
  | { status: "pending" }
  | { status: "active"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "suspended"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "bypassed"; reason: SandboxBypassReason }
  | { status: "blocked"; reason: SandboxBlockedReason };

type SandboxConfig = Omit<SandboxRuntimeConfig, "filesystem"> & {
  enabled?: boolean;
  mode?: PromptMode;
  filesystem: SandboxRuntimeConfig["filesystem"] & {
    allowGitCommonDir?: boolean;
  };
};

type SandboxEventKind = "filesystem" | "network" | "init" | "runtime";
type SandboxEventReason =
  | "explicit-deny-read"
  | "explicit-deny-write"
  | "explicit-deny-domain"
  | "missing-allow-write"
  | "missing-allowed-domain"
  | "missing-dependencies"
  | "unsupported-platform"
  | "init-failed"
  | "already-approved-still-failed"
  | "unknown";
type SandboxEventOutcome = "blocked" | "allowed";
type SandboxConfigPathStatus = "loaded" | "parse-error";
type SandboxConfigPathLabel = "Global" | "Project" | "Override";

type PromptStatus = "completed" | "error";
type UiLevel = "info" | "warning" | "error";

type ListOp = "add" | "remove";
type NetworkList = "allow" | "deny";
type FilesystemList = "deny-read" | "allow-write" | "deny-write";

type FilesystemViolationKind = "read" | "write" | "unknown";
type FilesystemReadAccess = "metadata" | "data" | "unknown";
type FilesystemViolationResolutionKind = "allow-retry" | "allow-adapt" | "deny";

interface SandboxEvent {
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

interface SandboxConfigPath {
  label: SandboxConfigPathLabel;
  path: string;
  status: SandboxConfigPathStatus;
}

interface LoadedSandboxConfig {
  config: SandboxConfig;
  paths: SandboxConfigPath[];
}

interface GitFilesystemPaths {
  gitDir: string;
  gitCommonDir: string;
}

type SandboxConfigLoadErrorKind = "not-found" | "read-failed" | "parse-error";

class SandboxConfigLoadError extends Error {
  readonly kind: SandboxConfigLoadErrorKind;
  readonly path: string;

  constructor(kind: SandboxConfigLoadErrorKind, path: string, detail?: string) {
    super(formatSandboxConfigLoadErrorMessage(kind, path, detail));
    this.name = "SandboxConfigLoadError";
    this.kind = kind;
    this.path = path;
  }
}

interface FilesystemViolation {
  kind: FilesystemViolationKind;
  path?: string;
  processName?: string;
  readAccess?: FilesystemReadAccess;
}

type FilesystemViolationResolution =
  | {
      kind: "allow-retry";
      message: string;
      retrySuccessMessage: string;
      retryFailureMessage: string;
      retrySkippedMessage: string;
    }
  | { kind: "allow-adapt"; message: string }
  | { kind: "deny"; message: string };

// --- Helpers ---

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
  const text = `sandbox (${promptMode}, ${networkCount} domains, ${writeCount} write paths)`;
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
    "  /sandbox enable|on",
    "  /sandbox disable|off",
    "  /sandbox show",
    "  /sandbox doctor",
    "  /sandbox mode <interactive|non-interactive>",
    "  /sandbox network <allow|deny> <add|remove> <domain>",
    "  /sandbox filesystem <deny-read|allow-write|deny-write> <add|remove> <path>",
    "",
    "Startup flags:",
    "  --no-sandbox",
    "  --sandbox-config <path>",
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

function normalizeSubcommand(token?: string): string | undefined {
  switch (token?.toLowerCase()) {
    case "on":
      return "enable";
    case "off":
      return "disable";
    default:
      return token?.toLowerCase();
  }
}

type CommandCompletionOption = {
  value: string;
  label?: string;
  description?: string;
};

const SANDBOX_TOP_LEVEL_COMPLETIONS: CommandCompletionOption[] = [
  { value: "enable", label: "enable" },
  { value: "on", label: "on" },
  { value: "disable", label: "disable" },
  { value: "off", label: "off" },
  { value: "show", label: "show" },
  { value: "doctor", label: "doctor" },
  { value: "mode ", label: "mode" },
  { value: "network ", label: "network" },
  { value: "filesystem ", label: "filesystem" },
  { value: "help", label: "help" },
];

const SANDBOX_MODE_COMPLETIONS: CommandCompletionOption[] = [
  { value: "interactive", label: "interactive" },
  { value: "non-interactive", label: "non-interactive" },
];

const SANDBOX_NETWORK_LIST_COMPLETIONS: CommandCompletionOption[] = [
  { value: "allow ", label: "allow" },
  { value: "deny ", label: "deny" },
];

const SANDBOX_FILESYSTEM_LIST_COMPLETIONS: CommandCompletionOption[] = [
  { value: "deny-read ", label: "deny-read" },
  { value: "allow-write ", label: "allow-write" },
  { value: "deny-write ", label: "deny-write" },
];

const SANDBOX_LIST_OPERATION_COMPLETIONS: CommandCompletionOption[] = [
  { value: "add ", label: "add" },
  { value: "remove ", label: "remove" },
];

function normalizeCompletionFilter(value: string): string {
  return value.trim().replace(/^['"]/, "").toLowerCase();
}

function getCommandCompletions(
  base: string,
  partial: string,
  options: CommandCompletionOption[],
): Array<{ value: string; label: string; description?: string }> | null {
  const normalizedPartial = normalizeCompletionFilter(partial);
  const matches = options.filter((option) => {
    const label = option.label ?? option.value.trimEnd();
    return label.toLowerCase().startsWith(normalizedPartial);
  });
  if (matches.length === 0) return null;

  return matches.map((option) => ({
    value: `${base}${option.value}`,
    label: option.label ?? option.value.trimEnd(),
    ...(option.description ? { description: option.description } : {}),
  }));
}

function getStringValueCompletions(
  base: string,
  partial: string,
  values: string[],
): Array<{ value: string; label: string }> | null {
  const normalizedPartial = normalizeCompletionFilter(partial);
  const matches = Array.from(new Set(values)).filter((value) =>
    value.toLowerCase().startsWith(normalizedPartial),
  );
  if (matches.length === 0) return null;

  return matches.map((value) => ({
    value: `${base}${escapeSlashCommandArg(value)}`,
    label: value,
  }));
}

function getSandboxArgumentCompletions(
  prefix: string,
  runtimeConfig: SandboxRuntimeConfig | null,
): Array<{ value: string; label: string; description?: string }> | null {
  const endsWithSpace = /\s$/.test(prefix);
  const tokens = parseCommandArgs(prefix);

  if (tokens.length === 0) {
    return getCommandCompletions("", "", SANDBOX_TOP_LEVEL_COMPLETIONS);
  }

  if (tokens.length === 1 && !endsWithSpace) {
    return getCommandCompletions("", tokens[0] ?? "", SANDBOX_TOP_LEVEL_COMPLETIONS);
  }

  const subcommand = normalizeSubcommand(tokens[0]);
  if (!subcommand) return null;

  if (subcommand === "mode") {
    if (tokens.length === 1 && endsWithSpace) {
      return getCommandCompletions("mode ", "", SANDBOX_MODE_COMPLETIONS);
    }
    if (tokens.length === 2 && !endsWithSpace) {
      return getCommandCompletions("mode ", tokens[1] ?? "", SANDBOX_MODE_COMPLETIONS);
    }
    return null;
  }

  if (subcommand === "network") {
    if (tokens.length === 1 && endsWithSpace) {
      return getCommandCompletions("network ", "", SANDBOX_NETWORK_LIST_COMPLETIONS);
    }
    if (tokens.length === 2 && !endsWithSpace) {
      return getCommandCompletions("network ", tokens[1] ?? "", SANDBOX_NETWORK_LIST_COMPLETIONS);
    }

    const list = tokens[1]?.toLowerCase();
    if (list !== "allow" && list !== "deny") return null;

    const listBase = `network ${list} `;
    if (tokens.length === 2 && endsWithSpace) {
      return getCommandCompletions(listBase, "", SANDBOX_LIST_OPERATION_COMPLETIONS);
    }
    if (tokens.length === 3 && !endsWithSpace) {
      return getCommandCompletions(listBase, tokens[2] ?? "", SANDBOX_LIST_OPERATION_COMPLETIONS);
    }

    if (tokens[2]?.toLowerCase() !== "remove") return null;

    const values =
      list === "allow"
        ? (runtimeConfig?.network.allowedDomains ?? [])
        : (runtimeConfig?.network.deniedDomains ?? []);
    const valueBase = `${listBase}remove `;
    if (tokens.length === 3 && endsWithSpace) {
      return getStringValueCompletions(valueBase, "", values);
    }
    if (tokens.length === 4 && !endsWithSpace) {
      return getStringValueCompletions(valueBase, tokens[3] ?? "", values);
    }
    return null;
  }

  if (subcommand === "filesystem") {
    if (tokens.length === 1 && endsWithSpace) {
      return getCommandCompletions("filesystem ", "", SANDBOX_FILESYSTEM_LIST_COMPLETIONS);
    }
    if (tokens.length === 2 && !endsWithSpace) {
      return getCommandCompletions(
        "filesystem ",
        tokens[1] ?? "",
        SANDBOX_FILESYSTEM_LIST_COMPLETIONS,
      );
    }

    const list = tokens[1]?.toLowerCase() as FilesystemList | undefined;
    if (list !== "deny-read" && list !== "allow-write" && list !== "deny-write") {
      return null;
    }

    const listBase = `filesystem ${list} `;
    if (tokens.length === 2 && endsWithSpace) {
      return getCommandCompletions(listBase, "", SANDBOX_LIST_OPERATION_COMPLETIONS);
    }
    if (tokens.length === 3 && !endsWithSpace) {
      return getCommandCompletions(listBase, tokens[2] ?? "", SANDBOX_LIST_OPERATION_COMPLETIONS);
    }

    if (tokens[2]?.toLowerCase() !== "remove") return null;

    const values =
      list === "deny-read"
        ? (runtimeConfig?.filesystem.denyRead ?? [])
        : list === "allow-write"
          ? (runtimeConfig?.filesystem.allowWrite ?? [])
          : (runtimeConfig?.filesystem.denyWrite ?? []);
    const valueBase = `${listBase}remove `;
    if (tokens.length === 3 && endsWithSpace) {
      return getStringValueCompletions(valueBase, "", values);
    }
    if (tokens.length === 4 && !endsWithSpace) {
      return getStringValueCompletions(valueBase, tokens[3] ?? "", values);
    }
    return null;
  }

  return null;
}

function getStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandPath(value: string, cwd?: string): string {
  const expanded =
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return cwd && !expanded.startsWith("/") ? resolve(cwd, expanded) : expanded;
}

function formatSandboxConfigLoadErrorMessage(
  kind: SandboxConfigLoadErrorKind,
  path: string,
  detail?: string,
): string {
  if (kind === "not-found") {
    return `Sandbox override config not found: ${path}`;
  }

  if (kind === "parse-error") {
    return `Could not parse sandbox override config ${path}: ${detail ?? "invalid JSON"}`;
  }

  return `Could not read sandbox override config ${path}: ${detail ?? "unknown error"}`;
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

function finalizeConfig(config: SandboxConfig): SandboxConfig {
  return {
    ...config,
    enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
    mode: normalizePromptMode(config.mode),
    network: {
      ...config.network,
      allowedDomains: coerceStringArray(
        config.network?.allowedDomains,
        DEFAULT_CONFIG.network.allowedDomains,
        "network.allowedDomains",
      ),
      deniedDomains: coerceStringArray(
        config.network?.deniedDomains,
        DEFAULT_CONFIG.network.deniedDomains,
        "network.deniedDomains",
      ),
    },
    filesystem: {
      ...config.filesystem,
      denyRead: coerceStringArray(
        config.filesystem?.denyRead,
        DEFAULT_CONFIG.filesystem.denyRead,
        "filesystem.denyRead",
      ),
      allowWrite: coerceStringArray(
        config.filesystem?.allowWrite,
        DEFAULT_CONFIG.filesystem.allowWrite,
        "filesystem.allowWrite",
      ),
      denyWrite: coerceStringArray(
        config.filesystem?.denyWrite,
        DEFAULT_CONFIG.filesystem.denyWrite,
        "filesystem.denyWrite",
      ),
      allowGitCommonDir:
        typeof config.filesystem?.allowGitCommonDir === "boolean"
          ? config.filesystem.allowGitCommonDir
          : DEFAULT_CONFIG.filesystem.allowGitCommonDir,
    },
  };
}

function loadOverrideConfig(cwd: string, overrideConfigPath: string): LoadedSandboxConfig {
  const resolvedPath = expandPath(overrideConfigPath, cwd);

  let source: string;
  try {
    source = readFileSync(resolvedPath, "utf-8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      throw new SandboxConfigLoadError("not-found", resolvedPath);
    }

    throw new SandboxConfigLoadError(
      "read-failed",
      resolvedPath,
      error instanceof Error ? error.message : `${error}`,
    );
  }

  let overrideConfig: Partial<SandboxConfig>;
  try {
    overrideConfig = JSON.parse(source);
  } catch (error) {
    throw new SandboxConfigLoadError(
      "parse-error",
      resolvedPath,
      error instanceof Error ? error.message : `${error}`,
    );
  }

  return {
    config: finalizeConfig(deepMerge(DEFAULT_CONFIG, overrideConfig)),
    paths: [{ label: "Override", path: resolvedPath, status: "loaded" }],
  };
}

function loadConfig(cwd: string, overrideConfigPath?: string): LoadedSandboxConfig {
  if (overrideConfigPath) {
    return loadOverrideConfig(cwd, overrideConfigPath);
  }

  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};
  const paths: SandboxConfigPath[] = [];

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
      paths.push({ label: "Global", path: globalConfigPath, status: "loaded" });
    } catch (e) {
      paths.push({ label: "Global", path: globalConfigPath, status: "parse-error" });
      console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
      paths.push({ label: "Project", path: projectConfigPath, status: "loaded" });
    } catch (e) {
      paths.push({ label: "Project", path: projectConfigPath, status: "parse-error" });
      console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
    }
  }

  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);

  return {
    config: finalizeConfig(merged),
    paths,
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
      ...(overrides.filesystem as Partial<SandboxConfig["filesystem"]>),
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
  const { allowGitCommonDir: _allowGitCommonDir, ...filesystem } = config.filesystem;

  return {
    network: config.network,
    filesystem,
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: config.enableWeakerNetworkIsolation,
  };
}

function cloneRuntimeConfig(config: SandboxRuntimeConfig): SandboxRuntimeConfig {
  return structuredClone(config);
}

function normalizeSandboxPath(value: string, cwd?: string): string {
  return normalizePathForSandbox(expandPath(value, cwd));
}

function matchesSandboxRule(path: string, rule: string, cwd?: string): boolean {
  const normalizedPath = normalizeSandboxPath(path);
  const normalizedRule = normalizeSandboxPath(rule, cwd);

  if (containsGlobChars(rule)) {
    return new RegExp(globToRegex(normalizedRule)).test(normalizedPath);
  }

  if (normalizedPath === normalizedRule) return true;

  const prefix = normalizedRule.endsWith("/") ? normalizedRule : `${normalizedRule}/`;
  return normalizedPath.startsWith(prefix);
}

function inferSandboxRuleMatch(path: string, rules: string[], cwd?: string): string | null {
  for (const rule of rules) {
    if (matchesSandboxRule(path, rule, cwd)) return rule;
  }

  return null;
}

function isSandboxWritablePath(
  runtimeConfig: SandboxRuntimeConfig,
  path: string,
  cwd?: string,
): boolean {
  if (!inferSandboxRuleMatch(path, runtimeConfig.filesystem.allowWrite, cwd)) return false;
  return inferSandboxRuleMatch(path, runtimeConfig.filesystem.denyWrite, cwd) === null;
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

function extractAppendedSandboxAnnotation(
  original: string,
  annotated: string,
  skipViolationLines = 0,
): string {
  if (annotated === original) return "";

  if (annotated.startsWith(original)) {
    return stripSandboxViolationAnnotations(annotated.slice(original.length));
  }

  const violationLines = extractSandboxViolationLines(annotated);
  const newViolationLines =
    skipViolationLines > 0
      ? violationLines.slice(Math.min(skipViolationLines, violationLines.length))
      : violationLines;
  if (newViolationLines.length === 0) return "";

  // Filesystem and network sandbox violations are summarized elsewhere via compact
  // extension messages, so suppress the verbose synthetic annotation block.
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
  return match?.[1]?.trim() || undefined;
}

function detectFilesystemViolationFromLine(line: string): FilesystemViolation | null {
  // Runtime emits concrete op variants (e.g. file-write-create/unlink, file-read-data).
  const lower = line.toLowerCase();
  const path = extractPathLikeValue(line);
  const processName = extractViolationProcessName(line);

  if (lower.includes("file-write")) {
    return { kind: "write", path, processName };
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
  const hasOperationNotPermitted = /(?:^|\n)[^\n]*Operation not permitted(?:$|\n)/i.test(
    fallbackOutput,
  );
  if (hasEperm || hasOperationNotPermitted) {
    const path = extractPathLikeValue(fallbackOutput);
    if (path) violations.push({ kind: "unknown", path });
  }

  return violations;
}

function isMetadataTraversalViolation(
  runtimeConfig: SandboxRuntimeConfig | null,
  violation: FilesystemViolation,
  cwd?: string,
): boolean {
  if (!runtimeConfig || violation.kind !== "read" || violation.readAccess !== "metadata")
    return false;
  if (!violation.path || !METADATA_TRAVERSAL_PROCESSES.has(violation.processName ?? ""))
    return false;
  return inferSandboxRuleMatch(violation.path, runtimeConfig.filesystem.denyRead, cwd) !== null;
}

function getMetadataTraversalPaths(options: {
  runtimeConfig: SandboxRuntimeConfig | null;
  output: string;
  cwd?: string;
  skipViolationLines?: number;
}): string[] | null {
  const { runtimeConfig, output, cwd, skipViolationLines = 0 } = options;
  if (!runtimeConfig) return null;

  const allViolationLines = extractSandboxViolationLines(output);
  const violationLines =
    skipViolationLines > 0
      ? allViolationLines.slice(Math.min(skipViolationLines, allViolationLines.length))
      : allViolationLines;
  if (violationLines.length === 0) return null;

  const skippedPaths: string[] = [];
  for (const line of violationLines) {
    const violation = detectFilesystemViolationFromLine(line);
    if (!violation || !isMetadataTraversalViolation(runtimeConfig, violation, cwd)) {
      return null;
    }
    if (violation.path && !skippedPaths.includes(violation.path)) {
      skippedPaths.push(violation.path);
    }
  }

  return skippedPaths.length > 0 ? skippedPaths : null;
}

function formatMetadataTraversalNotice(paths: string[]): string {
  if (paths.length === 0) return "";

  const visiblePaths = paths.slice(0, 3).join(", ");
  const suffix = paths.length > 3 ? ", ..." : "";
  const label = paths.length === 1 ? "path" : "paths";
  return `[sandbox] Continued after skipping protected ${label}: ${visiblePaths}${suffix}`;
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

const FILESYSTEM_ALLOW_RETRY_OPTION = "Allow and retry now";
const FILESYSTEM_ALLOW_ADAPT_OPTION = "Allow but adapt for side-effects";
const FILESYSTEM_DENY_OPTION = "Deny";

function getFilesystemPromptOptions(
  _violation: FilesystemViolation,
  autoRetryAvailable: boolean,
): string[] {
  if (!autoRetryAvailable) {
    return [FILESYSTEM_ALLOW_ADAPT_OPTION, FILESYSTEM_DENY_OPTION];
  }

  return [FILESYSTEM_ALLOW_RETRY_OPTION, FILESYSTEM_ALLOW_ADAPT_OPTION, FILESYSTEM_DENY_OPTION];
}

function parseFilesystemPromptSelection(
  selection: string | undefined,
  autoRetryAvailable: boolean,
): FilesystemViolationResolutionKind {
  if (selection === FILESYSTEM_ALLOW_ADAPT_OPTION) return "allow-adapt";
  if (selection === FILESYSTEM_ALLOW_RETRY_OPTION && autoRetryAvailable) return "allow-retry";
  return "deny";
}

function formatFilesystemAllowRetryMessage(_target: string): string {
  return "\nSandbox blocked access.\n\nGranting access and retrying the command per user request...\n\n";
}

function formatFilesystemAllowAdaptMessage(_target: string): string {
  return "\nSandbox blocked access.\n\nAccess granted for this session. Retry the command manually if appropriate.";
}

function formatFilesystemDeniedMessage(_target: string): string {
  return "\nSandbox blocked access.\n\nAccess remains denied for this session.";
}

function formatFilesystemAlreadyAllowedMessage(_target: string): string {
  return "\nSandbox blocked access again after permission had already been granted. The remaining failure may be unrelated to sandbox policy.";
}

function formatFilesystemRetrySucceededMessage(_target: string): string {
  return "";
}

function formatFilesystemRetryFailedMessage(_target: string): string {
  return "\nAccess granted and command retried per user request, but the command still exited non-zero. The sandbox block was resolved; the remaining failure may be unrelated.";
}

function formatFilesystemRetrySkippedMessage(_target: string): string {
  return "\nAccess granted for this session, but automatic retry was skipped because the timeout was exhausted. Retry the command manually if needed.";
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

async function handleFilesystemViolation(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext | null;
  promptMode: PromptMode;
  runtimeConfig: SandboxRuntimeConfig;
  output: string;
  rawOutput: string;
  command: string;
  cwd?: string;
  pendingPrompts?: Map<string, Promise<FilesystemViolationResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  existingViolationCount?: number;
  recordEvent?: (event: SandboxEvent) => void;
  autoRetryAvailable?: boolean;
}): Promise<FilesystemViolationResolution | null> {
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
    recordEvent,
    autoRetryAvailable = true,
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
    return { kind: "allow-adapt", message: formatFilesystemAlreadyAllowedMessage(target) };
  }

  const promptKey = `${allowCommand}:${autoRetryAvailable ? "retry" : "adapt"}`;
  const existingPrompt = pendingPrompts?.get(promptKey);
  if (existingPrompt) return existingPrompt;

  const promptTask: Promise<FilesystemViolationResolution | null> = (async () => {
    try {
      const selection = await withPromptSignal(pi, () =>
        ctx.ui.select(
          `Sandbox blocked filesystem ${target}`,
          getFilesystemPromptOptions(violation, autoRetryAvailable),
        ),
      );
      const decision = parseFilesystemPromptSelection(selection, autoRetryAvailable);
      if (decision === "deny") {
        recordFilesystemEvent("blocked");
        return { kind: "deny", message: formatFilesystemDeniedMessage(target) };
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
          message: formatFilesystemAllowRetryMessage(target),
          retrySuccessMessage: formatFilesystemRetrySucceededMessage(target),
          retryFailureMessage: formatFilesystemRetryFailedMessage(target),
          retrySkippedMessage: formatFilesystemRetrySkippedMessage(target),
        };
      }

      return {
        kind: "allow-adapt",
        message: changed
          ? formatFilesystemAllowAdaptMessage(target)
          : formatFilesystemAlreadyAllowedMessage(target),
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

interface SandboxedBashOpsOptions {
  pi: ExtensionAPI;
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

interface BashAttemptResult {
  exitCode: number | null;
  combinedOutput: string;
  interruptedByFilesystemViolation: boolean;
}

interface ProcessedSandboxAttempt {
  exitCode: number | null;
  postamble: string;
  resolution: FilesystemViolationResolution | null;
}

interface PreparedSandboxAttempt {
  attempt: BashAttemptResult;
  existingViolationCount: number;
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

function createSandboxedBashOps(options: SandboxedBashOpsOptions): BashOperations {
  const {
    pi,
    getContext,
    getSandboxConfig,
    getRuntimeConfig,
    getPromptMode,
    applyRuntimeConfigForSession,
    recordEvent,
  } = options;
  const pendingFilesystemPrompts = new Map<string, Promise<FilesystemViolationResolution | null>>();

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
    command: string,
    wrappedCommand: string,
    cwd: string,
    onData: (data: Buffer) => void,
    existingViolationCount: number,
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
      let interruptedByFilesystemViolation = false;
      let seenViolationCount = existingViolationCount;
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

      // sandbox-runtime only provides live filesystem violation events on macOS.
      // Upstream documents Linux violation monitoring as future work via
      // automatic strace-based detection integrated with the violation store,
      // but there is no Linux implementation yet:
      // https://github.com/anthropic-experimental/sandbox-runtime#known-limitations-and-future-work
      const unsubscribeViolations =
        process.platform !== "darwin"
          ? () => undefined
          : SandboxManager.getSandboxViolationStore().subscribe(() => {
              const violations =
                SandboxManager.getSandboxViolationStore().getViolationsForCommand(command);
              if (violations.length <= seenViolationCount) return;

              const newViolations = violations.slice(seenViolationCount);
              seenViolationCount = violations.length;

              const runtimeConfig = getRuntimeConfig();
              const shouldStop = newViolations.some((violation) => {
                const filesystemViolation = detectFilesystemViolationFromLine(violation.line);
                if (!filesystemViolation) return false;
                return !isMetadataTraversalViolation(runtimeConfig, filesystemViolation, cwd);
              });
              if (shouldStop) {
                stopForFilesystemViolation();
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
        });
      });
    });
  }

  function getRemainingTimeout(timeout: number | undefined, startedAt: number): number | undefined {
    if (timeout === undefined) return undefined;

    const remainingMs = timeout * 1000 - (Date.now() - startedAt);
    return Math.max(0, remainingMs / 1000);
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

    const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
    const existingViolationCount =
      SandboxManager.getSandboxViolationStore().getViolationsForCommand(command).length;

    try {
      const attempt = await runSandboxAttempt(
        command,
        wrappedCommand,
        cwd,
        onData,
        existingViolationCount,
        signal,
        timeout,
        env,
      );
      return { attempt, existingViolationCount };
    } catch (err) {
      safeCleanupAfterCommand();
      throw err;
    }
  }

  async function processSandboxAttempt(options: {
    attempt: BashAttemptResult;
    command: string;
    cwd: string;
    existingViolationCount: number;
    autoRetryAvailable: boolean;
  }): Promise<ProcessedSandboxAttempt> {
    const { attempt, command, cwd, existingViolationCount, autoRetryAvailable } = options;
    const commandSucceeded = attempt.exitCode === 0 && !attempt.interruptedByFilesystemViolation;
    if (commandSucceeded) {
      return { exitCode: attempt.exitCode, postamble: "", resolution: null };
    }

    const annotatedOutput = SandboxManager.annotateStderrWithSandboxFailures(
      command,
      attempt.combinedOutput,
    );
    const runtimeConfig = getRuntimeConfig();
    const metadataTraversalPaths = getMetadataTraversalPaths({
      runtimeConfig,
      output: annotatedOutput,
      cwd,
      skipViolationLines: existingViolationCount,
    });
    const effectiveExitCode = metadataTraversalPaths ? 0 : attempt.exitCode;
    let postamble = extractAppendedSandboxAnnotation(
      attempt.combinedOutput,
      annotatedOutput,
      existingViolationCount,
    );
    let resolution: FilesystemViolationResolution | null = null;

    if (metadataTraversalPaths) {
      const notice = formatMetadataTraversalNotice(metadataTraversalPaths);
      postamble = appendOutputPostamble(postamble, notice, attempt.combinedOutput);
    } else if (runtimeConfig) {
      resolution = await handleFilesystemViolation({
        pi,
        ctx: getContext(),
        promptMode: getPromptMode(),
        runtimeConfig,
        output: annotatedOutput,
        rawOutput: attempt.combinedOutput,
        command,
        cwd,
        pendingPrompts: pendingFilesystemPrompts,
        applyRuntimeConfigForSession,
        existingViolationCount,
        recordEvent,
        autoRetryAvailable,
      });

      if (resolution) {
        postamble = appendOutputPostamble(postamble, resolution.message, attempt.combinedOutput);
      }
    }

    return { exitCode: effectiveExitCode, postamble, resolution };
  }

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      return runSerially(async () => {
        if (!existsSync(cwd)) {
          throw new Error(`Working directory does not exist: ${cwd}`);
        }

        const startedAt = Date.now();
        const initialRun = await prepareAndRunSandboxAttempt({
          command,
          cwd,
          onData,
          signal,
          timeout,
          env,
        });

        let processedAttempt: ProcessedSandboxAttempt;
        try {
          processedAttempt = await processSandboxAttempt({
            attempt: initialRun.attempt,
            command,
            cwd,
            existingViolationCount: initialRun.existingViolationCount,
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

        const retryTimeout = getRemainingTimeout(timeout, startedAt);
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
            cwd,
            existingViolationCount: retryRun.existingViolationCount,
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
        } else if (!processedRetry.resolution) {
          retryPostamble = appendOutputPostamble(
            retryPostamble,
            retryResolution.retryFailureMessage,
            retryRun.attempt.combinedOutput,
          );
        }

        if (retryPostamble) onData(Buffer.from(retryPostamble));
        safeCleanupAfterCommand();
        return { exitCode: processedRetry.exitCode };
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

function requireRuntimeConfig(
  ctx: ExtensionContext,
  state: SandboxState,
): SandboxRuntimeConfig | null {
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
  if (reason === "missing-allowed-domain")
    return "network access target is not in the allowed domain list";
  return "sandbox blocked network access";
}

function formatSandboxEventTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function describeSandboxRuntimeState(state: SandboxState, promptMode: PromptMode): string {
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

function renderSandboxDoctorReport(options: {
  state: SandboxState;
  promptMode: PromptMode;
  configPaths: SandboxConfigPath[];
  events: SandboxEvent[];
}): string {
  const { state, promptMode, configPaths, events } = options;
  const lines = ["Sandbox doctor", `- Runtime: ${describeSandboxRuntimeState(state, promptMode)}`];

  if (configPaths.length === 0) {
    lines.push("- Config paths: (none loaded)");
  } else {
    lines.push("- Config paths:");
    for (const configPath of configPaths) {
      const status = configPath.status === "loaded" ? "loaded" : "parse error";
      lines.push(`  - ${configPath.label}: ${configPath.path} (${status})`);
    }
  }

  lines.push(`- Events: ${events.length}`);

  if (events.length === 0) {
    lines.push("", "- No sandbox events recorded in this session.");
    return lines.join("\n");
  }

  for (const event of [...events].reverse()) {
    lines.push(
      "",
      `- [${formatSandboxEventTimestamp(event.timestamp)}] [${event.kind}] [${event.outcome}] ${event.reason}`,
      ...(event.target ? [`  Target: ${event.target}`] : []),
      ...(event.command ? [`  Command: ${event.command}`] : []),
      `  Summary: ${event.summary}`,
      ...(event.suggestedCommand
        ? ["  Suggested session fix:", `    ${event.suggestedCommand}`]
        : []),
    );
  }

  return lines.join("\n");
}

function getSandboxConfigParseErrors(paths: SandboxConfigPath[]): SandboxConfigPath[] {
  return paths.filter((configPath) => configPath.status === "parse-error");
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
    return loadConfig(cwd, overrideConfigPath);
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

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("sandbox-config", {
    description:
      "Use a custom sandbox config file for this session (replaces global/project sandbox.json files)",
    type: "string",
  });

  let sessionCwd = process.cwd();
  let sandboxState: SandboxState = { status: "pending" };
  let sandboxConfig: SandboxConfig | null = null;
  let promptMode: PromptMode = DEFAULT_PROMPT_MODE;
  let sessionContext: ExtensionContext | null = null;
  let sandboxConfigPaths: SandboxConfigPath[] = [];
  let sandboxEvents: SandboxEvent[] = [];

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

  function applyRuntimeConfigForSession(
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
    targetStatus: "active" | "suspended" = sandboxState.status === "suspended"
      ? "suspended"
      : "active",
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
  };

  const initializeSandboxRuntime = async (
    ctx: ExtensionContext,
    config: SandboxConfig,
  ): Promise<SandboxRuntimeConfig | null> => {
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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : `${err}`;
      promptMode = DEFAULT_PROMPT_MODE;
      pendingNetworkApprovals.clear();
      sandboxState = { status: "blocked", reason: "init-failed" };
      recordRuntimeEvent("init", "init-failed", `sandbox initialization failed: ${errorMessage}`);
      setSandboxStatus(ctx, false);
      notify(ctx, `Sandbox initialization failed: ${errorMessage}`, "error");
      return null;
    }
  };

  const sandboxedOps = createSandboxedBashOps({
    pi,
    getContext: () => sessionContext,
    getSandboxConfig: () => sandboxConfig,
    getRuntimeConfig: () => getStateRuntimeConfig(sandboxState),
    getPromptMode: () => promptMode,
    applyRuntimeConfigForSession,
    recordEvent: recordSandboxEvent,
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
    sandboxConfig = null;
    promptMode = DEFAULT_PROMPT_MODE;
    sandboxConfigPaths = [];
    sandboxEvents = [];
    pendingNetworkApprovals.clear();
  };

  const isSupportedPlatform = (): boolean =>
    process.platform === "darwin" || process.platform === "linux";

  pi.registerTool({
    ...localBashTool,
    label: "bash (sandbox-aware)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (sandboxState.status !== "active") {
        const allowsUnsandboxed =
          sandboxState.status === "bypassed" || sandboxState.status === "suspended";
        if (!allowsUnsandboxed) {
          const runMode = getSandboxRunMode(sandboxState);

          let reason =
            "Sandbox is not active and unsandboxed execution is blocked. Fix sandbox setup and run /sandbox enable, or restart with --no-sandbox.";
          if (runMode === "unsupported-platform") {
            reason =
              "Sandbox is unsupported on this platform. Re-run with --no-sandbox to allow unsandboxed execution.";
          } else if (runMode === "init-failed") {
            reason =
              "Sandbox initialization failed. Run /sandbox enable to retry, or restart with --no-sandbox.";
          } else if (runMode === "sandbox") {
            reason =
              "Sandbox session initialization is incomplete. Retry after session startup or run /sandbox enable.";
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

    const sandboxConfigOverride = getStringFlag(pi, "sandbox-config");
    const loadedConfig = loadSandboxConfigForContext(ctx, ctx.cwd, sandboxConfigOverride, {
      exitOnError: true,
    });
    if (!loadedConfig) return;

    sandboxConfigPaths = loadedConfig.paths;
    const parseErrors = getSandboxConfigParseErrors(sandboxConfigPaths);
    if (parseErrors.length > 0) {
      notifySandboxConfigParseErrors(ctx, parseErrors);
    }
    const config = loadedConfig.config;
    sandboxConfig = config;

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
    getArgumentCompletions: (prefix) =>
      getSandboxArgumentCompletions(prefix, getStateRuntimeConfig(sandboxState)),
    handler: async (args, ctx) => {
      const tokens = parseCommandArgs(args);
      const subcommand = normalizeSubcommand(tokens[0]);

      if (!subcommand || subcommand === "help") {
        showHelp(ctx);
        return;
      }

      if (subcommand === "doctor") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox doctor", "warning");
          return;
        }

        notify(
          ctx,
          renderSandboxDoctorReport({
            state: sandboxState,
            promptMode,
            configPaths: sandboxConfigPaths,
            events: sandboxEvents,
          }),
          "info",
        );
        return;
      }

      if (subcommand === "enable") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox enable|on", "warning");
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
            recordRuntimeEvent(
              "init",
              "unsupported-platform",
              `sandbox not supported on ${process.platform}`,
            );
            notify(ctx, `Sandbox not supported on ${process.platform}`, "warning");
            return;
          }

          const sandboxConfigOverride = getStringFlag(pi, "sandbox-config");
          const loadedConfig = loadSandboxConfigForContext(ctx, ctx.cwd, sandboxConfigOverride);
          if (!loadedConfig) return;

          sandboxConfigPaths = loadedConfig.paths;
          const parseErrors = getSandboxConfigParseErrors(sandboxConfigPaths);
          if (parseErrors.length > 0) {
            notifySandboxConfigParseErrors(ctx, parseErrors);
          }
          sandboxConfig = loadedConfig.config;
          runtimeConfig = await initializeSandboxRuntime(ctx, loadedConfig.config);
          if (!runtimeConfig) return;
          initializedNow = true;
        }

        if (!runtimeConfig) return;

        if (initializedNow) {
          setSandboxStatus(ctx, true, runtimeConfig, promptMode);
        } else {
          applyRuntimeConfigForSession(ctx, runtimeConfig, "active");
        }

        notify(ctx, "Sandbox enabled", "info");
        return;
      }

      if (subcommand === "disable") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox disable|off", "warning");
          return;
        }

        if (sandboxState.status !== "active") {
          notify(ctx, `Sandbox is not active (mode: ${getSandboxRunMode(sandboxState)})`, "info");
          return;
        }

        sandboxState = { status: "suspended", runtimeConfig: sandboxState.runtimeConfig };
        setSandboxStatus(ctx, false);
        notify(ctx, "Sandbox disabled", "info");
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
          `    allowGitCommonDir: ${sandboxConfig?.filesystem.allowGitCommonDir ? "true" : "false"}`,
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
        const values =
          list === "allow" ? nextConfig.network.allowedDomains : nextConfig.network.deniedDomains;
        const changed = mutateStringList(values, op, domain);
        if (!changed) {
          notify(
            ctx,
            `No change: network ${list} list already ${op === "add" ? "contains" : "omits"} ${domain}`,
          );
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
