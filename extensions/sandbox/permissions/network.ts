import type { SandboxAskCallback, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  cloneRuntimeConfig,
  escapeSlashCommandArg,
  mutateStringList,
  type PromptMode,
} from "../config.js";
import { withPromptSignal } from "./dialog.js";

type NetworkEventOutcome = "blocked" | "allowed";
type NetworkEventReason = "explicit-deny-domain" | "missing-allowed-domain";

interface NetworkPermissionEvent {
  outcome: NetworkEventOutcome;
  reason: NetworkEventReason;
  target: string;
  summary: string;
  suggestedCommand?: string;
}

interface NetworkPermissions {
  ask: SandboxAskCallback;
  clear(): void;
}

export function createNetworkPermissions(options: {
  pi: ExtensionAPI;
  getContext: () => ExtensionContext | null;
  getPromptMode: () => PromptMode;
  getRuntimeConfig: () => SandboxRuntimeConfig | null;
  isSuspended: () => boolean;
  applyRuntimeConfigForSession: (
    ctx: ExtensionContext,
    runtimeConfig: SandboxRuntimeConfig,
  ) => void;
  recordEvent: (event: NetworkPermissionEvent) => void;
  notify: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void;
}): NetworkPermissions {
  const {
    pi,
    getContext,
    getPromptMode,
    getRuntimeConfig,
    isSuspended,
    applyRuntimeConfigForSession,
    recordEvent,
    notify,
  } = options;
  const pendingApprovals = new Map<string, Promise<boolean>>();

  function recordNetworkEvent(
    outcome: NetworkEventOutcome,
    reason: NetworkEventReason,
    host: string,
    port?: number,
  ): void {
    recordEvent({
      outcome,
      reason,
      target: port ? `${host}:${port}` : host,
      summary: describeNetworkEventSummary(reason, outcome),
      suggestedCommand: outcome === "blocked" ? buildNetworkBlockCommand(reason, host) : undefined,
    });
  }

  const ask: SandboxAskCallback = async ({ host, port }) => {
    if (isSuspended()) return true;

    const normalizedHost = host.toLowerCase();
    const existingDecision = pendingApprovals.get(normalizedHost);
    if (existingDecision) return existingDecision;

    const decision = (async () => {
      try {
        const initialConfig = getRuntimeConfig();
        if (!initialConfig) return false;

        if (initialConfig.network.allowedDomains.includes(normalizedHost)) return true;
        if (initialConfig.network.deniedDomains.includes(normalizedHost)) {
          recordNetworkEvent("blocked", "explicit-deny-domain", normalizedHost, port);
          return false;
        }

        const suggestedCommand = buildNetworkBlockCommand("missing-allowed-domain", normalizedHost);
        const ctx = getContext();
        if (getPromptMode() === "non-interactive" || !ctx || !ctx.hasUI) {
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

        const latestConfig = getRuntimeConfig();
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
        const changed = mutateStringList(nextConfig.network.allowedDomains, "add", normalizedHost);
        if (changed) {
          applyRuntimeConfigForSession(ctx, nextConfig);
        }

        recordNetworkEvent("allowed", "missing-allowed-domain", normalizedHost, port);
        notify(ctx, `Allowed network domain for this session: ${normalizedHost}`, "info");
        return true;
      } catch (error) {
        const ctx = getContext();
        const message = `Sandbox permission prompt failed for ${normalizedHost}: ${error instanceof Error ? error.message : error}`;
        if (ctx) notify(ctx, message, "warning");
        else console.warn(message);
        return false;
      }
    })();

    pendingApprovals.set(normalizedHost, decision);
    try {
      return await decision;
    } finally {
      pendingApprovals.delete(normalizedHost);
    }
  };

  return {
    ask,
    clear: () => pendingApprovals.clear(),
  };
}

function buildNetworkBlockCommand(reason: NetworkEventReason, host: string): string {
  if (reason === "explicit-deny-domain") {
    return `/sandbox network deny remove ${escapeSlashCommandArg(host)}`;
  }
  return `/sandbox network allow add ${escapeSlashCommandArg(host)}`;
}

function describeNetworkEventSummary(
  reason: NetworkEventReason,
  outcome: NetworkEventOutcome,
): string {
  if (outcome === "allowed") return "user allowed network domain for this session";
  if (reason === "explicit-deny-domain") return "network access matched a deny list entry";
  return "network access target is not in the allowed domain list";
}
