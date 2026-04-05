import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ThinkingLevel } from "@mariozechner/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  buildSessionContext,
  createAgentSession,
  createReadOnlyTools,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

const STATUS_KEY = "btw";
const RESULT_MARKDOWN_THEME = getMarkdownTheme();
const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const BTW_APPEND_SYSTEM_PROMPT = `## BTW mode
- This is a one-off side request. The result is shown transiently and is not added to the main conversation.
- Answer the user's request directly and concisely.
- Prefer answering directly. Use tools only when they materially help.
- Tooling override for this BTW run: only these read-only tools are available: read, grep, find, ls.
- Ignore any inherited prompt text that suggests other tools are available.
- Never attempt edits, writes, or mutating shell commands in BTW mode.
- If the request requires changes or mutating commands, say so briefly and tell the user to ask in the main conversation.`;

type BtwResult = {
  question: string;
  answer: string;
};

type BtwSnapshot = {
  request: string;
  cwd: string;
  systemPrompt: string;
  seedMessages: AgentMessage[];
  model: NonNullable<ExtensionCommandContext["model"]>;
  thinkingLevel: ThinkingLevel;
  modelRegistry: ExtensionCommandContext["modelRegistry"];
};

type ActiveBtwRequest = {
  id: string;
  sessionKey: string;
  abort?: () => Promise<void>;
};

