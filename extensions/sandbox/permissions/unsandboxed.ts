import { homedir } from "node:os";
import {
  DynamicBorder,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Text,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export const UNSANDBOXED_APPROVAL_CHOICES = ["Deny", "Run once outside sandbox"] as const;

export function isUnsandboxedApproval(choices: readonly string[]): boolean {
  return (
    choices.length === UNSANDBOXED_APPROVAL_CHOICES.length &&
    choices.every((choice, index) => choice === UNSANDBOXED_APPROVAL_CHOICES[index])
  );
}

/** Use Pi's editor-area dialog. RPC presentation belongs to its human client. */
export async function showUnsandboxedApproval(
  ctx: ExtensionContext,
  title: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui" || signal?.aborted) return undefined;
  let cancel: (() => void) | undefined;
  try {
    const result = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
      cancel = () => done(undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      return new UnsandboxedApproval(title, tui, theme, keybindings, (choice) =>
        done(signal?.aborted ? undefined : choice),
      );
    });
    return signal?.aborted ? undefined : result;
  } catch {
    return undefined;
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

/** Shell-style details for both the local dialog and forwarded RPC approvals. */
export function formatUnsandboxedApproval(command: string, cwd: string): string {
  const home = homedir();
  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  const directory =
    cwd === home ? "~" : cwd.startsWith(homePrefix) ? `~/${cwd.slice(homePrefix.length)}` : cwd;
  return [
    "Run once outside sandbox?",
    "",
    escapeControls(directory).replaceAll("\n", "\\u000a"),
    `$ ${escapeControls(command)}`,
    "",
    "This command and its descendants get host filesystem and network access.",
  ].join("\n");
}

/** The cursor keeps the focused review line or choice visible when Pi shrinks its editor dock. */
class UnsandboxedApproval implements Component, Focusable {
  focused = false;
  private readonly content = new Text("", 0, 0);
  private readonly titleLines: string[];
  private readonly directoryLine: number;
  private selected = 0;
  private reviewLine: number | undefined;
  private scrollTop = 0;
  private contentLines: string[] = [];
  private viewportHeight = 0;
  private renderedWidth = 0;
  private renderedHeight = 0;
  private canApprove = false;

  constructor(
    title: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (choice: string | undefined) => void,
  ) {
    this.titleLines = escapeControls(title).split("\n");
    this.directoryLine = this.titleLines.findIndex((line) => line.startsWith("$ ")) - 1;
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    const height = Math.min(16, Math.max(0, rows - 2));
    if (width !== this.renderedWidth || rows !== this.renderedHeight) this.selected = 0;
    this.renderedWidth = width;
    this.renderedHeight = rows;
    this.canApprove = false;
    // Fullscreen owns unmodified PageUp/PageDown and Home/End before dialog input.
    // Advertise the configured editor aliases that can actually reach this dialog.
    const viewportKeys = new Set(
      this.tui.mode === "fullscreen"
        ? Object.keys(TUI_KEYBINDINGS)
            .filter((action) => action.startsWith("tui.altScreen."))
            .flatMap((action) => this.keybindings.getKeys(action as keyof typeof TUI_KEYBINDINGS))
        : [],
    );
    const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      this.keybindings
        .getKeys(action)
        .find((binding) => !action.startsWith("tui.editor.") || !viewportKeys.has(binding)) ??
      "unbound";
    const border = new DynamicBorder((line) => this.theme.fg("border", line)).render(width);
    const gap = height >= 14 ? [""] : [];
    this.content.setText(
      this.titleLines
        .map((line, index) =>
          index === this.directoryLine
            ? this.theme.fg("dim", line)
            : line.startsWith("$ ")
              ? this.theme.fg("text", line)
              : line,
        )
        .join("\n"),
    );
    this.contentLines = this.content.render(Math.max(1, width - 2));
    const choices = UNSANDBOXED_APPROVAL_CHOICES.flatMap((choice, index) =>
      new Text(
        this.theme.fg(
          index === this.selected ? "accent" : "text",
          `${this.focused && this.reviewLine === undefined && index === this.selected ? CURSOR_MARKER : ""}${index === this.selected ? "→" : " "} ${choice}`,
        ),
        1,
        0,
      ).render(width),
    );
    const navigation =
      key("tui.select.up") === "up" && key("tui.select.down") === "down"
        ? "↑↓"
        : `${key("tui.select.up")}/${key("tui.select.down")}`;
    const hint = (binding: string, description: string) =>
      this.theme.fg("dim", binding) + this.theme.fg("muted", ` ${description}`);
    const hints = new Text(
      `${hint(navigation, "navigate")}  ${hint(key("tui.select.confirm"), "select")}  ${hint(key("tui.select.cancel"), "cancel")}`,
      1,
      0,
    ).render(width);
    this.viewportHeight =
      height - border.length * 2 - gap.length * 4 - choices.length - hints.length;
    const reviewHints =
      this.contentLines.length > this.viewportHeight || this.reviewLine !== undefined
        ? new Text(
            this.theme.fg(
              "dim",
              `${key("tui.editor.pageUp")}/${key("tui.editor.pageDown")} review lines · ${key("tui.editor.cursorLineStart")}/${key("tui.editor.cursorLineEnd")} top/end`,
            ),
            1,
            0,
          ).render(width)
        : [];
    this.viewportHeight -= reviewHints.length;
    if (width < 3 || this.viewportHeight < 1) {
      return new Text("Resize to review. Escape denies.", 0, 0)
        .render(Math.max(1, width))
        .slice(0, Math.max(0, height));
    }
    this.viewportHeight = Math.min(this.viewportHeight, this.contentLines.length);
    if (this.reviewLine !== undefined) {
      this.reviewLine = Math.min(this.reviewLine, this.contentLines.length - 1);
      this.scrollTop = Math.max(0, this.reviewLine - this.viewportHeight + 1);
    }
    this.scrollTop = Math.min(
      this.scrollTop,
      Math.max(0, this.contentLines.length - this.viewportHeight),
    );
    this.canApprove =
      this.focused &&
      this.reviewLine === undefined &&
      this.selected === 1 &&
      width >= visibleWidth(` → ${UNSANDBOXED_APPROVAL_CHOICES[1]} `);
    const visible = Array.from({ length: this.viewportHeight }, (_, index) => {
      const row = this.scrollTop + index;
      const line = this.contentLines[row] ?? "";
      const cursor = this.focused && row === this.reviewLine ? CURSOR_MARKER : "";
      const text = row === 0 ? this.theme.fg("accent", this.theme.bold(line)) : line;
      return ` ${cursor}${text}`;
    });
    return [
      ...border,
      ...gap,
      ...visible,
      ...gap,
      ...choices,
      ...gap,
      ...hints,
      ...reviewHints,
      ...gap,
      ...border,
    ];
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (
      this.renderedWidth !== this.tui.terminal.columns ||
      this.renderedHeight !== this.tui.terminal.rows
    ) {
      this.canApprove = false;
      this.selected = 0;
      this.tui.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      if (this.selected === 0) this.done("Deny");
      else if (this.canApprove) this.done("Run once outside sandbox");
      return;
    }
    if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      this.selected = kb.matches(data, "tui.select.down") && this.viewportHeight > 0 ? 1 : 0;
      this.reviewLine = undefined;
      this.canApprove = false;
    }
    // Pi does not expose the editor dock's height. Advance one review line so its
    // cursor can reveal every line even when only part of this component fits.
    else if (kb.matches(data, "tui.editor.pageUp")) this.scroll(-1);
    else if (kb.matches(data, "tui.editor.pageDown")) this.scroll(1);
    else if (kb.matches(data, "tui.editor.cursorLineStart")) this.scroll(-this.contentLines.length);
    else if (kb.matches(data, "tui.editor.cursorLineEnd")) this.scroll(this.contentLines.length);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel") return undefined;
    this.scroll(event.wheelDelta ?? 0);
    return { handled: true, render: true };
  }

  invalidate(): void {
    this.content.invalidate();
  }

  private scroll(lines: number): void {
    this.selected = 0;
    this.canApprove = false;
    this.reviewLine = Math.max(
      0,
      Math.min(this.contentLines.length - 1, (this.reviewLine ?? 0) + lines),
    );
  }
}

/** Preserve layout newlines while making untrusted terminal and Unicode controls inert. */
function escapeControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character === "\n"
      ? character
      : character
          .split("")
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
  );
}
