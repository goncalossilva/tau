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
 *     "deniedDomains": [],
 *     "allowMachLookup": [
 *       "com.apple.dnssd.service",
 *       "com.apple.SystemConfiguration.configd",
 *       "com.apple.SystemConfiguration.DNSConfiguration"
 *     ]
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": ["."],
 *     "denyWrite": [".env"],
 *     "allowTempDirs": true,
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
import { homedir, tmpdir } from "node:os";
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
import {
  CONFIG_DIR_NAME,
  createBashTool,
  getAgentDir,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// --- Constants ---

const DEFAULT_PROMPT_MODE: PromptMode = "interactive";
const IS_MACOS = process.platform === "darwin";
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  mode: DEFAULT_PROMPT_MODE,
  network: {
    allowedDomains: [
      "localhost",
      "127.0.0.1",
      "npmjs.org",
      "*.npmjs.org",
      "npmjs.com",
      "*.npmjs.com",
      "registry.yarnpkg.com",
      "nodejs.org",
      "*.nodejs.org",
      "pypi.org",
      "*.pypi.org",
      "pythonhosted.org",
      "*.pythonhosted.org",
      "crates.io",
      "*.crates.io",
      "rustup.rs",
      "*.rust-lang.org",
      "repo.maven.apache.org",
      "gradle.org",
      "*.gradle.org",
      "proxy.golang.org",
      "sum.golang.org",
      "go.dev",
      "golang.org",
      "rubygems.org",
      "*.rubygems.org",
      "nuget.org",
      "*.nuget.org",
      "github.com",
      "*.github.com",
      "githubusercontent.com",
      "*.githubusercontent.com",
      "gitlab.com",
      "*.gitlab.com",
      "bitbucket.org",
      "*.bitbucket.org",
      "ghcr.io",
      "docker.io",
      "*.docker.io",
      "docker.com",
      "*.docker.com",
      "sentry.io",
      "*.sentry.io",
      "datadoghq.com",
      "*.datadoghq.com",
      "datadoghq.eu",
      "*.datadoghq.eu",
      "anthropic.com",
      "*.anthropic.com",
      "claude.ai",
      "*.claude.ai",
      "openai.com",
      "*.openai.com",
      "chatgpt.com",
      "*.chatgpt.com",
      "openrouter.ai",
      "*.openrouter.ai",
      "google.com",
      "*.google.com",
      "googleapis.com",
      "*.googleapis.com",
      "todoist.com",
      "*.todoist.com",
      "twist.com",
      "*.twist.com",
      "doist.com",
      "*.doist.com",
    ],
    deniedDomains: [],
    allowUnixSockets: ["$SSH_AUTH_SOCK"],
    allowLocalBinding: true,
    allowMachLookup: [
      "com.apple.dnssd.service",
      "com.apple.SystemConfiguration.configd",
      "com.apple.SystemConfiguration.DNSConfiguration",
    ],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowRead: ["~/.ssh/config", "~/.ssh/known_hosts", "~/.ssh/*.pub"],
    allowWrite: [
      ".",
      "~/.cache",
      "~/Library/Caches",
      join(getAgentDir(), "*.lock"),
      "~/**/__pycache__",
      "~/**/__pycache__/*",
      "~/.npm",
      "~/.rustup",
      "~/.cargo/registry",
      "~/.cargo/git",
      "~/.cargo/.package-cache",
      "~/.cargo/.package-cache-mutate",
      "~/.cargo/.global-cache",
      "~/go/pkg",
      "~/.m2/repository",
      "~/.m2/wrapper/dists",
      "~/.gradle",
      "~/Library/Application Support/kotlin",
      "~/.android",
      "~/.bundle/cache",
      "~/.gem/cache",
      "~/.gem/specs",
      "~/.nuget/packages",
      "~/.local/share/NuGet/*-cache",
      "~/.local/share/NuGet/*-cache/**",
    ],
    denyWrite: [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "~/.gradle/gradle.properties",
      "~/.gradle/init.gradle",
      "~/.gradle/init.gradle.kts",
      "~/.gradle/init.d",
      "~/.android/adbkey",
    ],
    allowTempDirs: true,
    allowGitConfig: true,
    allowGitCommonDir: true,
  },
  ignoreViolations: {
    "*": ["/__pycache__", "mach-lookup com.apple.usymptomsd"],
  },
};

