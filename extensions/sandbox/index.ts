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

import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSandboxedBashOps } from "./bash.js";
import { registerSandboxCommand } from "./command.js";
import { createSandboxRuntime, getSandboxRunMode } from "./runtime.js";

export default function sandboxExtension(pi: ExtensionAPI): void {
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

  const runtime = createSandboxRuntime(pi);
  const sandboxedOps = createSandboxedBashOps({
    pi,
    getContext: () => runtime.context,
    getSandboxConfig: () => runtime.config,
    getRuntimeConfig: () => runtime.getRuntimeConfig(),
    getPromptMode: () => runtime.promptMode,
    applyRuntimeConfigForSession: runtime.applyRuntimeConfigForSession,
    recordEvent: runtime.recordEvent,
  });

  let localBashTool = createBashTool(process.cwd());
  let sandboxedBashTool = createBashTool(process.cwd(), { operations: sandboxedOps });

  function rebuildBashTools(cwd: string): void {
    localBashTool = createBashTool(cwd);
    sandboxedBashTool = createBashTool(cwd, { operations: sandboxedOps });
  }

  pi.registerTool({
    ...localBashTool,
    label: "bash (sandbox-aware)",
    async execute(id, params, signal, onUpdate, ctx) {
      const state = runtime.state;
      if (state.status !== "active") {
        const allowsUnsandboxed = state.status === "bypassed" || state.status === "suspended";
        if (!allowsUnsandboxed) {
          const runMode = getSandboxRunMode(state);

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

      runtime.captureContext(ctx);
      return sandboxedBashTool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    rebuildBashTools(ctx.cwd);
    await runtime.start(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.shutdown(ctx);
    rebuildBashTools(process.cwd());
  });

  registerSandboxCommand(pi, runtime);
}
