import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type Provider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  buildSessionContext,
  createAgentSession,
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const STATUS_KEY = "0-btw";
const RESULT_MARKDOWN_THEME = getMarkdownTheme();
const MIN_RESULT_WIDTH = 50;
const RESULT_CHROME_ROWS = 6;
const MIN_RESULT_ROWS = RESULT_CHROME_ROWS + 3; // Two overlay margins and one reading row.
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
const BTW_TOOL_NAMES = ["read", "grep", "find", "ls"];

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

type BtwModelRegistry = ExtensionCommandContext["modelRegistry"];

type BtwModelRuntimeState = {
  runtime: ModelRuntime;
  providers: Map<string, Provider>;
};

const btwModelRuntimes = new WeakMap<BtwModelRegistry, Promise<BtwModelRuntimeState>>();

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

      if (ctx.mode !== "tui") {
        ctx.ui.notify("btw requires TUI mode", "error");
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

function buildSnapshot(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  request: string,
): BtwSnapshot {
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
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => snapshot.systemPrompt,
    appendSystemPromptOverride: () => [BTW_APPEND_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();

  const modelRuntime = await createBtwModelRuntime(snapshot.modelRegistry, snapshot.model.provider);
  const { session } = await createAgentSession({
    cwd: snapshot.cwd,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    modelRuntime,
    resourceLoader,
    tools: BTW_TOOL_NAMES,
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

async function createBtwModelRuntime(
  modelRegistry: BtwModelRegistry,
  providerId: string,
): Promise<ModelRuntime> {
  const provider = modelRegistry.getProvider(providerId);
  if (!provider) {
    throw new Error(`Model provider is unavailable: ${providerId}`);
  }

  const state = await getBtwModelRuntimeState(modelRegistry);
  if (state.providers.get(providerId) !== provider) {
    state.runtime.registerNativeProvider(withParentAuth(provider, modelRegistry));
    state.providers.set(providerId, provider);
  }
  return state.runtime;
}

async function getBtwModelRuntimeState(
  modelRegistry: BtwModelRegistry,
): Promise<BtwModelRuntimeState> {
  let state = btwModelRuntimes.get(modelRegistry);
  if (!state) {
    state = ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    }).then((runtime) => ({ runtime, providers: new Map() }));
    btwModelRuntimes.set(modelRegistry, state);
  }

  try {
    return await state;
  } catch (error) {
    if (btwModelRuntimes.get(modelRegistry) === state) {
      btwModelRuntimes.delete(modelRegistry);
    }
    throw error;
  }
}

function withParentAuth(provider: Provider, modelRegistry: BtwModelRegistry): Provider {
  return {
    ...provider,
    refreshModels: undefined, // The parent runtime owns model catalog refreshes.
    auth: {
      ...provider.auth,
      apiKey: {
        name: `${provider.name} session authentication`,
        async resolve() {
          return modelRegistry.getProviderAuth(provider.id);
        },
      },
    },
  };
}

function seedSessionManager(sessionManager: SessionManager, messages: AgentMessage[]): void {
  type SessionMessageInput = Parameters<SessionManager["appendMessage"]>[0];

  for (const message of messages) {
    sessionManager.appendMessage(message as SessionMessageInput);
  }
}

async function showResultDialog(ctx: ExtensionContext, result: BtwResult): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new BtwResultComponent(result, tui, theme, keybindings, done),
    { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 } },
  );
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
  private renderWidth?: number;
  private cachedBodyWidth?: number;
  private cachedBodyLines?: string[];

  constructor(
    private readonly result: BtwResult,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
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

    const width = this.renderWidth ?? this.tui.terminal.columns;
    if (width < MIN_RESULT_WIDTH || this.tui.terminal.rows < MIN_RESULT_ROWS) return;

    const bodyHeight = this.getBodyHeight();
    const boxWidth = width;
    const bodyLines = this.getBodyLines(this.getContentWidth(boxWidth));
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);

    this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll);
    const kb = this.keybindings;
    if (kb.matches(data, "tui.altScreen.pageUp")) {
      this.scrollOffset -= bodyHeight;
    } else if (kb.matches(data, "tui.altScreen.pageDown")) {
      this.scrollOffset += bodyHeight;
    } else if (kb.matches(data, "tui.altScreen.halfPageUp")) {
      this.scrollOffset -= Math.max(1, Math.floor(bodyHeight / 2));
    } else if (kb.matches(data, "tui.altScreen.halfPageDown")) {
      this.scrollOffset += Math.max(1, Math.floor(bodyHeight / 2));
    } else if (kb.matches(data, "tui.altScreen.top")) {
      this.scrollOffset = 0;
    } else if (kb.matches(data, "tui.altScreen.bottom")) {
      this.scrollOffset = maxScroll;
    } else if (kb.matches(data, "tui.altScreen.lineUp")) {
      this.scrollOffset -= 1;
    } else if (kb.matches(data, "tui.altScreen.lineDown")) {
      this.scrollOffset += 1;
    } else if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.scrollOffset -= 1;
    } else if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.scrollOffset += 1;
    } else {
      return;
    }

    this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.renderWidth = width;
    if (width < 1 || this.tui.terminal.rows <= 2) return [];
    if (width < MIN_RESULT_WIDTH || this.tui.terminal.rows < MIN_RESULT_ROWS) {
      return [
        truncateToWidth(
          this.theme.fg(
            "muted",
            `Esc close · Resize to ${MIN_RESULT_WIDTH + 2}+ columns, ${MIN_RESULT_ROWS}+ rows.`,
          ),
          width,
          "",
        ),
      ];
    }

    const boxWidth = width;
    const contentWidth = this.getContentWidth(boxWidth);
    const bodyLines = this.getBodyLines(contentWidth);
    const bodyHeight = this.getBodyHeight();
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll);

    const lines: string[] = [];
    lines.push(this.borderLine("╭", "╮", boxWidth));
    lines.push(this.boxLine(this.theme.bold("BTW"), boxWidth));

    const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    for (const line of visibleBody) {
      lines.push(this.boxLine(line, boxWidth));
    }
    for (let i = visibleBody.length; i < bodyHeight; i += 1) {
      lines.push(this.boxLine("", boxWidth));
    }

    lines.push(this.separatorLine(boxWidth));
    const scrollText = `${Math.min(bodyLines.length, this.scrollOffset + 1)}-${Math.min(bodyLines.length, this.scrollOffset + visibleBody.length)}/${bodyLines.length}`;
    const navigation = [
      ["pageUp", "pageDown", "page"],
      ["top", "bottom", "ends"],
    ] as const;
    const hints = [
      "↑↓/j/k scroll",
      ...navigation.flatMap(([up, down, label]) => {
        const keys = [up, down].map((action) =>
          this.keybindings
            .getKeys(`tui.altScreen.${action}`)
            .find((key) => !["enter", "escape", "ctrl+c", "q"].includes(key)),
        );
        return keys.some(Boolean) ? [`${keys.map((key) => key ?? "—").join("/")} ${label}`] : [];
      }),
    ];
    lines.push(this.boxLine(this.theme.fg("dim", hints.join(" · ")), boxWidth));
    lines.push(this.boxLine(this.theme.fg("dim", `Enter/Esc close · ${scrollText}`), boxWidth));
    lines.push(this.borderLine("╰", "╯", boxWidth));

    return lines;
  }

  private getBodyHeight(): number {
    return this.tui.terminal.rows - 2 - RESULT_CHROME_ROWS;
  }

  private getBodyLines(contentWidth: number): string[] {
    if (this.cachedBodyWidth === contentWidth && this.cachedBodyLines) {
      return this.cachedBodyLines;
    }

    const lines = [
      this.theme.bold("Request"),
      ...wrapTextWithAnsi(this.theme.fg("muted", this.result.question), contentWidth),
      "",
      this.theme.bold("Answer"),
      ...this.markdown.render(contentWidth),
    ];
    this.cachedBodyWidth = contentWidth;
    this.cachedBodyLines = lines;
    return lines;
  }

  private getContentWidth(boxWidth: number): number {
    return boxWidth - 4;
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