const STATUS_KEY = "sandbox";
const SANDBOX_EVENT_LIMIT = 50;
const READ_TRAVERSAL_PROCESSES = new Set(["find", "ls", "fd", "fdfind"]);
const GIT_FILESYSTEM_PATHS_CACHE = new Map<string, GitFilesystemPaths | null>();
const ENV_PATH_REFERENCE_PATTERN = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

// --- Types ---

type PromptMode = "interactive" | "non-interactive";
type ListOp = "add" | "remove";
type SandboxEventOutcome = "blocked" | "allowed";
type ViolationResolutionKind = "allow-retry" | "allow-adapt" | "deny";

type ViolationResolution =
  | {
      kind: "allow-retry";
      message: string;
      retrySuccessMessage: string;
      retryFailureMessage: string;
      retrySkippedMessage: string;
    }
  | { kind: "allow-adapt"; message: string }
  | { kind: "deny"; message: string };

type SandboxBypassReason = "no-sandbox-flag" | "config-disabled" | "missing-dependencies";
type SandboxBlockedReason = "unsupported-platform" | "init-failed";

type SandboxRunMode = "sandbox" | "user-disabled" | SandboxBypassReason | SandboxBlockedReason;

type SandboxState =
  | { status: "pending" }
  | { status: "active"; runtimeConfig: SandboxRuntimeConfig }
  | { status: "suspended" }
  | { status: "bypassed"; reason: SandboxBypassReason }
  | { status: "blocked"; reason: SandboxBlockedReason };

type SandboxConfig = Omit<SandboxRuntimeConfig, "filesystem"> & {
  enabled?: boolean;
  mode?: PromptMode;
  filesystem: SandboxRuntimeConfig["filesystem"] & {
    allowTempDirs?: boolean;
    allowGitCommonDir?: boolean;
  };
};

type SandboxEventKind = "filesystem" | "network" | "mach-lookup" | "init" | "runtime";
type SandboxEventReason =
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
type SandboxConfigPathStatus = "loaded" | "parse-error" | "skipped-untrusted";
type SandboxConfigPathLabel = "Global" | "Project" | "Override";

type PromptStatus = "completed" | "error";
type UiLevel = "info" | "warning" | "error";

type NetworkList = "allow" | "deny";
type FilesystemList = "deny-read" | "allow-write" | "deny-write";

type FilesystemViolationKind = "read" | "write" | "unknown";
type FilesystemReadAccess = "metadata" | "data" | "unknown";
type FilesystemWriteAccess = "unlink" | "unknown";
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
  writeAccess?: FilesystemWriteAccess;
}

interface MachLookupViolation {
  service: string;
}

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

