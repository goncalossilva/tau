import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AppKeybinding,
  CustomEditor,
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type AgentToolResult,
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
  Text,
  type AutocompleteProvider,
  type Component,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";

// --- Constants ---

const CONFIG_FILE = "tool-display-mode.json";
const MODES = ["default", "expanded", "minimal"] as const;
const DEFAULT_MODE = "default";

// These are current Pi built-in tool output messages, used only because grep/find/ls
// do not expose structured zero-result details yet.
const GREP_NO_MATCHES_OUTPUT = "No matches found"; // core/tools/grep.ts
const FIND_NO_MATCHES_OUTPUT = "No files found matching pattern"; // core/tools/find.ts
const LS_EMPTY_DIRECTORY_OUTPUT = "(empty directory)"; // core/tools/ls.ts

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

type ToolDisplayModeConfig = {
  mode: Mode;
};

type CustomEditorLike = EditorComponent &
  Partial<Focusable> & {
    actionHandlers?: Map<AppKeybinding, () => void>;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean;
    isShowingAutocomplete?: () => boolean;
  };

// --- Config ---

function emptyConfig(): ToolDisplayModeConfig {
  return { mode: DEFAULT_MODE };
}

function getConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, CONFIG_FILE);
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
    mode: parseMode(value.mode) ?? DEFAULT_MODE,
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

function getToolDefinition(
  cache: Map<string, Partial<Record<ToolName, AnyToolDefinition>>>,
  name: ToolName,
  cwd: string,
): AnyToolDefinition {
  let tools = cache.get(cwd);
  if (!tools) {
    tools = {};
    cache.set(cwd, tools);
  }

  return (tools[name] ??= TOOL_FACTORIES[name](cwd));
}

function shouldRegisterToolRenderer(tools: ToolInfo[], name: ToolName): boolean {
  const existingTool = tools.find((tool) => tool.name === name);
  return existingTool?.sourceInfo.source === "builtin";
}

function createToolDisplayDefinition(options: {
  cache: Map<string, Partial<Record<ToolName, AnyToolDefinition>>>;
  name: ToolName;
  getMode: () => Mode;
}): AnyToolDefinition {
  const { cache, name, getMode } = options;
  const base = getToolDefinition(cache, name, process.cwd());

  return {
    ...base,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getToolDefinition(cache, name, ctx.cwd).execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },

    renderCall(args, theme, context) {
      const renderer = getToolDefinition(cache, name, context.cwd).renderCall;
      return renderer?.(args, theme, { ...context, lastComponent: undefined }) ?? emptyComponent();
    },

    renderResult(result, options, theme, context) {
      const mode = getMode();
      const renderer = getToolDefinition(cache, name, context.cwd).renderResult;

      if (mode === "minimal") {
        if (name === "bash") {
          renderer?.(result, options, theme, { ...context, lastComponent: undefined });
        }

        return renderMinimalResult(name, result, options, theme, context);
      }

      const expanded = mode === "expanded";
      return (
        renderer?.(result, { ...options, expanded }, theme, {
          ...context,
          expanded,
          lastComponent: undefined,
        }) ?? emptyComponent()
      );
    },
  };
}

// --- Display mode ---

function nextMode(currentMode: Mode): Mode {
  const index = MODES.indexOf(currentMode);
  return MODES[(index + 1) % MODES.length] ?? DEFAULT_MODE;
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

function renderMinimalResult(
  name: ToolName,
  result: AgentToolResult<any>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AnyToolRenderContext,
): Component {
  if (context.isError) {
    return renderMinimalText(theme, "error", lastNonEmptyLine(textOutput(result)) ?? "error");
  }

  if (options.isPartial) {
    return renderMinimalText(theme, "muted", "running...");
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

  return renderMinimalText(theme, "muted", `↳ ${summary}`);
}

function renderMinimalText(theme: Theme, color: "error" | "muted", text: string): Text {
  return new Text(theme.fg(color, text), 0, 0);
}

function bashSummary(result: AgentToolResult<any>): string {
  const text = stripTrailingNotice(textOutput(result)).trim();
  if (!text || text === "(no output)") return "no output";

  const lines = countLines(text);
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
  return count === 1 ? singular : `${singular}s`;
}

function emptyComponent(): Container {
  return new Container();
}

// --- Editor ---

class ToolDisplayEditor implements EditorComponent, Focusable {
  readonly actionHandlers: Map<AppKeybinding, () => void>;
  private readonly customBase: CustomEditorLike;
  private fallbackFocused = false;
  private fallbackOnEscape?: () => void;
  private fallbackOnCtrlD?: () => void;
  private fallbackOnPasteImage?: () => void;
  private fallbackOnExtensionShortcut?: (data: string) => boolean;

  constructor(
    private readonly base: EditorComponent,
    private readonly appKeybindings: KeybindingsManager,
    private readonly cycleMode: () => void,
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
    return this.base.render(width);
  }

  invalidate(): void {
    this.base.invalidate();
  }

  handleInput(data: string): void {
    if (this.appKeybindings.matches(data, "app.tools.expand")) {
      this.cycleMode();
      return;
    }

    this.base.handleInput(data);
  }
}

export default function toolDisplayModeExtension(pi: ExtensionAPI): void {
  let mode: Mode = DEFAULT_MODE;
  let registeredToolRenderers = false;
  let installedEditorFactory: EditorFactory | undefined;
  let previousEditorFactory: EditorFactory | undefined;
  const toolCache = new Map<string, Partial<Record<ToolName, AnyToolDefinition>>>();

  const setMode = (ctx: ExtensionContext, next: Mode): void => {
    mode = next;
    applyMode(ctx, mode);
    showModeChange(ctx, mode);

    void saveConfig({ mode }).catch((error) => reportSaveError(ctx, error));
  };

  pi.on("session_start", async (_event, ctx) => {
    mode = (await loadConfig()).mode;

    if (!registeredToolRenderers) {
      const tools = pi.getAllTools();
      for (const name of Object.keys(TOOL_FACTORIES) as ToolName[]) {
        if (!shouldRegisterToolRenderer(tools, name)) continue;

        pi.registerTool(
          createToolDisplayDefinition({ cache: toolCache, name, getMode: () => mode }),
        );
      }
      registeredToolRenderers = true;
    }

    applyMode(ctx, mode);
    if (!ctx.hasUI) return;

    if (ctx.ui.getEditorComponent() === installedEditorFactory) return;

    previousEditorFactory = ctx.ui.getEditorComponent();
    installedEditorFactory = (tui, theme, keybindings) => {
      const baseEditor =
        previousEditorFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings);
      return new ToolDisplayEditor(baseEditor, keybindings, () => setMode(ctx, nextMode(mode)));
    };
    ctx.ui.setEditorComponent(installedEditorFactory);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI && ctx.ui.getEditorComponent() === installedEditorFactory) {
      ctx.ui.setEditorComponent(previousEditorFactory);
    }

    installedEditorFactory = undefined;
    previousEditorFactory = undefined;
  });
}
