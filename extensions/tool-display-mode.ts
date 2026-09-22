import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  getAgentDir,
  type AppKeybinding,
  CustomEditor,
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type AgentToolResult,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ToolDefinition,
  type ToolInfo,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Loader,
  Text,
  truncateToWidth,
  type AutocompleteProvider,
  type Component,
  type EditorComponent,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type TUI,
} from "@earendil-works/pi-tui";

// --- Constants ---

const CONFIG_FILE = "tool-display-mode.json";
const MODES = ["collapsed", "expanded", "minimal"] as const;
const INITIAL_MODE = MODES[0];
const ACTIVITY_WIDGET = "tool-display-activity";

// These are current Pi built-in tool output messages, used only because grep/find/ls
// do not expose structured zero-result details yet.
const GREP_NO_MATCHES_OUTPUT = "No matches found"; // core/tools/grep.ts
const FIND_NO_MATCHES_OUTPUT = "No files found matching pattern"; // core/tools/find.ts
const LS_EMPTY_DIRECTORY_OUTPUT = "(empty directory)"; // core/tools/ls.ts

// PowerShell is intentionally omitted because Tau does not officially support Windows.
const TOOL_FACTORIES = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

// --- Types ---

type Mode = (typeof MODES)[number];
type ToolName = keyof typeof TOOL_FACTORIES;
type AnyToolDefinition = ToolDefinition<any, any, any>;
type AnyToolRenderContext = Parameters<NonNullable<AnyToolDefinition["renderResult"]>>[3];
type JsonObject = Record<string, unknown>;
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type WorkingIndicator = NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
type ActivitySource = "subagent" | "review";
type ActivityState = { text: string; idle: boolean };

type ToolDisplayModeConfig = {
  mode: Mode;
};

type CustomEditorLike = EditorComponent &
  Partial<Focusable> &
  Partial<Pick<CustomEditor, "embedWorkingStatus" | "setWorkingStatusIndicator">> & {
    actionHandlers?: Map<AppKeybinding, () => void>;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean;
    isShowingAutocomplete?: () => boolean;
  };

// --- Config ---

function emptyConfig(): ToolDisplayModeConfig {
  return { mode: INITIAL_MODE };
}

function getConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_FILE);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

function parseMode(value: unknown): Mode | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase();
  return isMode(normalized) ? normalized : undefined;
}

function parseConfig(value: unknown): ToolDisplayModeConfig {
  if (!isObject(value)) return emptyConfig();

  return {
    mode: parseMode(value.mode) ?? INITIAL_MODE,
  };
}

