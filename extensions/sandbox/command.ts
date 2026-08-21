import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  mutateStringList,
  type ListOp,
  type PromptMode,
  type SandboxConfigPath,
} from "./config.js";
import {
  describeSandboxRuntimeState,
  formatSandboxEventTimestamp,
  getSandboxRunMode,
  notify,
  type SandboxEvent,
  type SandboxRuntime,
  type SandboxState,
} from "./runtime.js";
import {
  isValidMachLookupRule,
  mutateMachLookupAllowList,
  type FilesystemList,
} from "./violations.js";

const IS_MACOS = process.platform === "darwin";

type NetworkList = "allow" | "deny";

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

function requireRuntimeConfig(
  ctx: ExtensionContext,
  runtime: SandboxRuntime,
): SandboxRuntimeConfig | null {
  const runtimeConfig = runtime.getRuntimeConfig();
  if (!runtimeConfig) {
    notify(ctx, "Sandbox is not initialized", "info");
    return null;
  }
  return runtimeConfig;
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

export function registerSandboxCommand(pi: ExtensionAPI, runtime: SandboxRuntime): void {
  pi.registerCommand("sandbox", {
    description: "Manage sandbox runtime overrides",
    getArgumentCompletions: (prefix) =>
      getSandboxArgumentCompletions(prefix, runtime.getRuntimeConfig()),
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
            state: runtime.state,
            promptMode: runtime.promptMode,
            configPaths: runtime.configPaths,
            events: runtime.events,
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

        await runtime.enable(ctx);
        return;
      }

      if (subcommand === "disable") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox disable|off", "warning");
          return;
        }

        await runtime.disable(ctx);
        return;
      }

      if (subcommand === "show") {
        if (tokens.length > 1) {
          notify(ctx, "Usage: /sandbox show", "warning");
          return;
        }

        if (runtime.state.status !== "active") {
          notify(ctx, `Sandbox is disabled (mode: ${getSandboxRunMode(runtime.state)})`, "info");
          return;
        }

        const runtimeConfig = runtime.state.runtimeConfig;
        const lines = [
          "Sandbox Configuration (session):",
          `  State: enabled`,
          `  Mode: ${runtime.promptMode}`,
          `  Runtime state: ${getSandboxRunMode(runtime.state)}`,
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
          `    allowTempDirs: ${runtime.config?.filesystem.allowTempDirs ? "true" : "false"}`,
          `    allowGitConfig: ${runtimeConfig.filesystem.allowGitConfig ? "true" : "false"}`,
          `    allowGitCommonDir: ${runtime.config?.filesystem.allowGitCommonDir ? "true" : "false"}`,
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

        runtime.setPromptMode(ctx, modeToken);
        notify(ctx, `Sandbox mode set to ${runtime.promptMode}`, "info");
        return;
      }

      if (subcommand === "network") {
        const runtimeConfig = requireRuntimeConfig(ctx, runtime);
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

        runtime.applyRuntimeConfigForSession(ctx, nextConfig);
        notify(ctx, `Updated network ${list} list (${op}: ${domain})`, "info");
        return;
      }

      if (subcommand === "mach-lookup") {
        if (!IS_MACOS) {
          notify(ctx, "Mach service lookup controls are only available on macOS.", "warning");
          return;
        }

        const runtimeConfig = requireRuntimeConfig(ctx, runtime);
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

        runtime.applyRuntimeConfigForSession(ctx, nextConfig);
        notify(ctx, `Updated mach-lookup allow list (${op}: ${service})`, "info");
        return;
      }

      if (subcommand === "filesystem") {
        const runtimeConfig = requireRuntimeConfig(ctx, runtime);
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

        runtime.applyRuntimeConfigForSession(ctx, nextConfig);
        notify(ctx, `Updated filesystem ${list} list (${op}: ${targetPath})`, "info");
        return;
      }

      notify(ctx, `Unknown subcommand: ${subcommand}. Use /sandbox for help`, "error");
    },
  });
}
