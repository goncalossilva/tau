import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const ENTRY_TYPE = "fast-mode-state";
const SUPPORTED_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

function isFastCapable(ctx: ExtensionContext): boolean {
  return !!ctx.model && SUPPORTED_APIS.has(ctx.model.api);
}

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
  const effectiveEnabled = enabled && isFastCapable(ctx);
  ctx.ui.setStatus("fast", effectiveEnabled ? ctx.ui.theme.fg("dim", "fast") : undefined);
}

function restoreState(ctx: ExtensionContext): boolean {
  const entry = [...ctx.sessionManager.getEntries()]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE) as
    | { data?: { enabled: boolean } }
    | undefined;

  return entry?.data?.enabled ?? false;
}

export default function (pi: ExtensionAPI) {
  let enabled = false;

  function setEnabled(next: boolean, ctx: ExtensionContext): void {
    enabled = next;
    pi.appendEntry(ENTRY_TYPE, { enabled });
    updateStatus(ctx, enabled);
    ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}`, "info");

    if (enabled && !isFastCapable(ctx)) {
      ctx.ui.notify("Current model/provider ignores fast mode", "warning");
    }
  }

  pi.registerCommand("fast", {
    description: "Toggle priority service tier for OpenAI/Codex models",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "") {
        setEnabled(!enabled, ctx);
        return;
      }

      if (arg === "enable") {
        setEnabled(true, ctx);
        return;
      }

      if (arg === "disable") {
        setEnabled(false, ctx);
        return;
      }

      ctx.ui.notify("Usage: /fast [enable|disable]", "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = restoreState(ctx);
    updateStatus(ctx, enabled);
  });

  pi.on("session_switch", async (_event, ctx) => {
    enabled = restoreState(ctx);
    updateStatus(ctx, enabled);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx, enabled);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !isFastCapable(ctx)) return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

    return {
      ...(event.payload as Record<string, unknown>),
      service_tier: "priority",
    };
  });
}