function showHelp(ctx: ExtensionContext): void {
  const lines = [
    "Usage:",
    "  /sandbox enable|on",
    "  /sandbox disable|off",
    "  /sandbox show",
    "  /sandbox doctor",
    "  /sandbox mode <interactive|non-interactive>",
    "  /sandbox network <allow|deny> <add|remove> <domain>",
    ...(IS_MACOS
      ? [
          "  /sandbox mach-lookup <add|remove> <service>",
          "    Service rules support one trailing *; use * for all services.",
        ]
      : []),
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
  ...(IS_MACOS ? [{ value: "mach-lookup ", label: "mach-lookup" }] : []),
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

function getMachLookupArgumentCompletions(options: {
  tokens: string[];
  endsWithSpace: boolean;
  runtimeConfig: SandboxRuntimeConfig | null;
}): Array<{ value: string; label: string; description?: string }> | null {
  const { tokens, endsWithSpace, runtimeConfig } = options;

  if (tokens.length === 1 && endsWithSpace) {
    return getCommandCompletions("mach-lookup ", "", SANDBOX_LIST_OPERATION_COMPLETIONS);
  }
  if (tokens.length === 2 && !endsWithSpace) {
    return getCommandCompletions(
      "mach-lookup ",
      tokens[1] ?? "",
      SANDBOX_LIST_OPERATION_COMPLETIONS,
    );
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

  if (subcommand === "mach-lookup" && IS_MACOS) {
    return getMachLookupArgumentCompletions({ tokens, endsWithSpace, runtimeConfig });
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

function cleanStringArray(value: unknown[], field: string): string[] {
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

function coerceStringArray(value: unknown, fallback: string[], field: string): string[] {
  if (!Array.isArray(value)) {
    console.error(`Warning: Expected ${field} to be a string[]; using defaults.`);
    return [...fallback];
  }

  return cleanStringArray(value, field);
}

function coerceOptionalStringArray(
  value: unknown,
  fallback: string[] | undefined,
  field: string,
): string[] | undefined {
  if (value === undefined) return fallback ? [...fallback] : undefined;

  if (!Array.isArray(value)) {
    console.error(`Warning: Expected ${field} to be a string[]; using defaults.`);
    return fallback ? [...fallback] : undefined;
  }

  return cleanStringArray(value, field);
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
      allowMachLookup: coerceStringArray(
        config.network?.allowMachLookup,
        DEFAULT_CONFIG.network.allowMachLookup ?? [],
        "network.allowMachLookup",
      ),
      allowUnixSockets: coerceOptionalStringArray(
        config.network?.allowUnixSockets,
        DEFAULT_CONFIG.network.allowUnixSockets,
        "network.allowUnixSockets",
      ),
    },
    filesystem: {
      ...config.filesystem,
      denyRead: coerceStringArray(
        config.filesystem?.denyRead,
        DEFAULT_CONFIG.filesystem.denyRead,
        "filesystem.denyRead",
      ),
      allowRead: coerceOptionalStringArray(
        config.filesystem?.allowRead,
        DEFAULT_CONFIG.filesystem.allowRead,
        "filesystem.allowRead",
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
      allowTempDirs:
        typeof config.filesystem?.allowTempDirs === "boolean"
          ? config.filesystem.allowTempDirs
          : DEFAULT_CONFIG.filesystem.allowTempDirs,
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

function loadConfig(
  cwd: string,
  overrideConfigPath?: string,
  options: { projectTrusted?: boolean } = {},
): LoadedSandboxConfig {
  if (overrideConfigPath) {
    return loadOverrideConfig(cwd, overrideConfigPath);
  }

  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  const globalConfigPath = join(getAgentDir(), "sandbox.json");

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
    if (options.projectTrusted !== true) {
      paths.push({ label: "Project", path: projectConfigPath, status: "skipped-untrusted" });
    } else {
      try {
        projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
        paths.push({ label: "Project", path: projectConfigPath, status: "loaded" });
      } catch (e) {
        paths.push({ label: "Project", path: projectConfigPath, status: "parse-error" });
        console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
      }
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

let cachedTemporaryWritePaths: string[] | undefined;

function getTemporaryWritePaths(): string[] {
  if (cachedTemporaryWritePaths) return cachedTemporaryWritePaths;

  // allowTempDirs always includes the conventional shared temp path, even when
  // os.tmpdir() points at a platform-specific per-user directory.
  const currentTmpDir = tmpdir();
  const paths = ["/tmp", currentTmpDir, normalizePathForSandbox(currentTmpDir)];
  if (process.platform === "darwin") paths.push("/private/tmp");

  cachedTemporaryWritePaths = Array.from(
    new Set(paths.map((path) => path.replace(/\/+$/, "") || "/")),
  );
  return cachedTemporaryWritePaths;
}

function deduplicateStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function deduplicateOptionalStrings(values: string[] | undefined): string[] | undefined {
  return values ? deduplicateStrings(values) : undefined;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }

  return false;
}

function expandPathConfigEntry(value: string, field: string): string | null {
  const source = value.trim();
  if (!source) return null;

  const missingEnvNames = new Set<string>();
  const expanded = source.replace(
    ENV_PATH_REFERENCE_PATTERN,
    (_match, bracedName: string | undefined, bareName: string | undefined) => {
      const envName = bracedName ?? bareName;
      const envValue = envName ? (process.env[envName]?.trim() ?? "") : "";
      if (!envValue) {
        if (envName) missingEnvNames.add(envName);
        return "";
      }
      return envValue;
    },
  );

  if (missingEnvNames.size > 0) {
    const names = Array.from(missingEnvNames).join(", ");
    const label = missingEnvNames.size === 1 ? "environment variable" : "environment variables";
    const verb = missingEnvNames.size === 1 ? "is" : "are";
    console.error(
      `Warning: Ignoring ${field} entry because ${label} ${names} ${verb} unset or empty.`,
    );
    return null;
  }

  if (containsControlCharacter(expanded)) {
    console.error(
      `Warning: Ignoring ${field} entry because the expanded path contains control characters.`,
    );
    return null;
  }

  return expanded;
}

function expandPathConfigList(values: string[] | undefined, field: string): string[] | undefined {
  if (!values) return undefined;

  return values
    .map((value) => expandPathConfigEntry(value, field))
    .filter((value): value is string => value !== null);
}

function expandMitmProxyPathConfig(
  mitmProxy: SandboxRuntimeConfig["network"]["mitmProxy"],
): SandboxRuntimeConfig["network"]["mitmProxy"] {
  if (!mitmProxy) return undefined;
  if (!isPlainObject(mitmProxy) || typeof mitmProxy.socketPath !== "string") return mitmProxy;

  const socketPath = expandPathConfigEntry(mitmProxy.socketPath, "network.mitmProxy.socketPath");
  if (!socketPath) {
    console.error("Warning: Disabling network.mitmProxy because its socketPath did not expand.");
    return undefined;
  }

  return { ...mitmProxy, socketPath } as SandboxRuntimeConfig["network"]["mitmProxy"];
}

function expandNetworkPathConfig(
  network: SandboxRuntimeConfig["network"],
): SandboxRuntimeConfig["network"] {
  return {
    ...network,
    allowUnixSockets: expandPathConfigList(network.allowUnixSockets, "network.allowUnixSockets"),
    mitmProxy: expandMitmProxyPathConfig(network.mitmProxy),
  };
}

function expandFilesystemPathConfig(
  filesystem: SandboxRuntimeConfig["filesystem"],
): SandboxRuntimeConfig["filesystem"] {
  return {
    ...filesystem,
    denyRead: expandPathConfigList(filesystem.denyRead, "filesystem.denyRead") ?? [],
    allowRead: expandPathConfigList(filesystem.allowRead, "filesystem.allowRead"),
    allowWrite: expandPathConfigList(filesystem.allowWrite, "filesystem.allowWrite") ?? [],
    denyWrite: expandPathConfigList(filesystem.denyWrite, "filesystem.denyWrite") ?? [],
  };
}

function toRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
  const { allowGitCommonDir: _allowGitCommonDir, allowTempDirs, ...filesystem } = config.filesystem;
  const expandedNetwork = expandNetworkPathConfig(config.network);
  const expandedFilesystem = expandFilesystemPathConfig(filesystem);
  const allowWrite = allowTempDirs
    ? [...expandedFilesystem.allowWrite, ...getTemporaryWritePaths()]
    : expandedFilesystem.allowWrite;

  return {
    network: {
      ...expandedNetwork,
      allowUnixSockets: deduplicateOptionalStrings(expandedNetwork.allowUnixSockets),
    },
    filesystem: {
      ...expandedFilesystem,
      denyRead: deduplicateStrings(expandedFilesystem.denyRead),
      allowRead: deduplicateOptionalStrings(expandedFilesystem.allowRead),
      allowWrite: deduplicateStrings(allowWrite),
      denyWrite: deduplicateStrings(expandedFilesystem.denyWrite),
    },
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

function matchesSandboxRuleExactly(path: string, rule: string, cwd?: string): boolean {
  if (containsGlobChars(rule)) return false;
  return normalizeSandboxPath(path) === normalizeSandboxPath(rule, cwd);
}

function inferExactSandboxRuleMatch(path: string, rules: string[], cwd?: string): string | null {
  for (const rule of rules) {
    if (matchesSandboxRuleExactly(path, rule, cwd)) return rule;
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

function isRuntimeProtectedWriteViolation(
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

function getRuntimeProtectedWriteViolations(
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

function detectMachLookupViolationFromLine(line: string): MachLookupViolation | null {
  const match = line.match(/\bdeny\(\d+\)\s+mach-lookup\s+([^\s()"'*]+)/i);
  const service = match?.[1];
  return service ? { service } : null;
}

function detectMachLookupViolations(lines: string[]): MachLookupViolation[] {
  const violationsByService = new Map<string, MachLookupViolation>();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const violation = detectMachLookupViolationFromLine(lines[index]);
    if (violation && !violationsByService.has(violation.service)) {
      violationsByService.set(violation.service, violation);
    }
  }

  return Array.from(violationsByService.values());
}

function isValidMachLookupRule(rule: string): boolean {
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

function mutateMachLookupAllowList(
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

function detectFilesystemViolationFromLine(line: string): FilesystemViolation | null {
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
  skipViolationLines = 0,
  allowOutputFallback = true,
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

function isTraversalViolation(
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

function getTraversalPaths(options: {
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
    if (!violation || !isTraversalViolation(runtimeConfig, violation, cwd)) {
      return null;
    }
    if (violation.path && !skippedPaths.includes(violation.path)) {
      skippedPaths.push(violation.path);
    }
  }

  return skippedPaths.length > 0 ? skippedPaths : null;
}

function formatTraversalNotice(paths: string[]): string {
  if (paths.length === 0) return "";

  const visiblePaths = paths.slice(0, 3).join(", ");
  const suffix = paths.length > 3 ? ", ..." : "";
  const label = paths.length === 1 ? "path" : "paths";
  return `[sandbox] Continued after skipping protected ${label}: ${visiblePaths}${suffix}`;
}

function formatRuntimeProtectedWriteNotice(
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
  pendingPrompts?: Map<string, Promise<ViolationResolution | null>>;
  applyRuntimeConfigForSession?: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  existingViolationCount?: number;
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
    existingViolationCount,
    recordEvent,
    autoRetryAvailable = true,
    runtimeProtectedWriteViolations = [],
    allowOutputFallback = true,
  } = options;
  const violations = detectFilesystemViolations(
    output,
    rawOutput,
    existingViolationCount ?? 0,
    allowOutputFallback,
  );
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

async function handleMachLookupViolation(options: {
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
  runtimeProtectedWriteViolations: FilesystemViolation[];
}

interface ProcessedSandboxAttempt {
  exitCode: number | null;
  postamble: string;
  resolution: ViolationResolution | null;
  runtimeProtectedWriteViolations: FilesystemViolation[];
}

interface PreparedSandboxAttempt {
  attempt: BashAttemptResult;
  existingViolationCount: number;
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
  const pendingFilesystemPrompts = new Map<string, Promise<ViolationResolution | null>>();
  const pendingMachLookupPrompts = new Map<string, Promise<ViolationResolution | null>>();

  let executionQueue: Promise<void> = Promise.resolve();

  function runSerially<T>(task: () => Promise<T>): Promise<T> {
    const run = executionQueue.then(task, task);
    executionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function withSandboxDefaultEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const baseEnv = env ?? process.env;
    if (baseEnv.GIT_OPTIONAL_LOCKS !== undefined) return baseEnv;
    return { ...baseEnv, GIT_OPTIONAL_LOCKS: "0" };
  }

  async function runSandboxAttempt(
    command: string,
    wrappedCommand: string,
    cwd: string,
    runtimeConfig: SandboxRuntimeConfig | null,
    onData: (data: Buffer) => void,
    existingViolationCount: number,
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
      let seenViolationCount = existingViolationCount;
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
                SandboxManager.getSandboxViolationStore().getViolationsForCommand(command);
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

    const runtimeConfig = getRuntimeConfig();
    const attemptRuntimeConfig = runtimeConfig ? cloneRuntimeConfig(runtimeConfig) : null;
    const wrappedCommand = await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      attemptRuntimeConfig ?? undefined,
    );
    const existingViolationCount =
      SandboxManager.getSandboxViolationStore().getViolationsForCommand(command).length;

    try {
      const attempt = await runSandboxAttempt(
        command,
        wrappedCommand,
        cwd,
        attemptRuntimeConfig,
        onData,
        existingViolationCount,
        signal,
        timeout,
        env,
      );
      return { attempt, existingViolationCount, runtimeConfig: attemptRuntimeConfig };
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
    runtimeConfig: SandboxRuntimeConfig | null;
    autoRetryAvailable: boolean;
  }): Promise<ProcessedSandboxAttempt> {
    const { attempt, command, cwd, existingViolationCount, runtimeConfig, autoRetryAvailable } =
      options;
    const annotatedOutput = SandboxManager.annotateStderrWithSandboxFailures(
      command,
      attempt.combinedOutput,
    );
    // Capture violations delivered after the child closed but before post-processing.
    const storedViolationLines = SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(command)
      .slice(existingViolationCount)
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
    let postamble = extractAppendedSandboxAnnotation(
      attempt.combinedOutput,
      annotatedOutput,
      existingViolationCount,
    );

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

    const traversalPaths = getTraversalPaths({
      runtimeConfig,
      output: annotatedOutput,
      cwd,
      skipViolationLines: existingViolationCount,
    });
    const continuedTraversal = machLookupViolations.length === 0 ? traversalPaths : null;
    const effectiveExitCode = continuedTraversal ? 0 : attempt.exitCode;
    let resolution: ViolationResolution | null = null;

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
        pi,
        ctx: getContext(),
        promptMode: getPromptMode(),
        runtimeConfig: currentRuntimeConfig,
        output: annotatedOutput,
        rawOutput: attempt.combinedOutput,
        command,
        cwd,
        pendingPrompts: pendingFilesystemPrompts,
        applyRuntimeConfigForSession,
        existingViolationCount,
        recordEvent,
        autoRetryAvailable,
        runtimeProtectedWriteViolations,
        allowOutputFallback: machLookupViolations.length === 0,
      });

      if (!resolution) {
        resolution = await handleMachLookupViolation({
          pi,
          ctx: getContext(),
          promptMode: getPromptMode(),
          runtimeConfig: currentRuntimeConfig,
          violations: machLookupViolations,
          command,
          cwd,
          pendingPrompts: pendingMachLookupPrompts,
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
    async exec(command, cwd, { onData, signal, timeout, env }) {
      validateTimeout(timeout);
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
  if (state.status === "active") return state.runtimeConfig;
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
      const status =
        configPath.status === "loaded"
          ? "loaded"
          : configPath.status === "skipped-untrusted"
            ? "skipped (project not trusted)"
            : "parse error";
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

function getSkippedUntrustedProjectConfigPaths(paths: SandboxConfigPath[]): SandboxConfigPath[] {
  return paths.filter((configPath) => configPath.status === "skipped-untrusted");
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

  const createNetworkAskCallback = (): SandboxAskCallback => {
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
    notifySkippedUntrustedProjectConfigs(ctx);
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
        notifySkippedUntrustedProjectConfigs(ctx);
        const parseErrors = getSandboxConfigParseErrors(sandboxConfigPaths);
        if (parseErrors.length > 0) {
          notifySandboxConfigParseErrors(ctx, parseErrors);
        }
        sandboxConfig = loadedConfig.config;
        const runtimeConfig = await initializeSandboxRuntime(ctx, loadedConfig.config);
        if (!runtimeConfig) return;

        setSandboxStatus(ctx, true, runtimeConfig, promptMode);

        announceSandboxState(pi, ctx, true);
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
          `    allowLocalBinding: ${runtimeConfig.network.allowLocalBinding ? "true" : "false"}`,
          `    allowAllUnixSockets: ${runtimeConfig.network.allowAllUnixSockets ? "true" : "false"}`,
          `    allowUnixSockets: ${runtimeConfig.network.allowUnixSockets?.join(", ") || "(none)"}`,
          ...(IS_MACOS
            ? [
                "",
                "  macOS service lookup (mach-lookup):",
                `    Allowed: ${runtimeConfig.network.allowMachLookup?.join(", ") || "(none)"}`,
              ]
            : []),
          "",
          "  Filesystem:",
          `    Deny Read: ${runtimeConfig.filesystem.denyRead.join(", ") || "(none)"}`,
          `    Allow Read: ${runtimeConfig.filesystem.allowRead?.join(", ") || "(none)"}`,
          `    Allow Write: ${runtimeConfig.filesystem.allowWrite.join(", ") || "(none)"}`,
          `    Deny Write: ${runtimeConfig.filesystem.denyWrite.join(", ") || "(none)"}`,
          `    allowTempDirs: ${sandboxConfig?.filesystem.allowTempDirs ? "true" : "false"}`,
          `    allowGitConfig: ${runtimeConfig.filesystem.allowGitConfig ? "true" : "false"}`,
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

      if (subcommand === "mach-lookup") {
        if (!IS_MACOS) {
          notify(ctx, "Mach service lookup controls are only available on macOS.", "warning");
          return;
        }

        const runtimeConfig = requireRuntimeConfig(ctx, sandboxState);
        if (!runtimeConfig) return;

        const op = tokens[1]?.toLowerCase() as ListOp | undefined;
        const service = tokens[2]?.trim() ?? "";

        if (
          (op !== "add" && op !== "remove") ||
          tokens.length !== 3 ||
          !isValidMachLookupRule(service)
        ) {
          notify(ctx, "Usage: /sandbox mach-lookup <add|remove> <service>", "warning");
          return;
        }

        const nextConfig = cloneRuntimeConfig(runtimeConfig);
        const changed = mutateMachLookupAllowList(nextConfig, op, service);
        if (!changed) {
          notify(
            ctx,
            `No change: mach-lookup allow list already ${op === "add" ? "contains" : "omits"} ${service}`,
          );
          return;
        }

        applyRuntimeConfigForSession(ctx, nextConfig);
        notify(ctx, `Updated mach-lookup allow list (${op}: ${service})`, "info");
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