export default function btwExtension(pi: ExtensionAPI): void {
  let activeRequest: ActiveBtwRequest | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  const cancelledRequestIds = new Set<string>();

  function getCurrentSessionKey(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
  }

  function isActiveRequest(requestId: string): boolean {
    return activeRequest?.id === requestId;
  }

  function clearStatus(ctx: ExtensionContext): void {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  function startStatus(ctx: ExtensionCommandContext): void {
    clearStatus(ctx);
    if (!ctx.hasUI) return;

    let frame = 0;
    const render = () => {
      const spinner = STATUS_SPINNER_FRAMES[frame % STATUS_SPINNER_FRAMES.length];
      ctx.ui.setStatus(STATUS_KEY, `${spinner} answering...`);
    };

    render();
    statusTimer = setInterval(() => {
      frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
      render();
    }, STATUS_SPINNER_INTERVAL_MS);
  }

  async function cancelActiveRequest(): Promise<void> {
    if (!activeRequest) return;

    cancelledRequestIds.add(activeRequest.id);
    await activeRequest.abort?.().catch(() => undefined);
  }

  pi.registerCommand("btw", {
    description: "Run a one-off side request with read-only tools and no main-context persistence",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /btw <request>", "warning");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("btw requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const sessionKey = getCurrentSessionKey(ctx);
      if (activeRequest?.sessionKey === sessionKey) {
        ctx.ui.notify("A BTW request is already active in this session.", "warning");
        return;
      }

      const snapshot = buildSnapshot(ctx, pi, request);
      const requestId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      activeRequest = { id: requestId, sessionKey };
      startStatus(ctx);

      void (async () => {
        try {
          const result = await runBtwRequest(snapshot, (abort) => {
            const isCancelled = cancelledRequestIds.has(requestId);
            if (isCancelled) {
              void abort().catch(() => undefined);
            }

            if (!isActiveRequest(requestId)) return;
            const current = activeRequest;
            if (!current) return;
            activeRequest = { ...current, abort };
          });

          const isCurrentRequest = isActiveRequest(requestId);
          const wasCancelled = cancelledRequestIds.delete(requestId);
          if (isCurrentRequest) {
            activeRequest = null;
            clearStatus(ctx);
          }
          if (!isCurrentRequest || wasCancelled) return;

          await showResultDialog(ctx, result);
        } catch (error) {
          const isCurrentRequest = isActiveRequest(requestId);
          const wasCancelled = cancelledRequestIds.delete(requestId);
          if (isCurrentRequest) {
            activeRequest = null;
            clearStatus(ctx);
          }
          if (!isCurrentRequest || wasCancelled) return;

          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(message, "error");
        }
      })();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await cancelActiveRequest();
    activeRequest = null;
    cancelledRequestIds.clear();
    clearStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await cancelActiveRequest();
    clearStatus(ctx);
  });
}

function buildSnapshot(ctx: ExtensionCommandContext, pi: ExtensionAPI, request: string): BtwSnapshot {
  return {
    request,
    cwd: ctx.cwd,
    systemPrompt: ctx.getSystemPrompt(),
    seedMessages: structuredClone(
      buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
    ) as AgentMessage[],
    model: ctx.model!,
    thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
    modelRegistry: ctx.modelRegistry,
  };
}

async function runBtwRequest(
  snapshot: BtwSnapshot,
  onAbortReady?: (abort: () => Promise<void>) => void,
): Promise<BtwResult> {
  const sessionManager = SessionManager.inMemory(snapshot.cwd);
  seedSessionManager(sessionManager, snapshot.seedMessages);

  const resourceLoader = new DefaultResourceLoader({
    cwd: snapshot.cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => snapshot.systemPrompt,
    appendSystemPromptOverride: () => [BTW_APPEND_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: snapshot.cwd,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    modelRegistry: snapshot.modelRegistry,
    resourceLoader,
    tools: createReadOnlyTools(snapshot.cwd),
    sessionManager,
  });

  onAbortReady?.(() => session.abort());

  try {
    await session.prompt(snapshot.request);

    const lastAssistantMessage = getLastAssistantMessage(session.state.messages);
    if (!lastAssistantMessage) {
      throw new Error("BTW request finished without a response.");
    }

    if (lastAssistantMessage.stopReason === "aborted") {
      throw new Error("BTW request was aborted.");
    }

    if (lastAssistantMessage.stopReason === "error") {
      throw new Error(lastAssistantMessage.errorMessage || "BTW request failed.");
    }

    return {
      question: snapshot.request,
      answer: extractText(lastAssistantMessage.content) || "(No text response)",
    };
  } finally {
    try {
      await session.abort();
    } catch {
      // Ignore abort errors during cleanup.
    }
    session.dispose();
  }
}

function seedSessionManager(
  sessionManager: SessionManager,
  messages: AgentMessage[],
): void {
  type SessionMessageInput = Parameters<SessionManager["appendMessage"]>[0];

  for (const message of messages) {
    sessionManager.appendMessage(message as SessionMessageInput);
  }
}

async function showResultDialog(ctx: ExtensionContext, result: BtwResult): Promise<void> {
  await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
    return new BtwResultComponent(result, tui, ctx.ui.theme, done);
  });
}

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isAssistantMessage(message)) {
      return message;
    }
  }

  return null;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function extractText(content: AssistantMessage["content"]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

class BtwResultComponent implements Component {
  private readonly markdown: Markdown;
  private scrollOffset = 0;
  private cachedBodyWidth?: number;
  private cachedBodyLines?: string[];

  constructor(
    private readonly result: BtwResult,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onDone: () => void,
  ) {
    this.markdown = new Markdown(result.answer, 0, 0, RESULT_MARKDOWN_THEME);
  }

  invalidate(): void {
    this.cachedBodyWidth = undefined;
    this.cachedBodyLines = undefined;
    this.markdown.invalidate();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    ) {
      this.onDone();
      return;
    }

    const bodyHeight = this.getBodyHeight();
    const boxWidth = this.getBoxWidth(this.tui.terminal.columns);
    const bodyLines = this.getBodyLines(this.getContentWidth(boxWidth));
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);

    if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(4, bodyHeight - 2));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + Math.max(4, bodyHeight - 2));
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = maxScroll;
    } else {
      return;
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    const boxWidth = this.getBoxWidth(width);
    const contentWidth = this.getContentWidth(boxWidth);
    const questionLines = wrapTextWithAnsi(this.theme.fg("muted", this.result.question), contentWidth);
    const bodyLines = this.getBodyLines(contentWidth);
    const bodyHeight = this.getBodyHeight();
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll);

    const lines: string[] = [];
    lines.push(this.borderLine("╭", "╮", boxWidth));
    lines.push(this.boxLine(this.theme.bold("Request"), boxWidth));
    for (const line of questionLines) {
      lines.push(this.boxLine(line, boxWidth));
    }
    lines.push(this.separatorLine(boxWidth));

    const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    for (const line of visibleBody) {
      lines.push(this.boxLine(line, boxWidth));
    }
    for (let i = visibleBody.length; i < bodyHeight; i += 1) {
      lines.push(this.boxLine("", boxWidth));
    }

    lines.push(this.separatorLine(boxWidth));
    const scrollText = `${Math.min(bodyLines.length, this.scrollOffset + 1)}-${Math.min(bodyLines.length, this.scrollOffset + visibleBody.length)}/${bodyLines.length}`;
    const controls = `${this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn jump · Home/End · Enter/Esc close")} ${this.theme.fg("muted", scrollText)}`;
    lines.push(this.boxLine(truncateToWidth(controls, contentWidth), boxWidth));
    lines.push(this.borderLine("╰", "╯", boxWidth));

    return lines;
  }

  private getBodyHeight(): number {
    return Math.max(8, this.tui.terminal.rows - 14);
  }

  private getBodyLines(contentWidth: number): string[] {
    if (this.cachedBodyWidth === contentWidth && this.cachedBodyLines) {
      return this.cachedBodyLines;
    }

    const lines = this.markdown.render(contentWidth);
    this.cachedBodyWidth = contentWidth;
    this.cachedBodyLines = lines;
    return lines;
  }

  private getBoxWidth(width: number): number {
    return Math.max(50, Math.min(width - 2, 140));
  }

  private getContentWidth(boxWidth: number): number {
    return Math.max(10, boxWidth - 4);
  }

  private borderLine(left: string, right: string, width: number): string {
    return this.theme.fg("borderMuted", `${left}${"─".repeat(width - 2)}${right}`);
  }

  private separatorLine(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`);
  }

  private boxLine(content: string, width: number): string {
    const truncated = truncateToWidth(content, Math.max(1, width - 4), "");
    const padded = ` ${truncated}`;
    const visible = visibleWidth(padded);
    const rightPad = Math.max(0, width - 2 - visible);
    return `${this.theme.fg("borderMuted", "│")}${padded}${" ".repeat(rightPad)}${this.theme.fg("borderMuted", "│")}`;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
