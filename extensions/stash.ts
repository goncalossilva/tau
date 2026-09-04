import fs from "node:fs";
import path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_SHORTCUTS = ["alt+x"] as const;
const STATUS_KEY = "stash";
const KEYBINDINGS_PATH = path.join(getAgentDir(), "keybindings.json");

type ShortcutConfig = string | string[] | undefined;

type KeybindingsConfig = {
  stash?: ShortcutConfig;
  [key: string]: unknown;
};

function readKeybindings(filePath: string): KeybindingsConfig {
  try {
    if (!fs.existsSync(filePath)) return {};

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    return parsed as KeybindingsConfig;
  } catch {
    return {};
  }
}

function normalizeShortcuts(value: ShortcutConfig): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const normalized = values
    .map((shortcut) => shortcut.trim().toLowerCase())
    .filter((shortcut) => shortcut.length > 0);

  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_SHORTCUTS];
}

export default function stashExtension(pi: ExtensionAPI): void {
  const keybindings = readKeybindings(KEYBINDINGS_PATH);
  const shortcuts = normalizeShortcuts(keybindings.stash);

  let stashedDraft: string | null = null;
  let armed = false;

  function shortcutLabel(): string {
    return shortcuts.join(", ");
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (armed && stashedDraft !== null) {
      ctx.ui.setStatus(STATUS_KEY, `stash (${shortcutLabel()})`);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function clearStash(ctx: ExtensionContext): void {
    stashedDraft = null;
    armed = false;
    updateStatus(ctx);
  }

  function restoreDraft(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI || !armed || stashedDraft === null || ctx.ui.getEditorText()) return false;

    ctx.ui.setEditorText(stashedDraft);
    clearStash(ctx);
    return true;
  }

  function stashOrRestore(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const currentText = ctx.ui.getEditorText();

    if (armed && stashedDraft !== null) {
      if (restoreDraft(ctx)) {
        ctx.ui.notify("Stashed draft restored", "info");
      } else {
        ctx.ui.notify(
          "Send or clear the current editor text before restoring the stash",
          "warning",
        );
      }
      return;
    }

    if (!currentText) {
      ctx.ui.notify("Editor is empty, nothing to stash", "warning");
      return;
    }

    stashedDraft = currentText;
    armed = true;
    ctx.ui.setEditorText("");
    updateStatus(ctx);
    ctx.ui.notify(
      "Draft stashed. Send one message and your previous draft will come back.",
      "info",
    );
  }

  for (const shortcut of shortcuts) {
    pi.registerShortcut(shortcut as never, {
      description: "Stash the current message draft, send one message, then restore it",
      handler: async (ctx) => {
        stashOrRestore(ctx);
      },
    });
  }

  pi.on("input", async (event, ctx) => {
    if (!armed || stashedDraft === null) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (!event.text.trim()) return { action: "continue" };

    restoreDraft(ctx);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    restoreDraft(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    restoreDraft(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    restoreDraft(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    restoreDraft(ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "reload" || !ctx.hasUI || stashedDraft === null) return;

    const text = [stashedDraft, ctx.ui.getEditorText()].filter(Boolean).join("\n\n");
    ctx.ui.setEditorText(text);
    clearStash(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      clearStash(ctx);
      return;
    }
    updateStatus(ctx);
  });
}
