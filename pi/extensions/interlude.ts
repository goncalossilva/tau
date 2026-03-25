import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEFAULT_SHORTCUTS = ["f6", "ctrl+x"] as const;
const STATUS_KEY = "interlude";
const KEYBINDINGS_PATH = path.join(os.homedir(), ".pi", "agent", "keybindings.json");

type ShortcutConfig = string | string[] | undefined;

type KeybindingsConfig = {
  interlude?: ShortcutConfig;
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

export default function interludeExtension(pi: ExtensionAPI): void {
  const keybindings = readKeybindings(KEYBINDINGS_PATH);
  const shortcuts = normalizeShortcuts(keybindings.interlude);

  let stashedDraft: string | null = null;
  let armed = false;

  function shortcutLabel(): string {
    return shortcuts.join(", ");
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (armed && stashedDraft !== null) {
      ctx.ui.setStatus(STATUS_KEY, `interlude (${shortcutLabel()})`);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function clearStash(ctx: ExtensionContext): void {
    stashedDraft = null;
    armed = false;
    updateStatus(ctx);
  }

  function restoreDraft(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !armed || stashedDraft === null) return;

    const draftToRestore = stashedDraft;
    clearStash(ctx);
    ctx.ui.setEditorText(draftToRestore);
  }

  function stashOrRestore(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const currentText = ctx.ui.getEditorText();

    if (armed && stashedDraft !== null) {
      restoreDraft(ctx);
      ctx.ui.notify("Interlude draft restored", "info");
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
    ctx.ui.notify("Draft stashed. Send one message and your previous draft will come back.", "info");
  }

  for (const shortcut of shortcuts) {
    pi.registerShortcut(shortcut as never, {
      description: "Stash the current draft, send one interlude message, then restore the draft",
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

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    clearStash(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    clearStash(ctx);
  });
}