async function loadConfig(): Promise<ToolDisplayModeConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    return parseConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tool-display-mode] Failed to load config: ${message}`);
    }

    return emptyConfig();
  }
}

async function saveConfig(config: ToolDisplayModeConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// --- Tool definitions ---

function shouldRegisterToolRenderer(tools: ToolInfo[], name: ToolName): boolean {
  const existingTool = tools.find((tool) => tool.name === name);
  return existingTool?.sourceInfo.source === "builtin";
}

function createToolDisplayDefinition(options: {
  name: ToolName;
  getMode: () => Mode;
}): AnyToolDefinition {
  const { name, getMode } = options;
  const base: AnyToolDefinition = TOOL_FACTORIES[name](process.cwd());

  return {
    ...base,

    renderResult(result, options, theme, context) {
      const mode = getMode();
      const renderer = base.renderResult;
      const previous = context.lastComponent;

      if (mode === "minimal") {
        const component =
          previous instanceof MinimalResultComponent
            ? previous
            : new MinimalResultComponent(previous);
        if (name === "bash") {
          component.nativeComponent = renderer?.(result, options, theme, {
            ...context,
            lastComponent: component.nativeComponent,
          });
        }
        component.setText(formatMinimalResult(name, result, options, theme, context));
        return component;
      }

      const expanded = mode === "expanded";
      return (
        renderer?.(result, { ...options, expanded }, theme, {
          ...context,
          expanded,
          lastComponent:
            previous instanceof MinimalResultComponent ? previous.nativeComponent : previous,
        }) ?? emptyComponent()
      );
    },
  };
}

// --- Display mode ---

function nextMode(currentMode: Mode): Mode {
  const index = MODES.indexOf(currentMode);
  return MODES[(index + 1) % MODES.length] ?? INITIAL_MODE;
}

function applyMode(ctx: ExtensionContext, mode: Mode): void {
  if (!ctx.hasUI) return;

  ctx.ui.setToolsExpanded(mode === "expanded");
}

function showModeChange(ctx: ExtensionContext, mode: Mode): void {
  if (!ctx.hasUI) return;

  ctx.ui.notify(`Tool output: ${mode}`, "info");
}

function reportSaveError(ctx: ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (ctx.hasUI) {
    ctx.ui.notify(`Failed to save ${getConfigPath()}: ${message}`, "error");
    return;
  }

  console.warn(`[tool-display-mode] Failed to save config: ${message}`);
}

// --- Minimal rendering ---

class MinimalResultComponent extends Text {
  constructor(public nativeComponent: Component | undefined) {
    super("", 0, 0);
  }
}

function formatMinimalResult(
  name: ToolName,
  result: AgentToolResult<any>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AnyToolRenderContext,
): string {
  if (context.isError) {
    return theme.fg("error", lastNonEmptyLine(textOutput(result)) ?? "error");
  }

  if (options.isPartial) {
    return theme.fg("muted", "running...");
  }

  let summary: string;
  switch (name) {
    case "bash":
      summary = bashSummary(result);
      break;
    case "read":
      summary = readSummary(result);
      break;
    case "grep":
      summary = grepSummary(result);
      break;
    case "find":
      summary = resultsSummary(result, "path");
      break;
    case "ls":
      summary = resultsSummary(result, "entry");
      break;
  }

  return theme.fg("muted", `↳ ${summary}`);
}

function bashSummary(result: AgentToolResult<any>): string {
  const text = textOutput(result).trim();
  if (!text || text === "(no output)") return "no output";

  const details = result.details as BashToolDetails | undefined;
  const lines = details?.truncation?.outputLines ?? countLines(text);
  return `${lines} ${plural(lines, "line")}`;
}

function readSummary(result: AgentToolResult<any>): string {
  if (result.content.some((content) => content.type === "image")) {
    return "image";
  }

  const details = result.details as { truncation?: { outputLines?: number } } | undefined;
  const lines =
    details?.truncation?.outputLines ?? countLines(stripTrailingNotice(textOutput(result)));

  return `${lines} ${plural(lines, "line")}`;
}

function grepSummary(result: AgentToolResult<any>): string {
  const text = stripTrailingNotice(textOutput(result)).trim();
  if (!text || text === GREP_NO_MATCHES_OUTPUT) {
    return "0 lines";
  }

  const lines = text.split("\n").filter(Boolean);
  const matchLines = lines.filter((line) => /:\d+: /.test(line));
  const count = matchLines.length > 0 ? matchLines.length : lines.length;
  return `${count} ${plural(count, "line")}`;
}

function resultsSummary(result: AgentToolResult<any>, noun: string): string {
  const text = stripTrailingNotice(textOutput(result)).trim();
  if (!text || text === FIND_NO_MATCHES_OUTPUT || text === LS_EMPTY_DIRECTORY_OUTPUT) {
    return `0 ${plural(0, noun)}`;
  }

  const count = text.split("\n").filter(Boolean).length;
  return `${count} ${plural(count, noun)}`;
}

function textOutput(result: AgentToolResult<any>): string {
  return result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");
}

function stripTrailingNotice(text: string): string {
  return text.replace(/\n\n\[[\s\S]*\]$/, "");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function lastNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : singular === "entry" ? "entries" : `${singular}s`;
}

function emptyComponent(): Container {
  return new Container();
}

// --- Editor ---

/** Adapt public Loader output to CustomEditor's native border layout. Check parity on Pi upgrades. */
class BackgroundWorkingIndicator extends Loader implements WorkingIndicator {
  readonly kind = "working";

  dispose(): void {
    this.stop();
  }

  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(
      line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(),
      width,
      "",
    );
  }

  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }
}

class ToolDisplayEditor implements EditorComponent, Focusable {
  readonly actionHandlers: Map<AppKeybinding, () => void>;
  private readonly customBase: CustomEditorLike;
  private fallbackFocused = false;
  private fallbackOnEscape?: () => void;
  private fallbackOnCtrlD?: () => void;
  private fallbackOnPasteImage?: () => void;
  private fallbackOnExtensionShortcut?: (data: string) => boolean;
  private nativeIndicator: WorkingIndicator | undefined;
  private backgroundIndicator: BackgroundWorkingIndicator | undefined;
  private backgroundMessage: string | undefined;
  private workingMessage: string | undefined;

  constructor(
    private readonly base: EditorComponent,
    private readonly appKeybindings: KeybindingsManager,
    private readonly cycleMode: () => void,
    private readonly tui: TUI,
    private readonly getActivity: () => ActivityState | undefined,
    private readonly setWorkingMessage: (message?: string) => void,
    private readonly statusColor: (text: string) => string,
  ) {
    this.customBase = base as CustomEditorLike;
    this.actionHandlers = this.customBase.actionHandlers ?? new Map();
  }

  get focused(): boolean {
    return this.customBase.focused ?? this.fallbackFocused;
  }

  set focused(value: boolean) {
    this.fallbackFocused = value;
    if ("focused" in this.customBase) this.customBase.focused = value;
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.base.onSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.base.onSubmit = handler;
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.base.onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.base.onChange = handler;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.base.wantsKeyRelease;
  }

  get embedWorkingStatus(): boolean {
    return (
      this.customBase.embedWorkingStatus === true &&
      typeof this.customBase.setWorkingStatusIndicator === "function"
    );
  }

  setWorkingStatusIndicator(
    indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0],
  ): void {
    this.nativeIndicator = indicator;
    this.refreshActivity();
  }

  refreshActivity(): boolean {
    const activity = this.embedWorkingStatus ? this.getActivity() : undefined;
    const foregroundMessage =
      activity && this.nativeIndicator ? `Working, ${activity.text}` : undefined;
    if (foregroundMessage !== this.workingMessage) {
      this.workingMessage = foregroundMessage;
      this.setWorkingMessage(foregroundMessage);
    }

    const backgroundMessage = activity?.idle && !this.nativeIndicator ? activity.text : undefined;
    if (backgroundMessage) {
      if (!this.backgroundIndicator) {
        this.backgroundIndicator = new BackgroundWorkingIndicator(
          this.tui,
          this.statusColor,
          this.statusColor,
          backgroundMessage,
        );
      } else if (backgroundMessage !== this.backgroundMessage) {
        this.backgroundIndicator.setMessage(backgroundMessage);
      }
    } else {
      this.backgroundIndicator?.dispose();
      this.backgroundIndicator = undefined;
    }
    this.backgroundMessage = backgroundMessage;
    this.customBase.setWorkingStatusIndicator?.(this.nativeIndicator ?? this.backgroundIndicator);
    return Boolean(activity && (this.nativeIndicator || this.backgroundIndicator));
  }

  disposeActivity(): void {
    const hadBackground = this.backgroundIndicator !== undefined;
    this.backgroundIndicator?.dispose();
    this.backgroundIndicator = undefined;
    this.backgroundMessage = undefined;
    if (this.workingMessage !== undefined) {
      this.workingMessage = undefined;
      this.setWorkingMessage();
    }
    if (hadBackground) this.customBase.setWorkingStatusIndicator?.(undefined);
  }

  get borderColor(): ((str: string) => string) | undefined {
    return this.base.borderColor;
  }

  set borderColor(handler: ((str: string) => string) | undefined) {
    this.base.borderColor = handler;
  }

  get onEscape(): (() => void) | undefined {
    return this.customBase.onEscape ?? this.fallbackOnEscape;
  }

  set onEscape(handler: (() => void) | undefined) {
    this.fallbackOnEscape = handler;
    if ("onEscape" in this.customBase) this.customBase.onEscape = handler;
  }

  get onCtrlD(): (() => void) | undefined {
    return this.customBase.onCtrlD ?? this.fallbackOnCtrlD;
  }

  set onCtrlD(handler: (() => void) | undefined) {
    this.fallbackOnCtrlD = handler;
    if ("onCtrlD" in this.customBase) this.customBase.onCtrlD = handler;
  }

  get onPasteImage(): (() => void) | undefined {
    return this.customBase.onPasteImage ?? this.fallbackOnPasteImage;
  }

  set onPasteImage(handler: (() => void) | undefined) {
    this.fallbackOnPasteImage = handler;
    if ("onPasteImage" in this.customBase) this.customBase.onPasteImage = handler;
  }

  get onExtensionShortcut(): ((data: string) => boolean) | undefined {
    return this.customBase.onExtensionShortcut ?? this.fallbackOnExtensionShortcut;
  }

  set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
    this.fallbackOnExtensionShortcut = handler;
    if ("onExtensionShortcut" in this.customBase) this.customBase.onExtensionShortcut = handler;
  }

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  render(width: number): string[] {
    this.refreshActivity();
    return this.base.render(width);
  }

  invalidate(): void {
    this.backgroundIndicator?.invalidate();
    this.base.invalidate();
  }

  handleInput(data: string): void {
    if (this.appKeybindings.matches(data, "app.tools.expand")) {
      this.cycleMode();
      return;
    }

    this.base.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.base.handleMouse?.(event);
  }
}

export default function toolDisplayModeExtension(pi: ExtensionAPI): void {
  let mode: Mode = INITIAL_MODE;
  let registeredToolRenderers = false;
  let installedEditorFactory: EditorFactory | undefined;
  let previousEditorFactory: EditorFactory | undefined;
  let editor: ToolDisplayEditor | undefined;
  let context: ExtensionContext | undefined;
  let sessionKey: string | undefined;
  let activityView: object | undefined;
  let requestRender: (() => void) | undefined;
  let promptActive = false;
  let compacting = false;
  const activities = new Map<ActivitySource, string>();

  const getActivity = (): ActivityState | undefined => {
    if (
      !context ||
      !activityView ||
      context.ui.getEditorComponent() !== installedEditorFactory ||
      context.ui.getToolsExpanded() ||
      promptActive ||
      compacting
    )
      return undefined;
    const text = [activities.get("subagent"), activities.get("review")].filter(Boolean).join(", ");
    return text ? { text, idle: context.isIdle() } : undefined;
  };

  const refreshEditorActivity = (): boolean => {
    if (context && context.ui.getEditorComponent() !== installedEditorFactory) {
      editor?.disposeActivity();
      editor = undefined;
    }
    return editor?.refreshActivity() ?? false;
  };

  const refreshActivity = (): void => {
    refreshEditorActivity();
    requestRender?.();
  };

  pi.events.on("tau:activity", (data) => {
    if (!context || !isObject(data) || data.sessionKey !== sessionKey) return;
    if (data.source !== "subagent" && data.source !== "review") return;
    if (data.text !== undefined && typeof data.text !== "string") return;
    const text =
      typeof data.text === "string"
        ? stripVTControlCharacters(data.text).replace(/\s+/g, " ").trim()
        : undefined;
    const changed = activities.get(data.source) !== (text || undefined);
    if (text) activities.set(data.source, text);
    else activities.delete(data.source);
    data.handled = refreshEditorActivity();
    if (changed) requestRender?.();
  });
  pi.on("agent_start", refreshActivity);
  pi.on("agent_settled", refreshActivity);
  pi.on("ui_prompt_start", () => {
    promptActive = true;
    refreshActivity();
  });
  pi.on("ui_prompt_end", () => {
    promptActive = false;
    refreshActivity();
  });
  pi.on("session_before_compact", () => {
    compacting = true;
    refreshActivity();
  });
  const finishCompaction = (): void => {
    compacting = false;
    refreshActivity();
  };
  pi.on("session_compact", finishCompaction);
  pi.on("session_compact_failed", finishCompaction);

  const setMode = (ctx: ExtensionContext, next: Mode): void => {
    mode = next;
    applyMode(ctx, mode);
    refreshActivity();
    showModeChange(ctx, mode);

    void saveConfig({ mode }).catch((error) => reportSaveError(ctx, error));
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    mode = (await loadConfig()).mode;

    if (!registeredToolRenderers) {
      const tools = pi.getAllTools();
      for (const name of Object.keys(TOOL_FACTORIES) as ToolName[]) {
        if (!shouldRegisterToolRenderer(tools, name)) continue;

        pi.registerTool(createToolDisplayDefinition({ name, getMode: () => mode }));
      }
      registeredToolRenderers = true;
    }

    applyMode(ctx, mode);

    if (installedEditorFactory && ctx.ui.getEditorComponent() === installedEditorFactory) return;

    context = ctx.mode === "tui" ? ctx : undefined;
    sessionKey =
      ctx.sessionManager.getSessionFile() ?? `session:${ctx.sessionManager.getSessionId()}`;
    previousEditorFactory = ctx.ui.getEditorComponent();
    installedEditorFactory = (tui, theme, keybindings) => {
      editor?.disposeActivity();
      const baseEditor =
        previousEditorFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      editor = new ToolDisplayEditor(
        baseEditor,
        keybindings,
        () => setMode(ctx, nextMode(mode)),
        tui,
        getActivity,
        (message) => ctx.ui.setWorkingMessage(message),
        (text) =>
          (
            baseEditor.borderColor ??
            ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off")
          )(text),
      );
      return editor;
    };
    ctx.ui.setEditorComponent(installedEditorFactory);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(ACTIVITY_WIDGET, (tui) => {
        const owner = {};
        activityView = owner;
        requestRender = () => tui.requestRender();
        return {
          // Observe native redraws for expansion changes and replacement editors without polling.
          render() {
            if (activityView === owner) refreshEditorActivity();
            return [];
          },
          invalidate() {},
          dispose() {
            if (activityView !== owner) return;
            activityView = undefined;
            requestRender = undefined;
            editor?.disposeActivity();
          },
        };
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    activityView = undefined;
    editor?.disposeActivity();
    if (context) context.ui.setWidget(ACTIVITY_WIDGET, undefined);
    context = undefined;
    sessionKey = undefined;
    activities.clear();
    promptActive = false;
    compacting = false;
    requestRender = undefined;
    editor = undefined;
    if (ctx.hasUI && ctx.ui.getEditorComponent() === installedEditorFactory) {
      ctx.ui.setEditorComponent(previousEditorFactory);
    }

    installedEditorFactory = undefined;
    previousEditorFactory = undefined;
  });
}
