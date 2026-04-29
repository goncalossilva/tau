/**
 * Loop Extension
 *
 * Provides a /loop command that starts a follow-up loop with a breakout condition.
 * The loop keeps sending a prompt on turn end until the agent calls the
 * signal_loop_success tool.
 */

import { Type } from "typebox";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
  compact,
  defineTool,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

const LOOP_PRESETS = [
  { value: "tests", label: "Until tests pass", description: "" },
  { value: "custom", label: "Until custom condition", description: "" },
  { value: "self", label: "Self driven (agent decides)", description: "" },
] as const;

const LOOP_STATE_ENTRY = "loop-state";
const OPENAI_FAST_MODEL_ID = "gpt-5.3-codex-spark";
const ANTHROPIC_FAST_MODEL_ID = "claude-haiku-4-5";

const SUMMARY_SYSTEM_PROMPT = `You summarize loop breakout conditions for a status widget.
Return a concise phrase (max 6 words) that says when the loop should stop.
Use plain text only, no quotes, no punctuation, no prefix.

Form should be "breaks when ...", "loops until ...", "stops on ...", "runs until ...", or similar.
Use the best form that makes sense for the loop condition.
`;

type LoopMode = "tests" | "custom" | "self";

type LoopStateData = {
  active: boolean;
  mode?: LoopMode;
  condition?: string;
  prompt?: string;
  summary?: string;
  loopCount?: number;
};

type PromptStatus = "completed" | "error";
type ModelFamily = "openai" | "anthropic";

type ModelRequestAuth = {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
};

async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
  pi.events.emit("ui:prompt_start", { source: "loop" });

  let status: PromptStatus = "completed";
  try {
    return await run();
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    pi.events.emit("ui:prompt_end", { source: "loop", status });
  }
}

function detectModelFamily(provider: string): ModelFamily | null {
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider.includes("openai")) return "openai";
  if (normalizedProvider.includes("anthropic")) return "anthropic";
  return null;
}

function buildPrompt(mode: LoopMode, condition?: string): string {
  switch (mode) {
    case "tests":
      return (
        "Run all tests. If they are passing, call the signal_loop_success tool. " +
        "Otherwise continue until the tests pass."
      );
    case "custom": {
      const customCondition = condition?.trim() || "the custom condition is satisfied";
      return (
        `Continue until the following condition is satisfied: ${customCondition}. ` +
        "When it is satisfied, call the signal_loop_success tool."
      );
    }
    case "self":
      return "Continue until you are done. When finished, call the signal_loop_success tool.";
  }
}

function summarizeCondition(mode: LoopMode, condition?: string): string {
  switch (mode) {
    case "tests":
      return "tests pass";
    case "custom": {
      const summary = condition?.trim() || "custom condition";
      return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
    }
    case "self":
      return "done";
  }
}

function getConditionText(mode: LoopMode, condition?: string): string {
  switch (mode) {
    case "tests":
      return "tests pass";
    case "custom":
      return condition?.trim() || "custom condition";
    case "self":
      return "you are done";
  }
}

async function selectSummaryModel(ctx: ExtensionContext): Promise<ModelRequestAuth | null> {
  if (!ctx.model) return null;

  const family = detectModelFamily(ctx.model.provider);
  if (family) {
    const modelId = family === "openai" ? OPENAI_FAST_MODEL_ID : ANTHROPIC_FAST_MODEL_ID;
    const providerCandidates =
      family === "openai"
        ? [ctx.model.provider, "openai-codex", "openai"]
        : [ctx.model.provider, "anthropic"];

    for (const provider of new Set(providerCandidates)) {
      const candidate = ctx.modelRegistry.find(provider, modelId);
      if (!candidate) continue;

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
      if (auth.ok) {
        return { model: candidate, apiKey: auth.apiKey, headers: auth.headers };
      }
    }
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  return auth.ok ? { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers } : null;
}

async function summarizeBreakoutCondition(
  ctx: ExtensionContext,
  mode: LoopMode,
  condition?: string,
): Promise<string> {
  const fallback = summarizeCondition(mode, condition);
  const selection = await selectSummaryModel(ctx);
  if (!selection) return fallback;

  const conditionText = getConditionText(mode, condition);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: conditionText }],
    timestamp: Date.now(),
  };

  const response = await complete(
    selection.model,
    { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: selection.apiKey, headers: selection.headers },
  );

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    return fallback;
  }

  const summary = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!summary) return fallback;
  return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
}

function getCompactionInstructions(mode: LoopMode, condition?: string): string {
  const conditionText = getConditionText(mode, condition);
  return `Loop active. Breakout condition: ${conditionText}. Preserve this loop state and breakout condition in the summary.`;
}

function updateStatus(ctx: ExtensionContext, state: LoopStateData): void {
  if (!ctx.hasUI) return;
  if (!state.active || !state.mode) {
    ctx.ui.setWidget("loop", undefined);
    return;
  }
  const loopCount = state.loopCount ?? 0;
  const turnText = `(turn ${loopCount})`;
  const summary = state.summary?.trim();
  const text = summary ? `Loop active: ${summary} ${turnText}` : `Loop active ${turnText}`;
  ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", text)]);
}

async function loadState(ctx: ExtensionContext): Promise<LoopStateData> {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; customType?: string; data?: LoopStateData };
    if (entry.type === "custom" && entry.customType === LOOP_STATE_ENTRY && entry.data) {
      return entry.data;
    }
  }
  return { active: false };
}

export default function loopExtension(pi: ExtensionAPI): void {
  let loopState: LoopStateData = { active: false };

  function persistState(state: LoopStateData): void {
    pi.appendEntry(LOOP_STATE_ENTRY, state);
  }

  function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
    loopState = state;
    persistState(state);
    updateStatus(ctx, state);
  }

  function clearLoopState(ctx: ExtensionContext): void {
    const cleared: LoopStateData = { active: false };
    loopState = cleared;
    persistState(cleared);
    updateStatus(ctx, cleared);
  }

  function breakLoop(ctx: ExtensionContext): void {
    clearLoopState(ctx);
    ctx.ui.notify("Loop ended", "info");
  }

  function wasLastAssistantAborted(
    messages: Array<{ role?: string; stopReason?: string }>,
  ): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "assistant") {
        return message.stopReason === "aborted";
      }
    }
    return false;
  }

  function triggerLoopPrompt(ctx: ExtensionContext): void {
    const prompt = loopState.prompt;
    if (!loopState.active || !loopState.mode || !prompt) return;
    if (ctx.hasPendingMessages()) return;

    const loopCount = (loopState.loopCount ?? 0) + 1;
    loopState = { ...loopState, loopCount };
    persistState(loopState);
    updateStatus(ctx, loopState);

    pi.sendMessage(
      {
        customType: "loop",
        content: prompt,
        display: true,
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  }

  async function showLoopSelector(ctx: ExtensionContext): Promise<LoopStateData | null> {
    const items: SelectItem[] = LOOP_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }));

    const selection = await withPromptSignal(pi, () =>
      ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select a loop preset"))));

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);

        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      }),
    );

    if (!selection) return null;

    switch (selection) {
      case "tests":
        return { active: true, mode: "tests", prompt: buildPrompt("tests") };
      case "self":
        return { active: true, mode: "self", prompt: buildPrompt("self") };
      case "custom": {
        const condition = await withPromptSignal(pi, () =>
          ctx.ui.editor("Enter loop breakout condition:", ""),
        );
        if (!condition?.trim()) return null;
        return {
          active: true,
          mode: "custom",
          condition: condition.trim(),
          prompt: buildPrompt("custom", condition.trim()),
        };
      }
      default:
        return null;
    }
  }

  function parseArgs(args: string | undefined): LoopStateData | null {
    if (!args?.trim()) return null;
    const parts = args.trim().split(/\s+/);
    const mode = parts[0]?.toLowerCase();

    switch (mode) {
      case "tests":
        return { active: true, mode: "tests", prompt: buildPrompt("tests") };
      case "self":
        return { active: true, mode: "self", prompt: buildPrompt("self") };
      case "custom": {
        const condition = parts.slice(1).join(" ").trim();
        if (!condition) return null;
        return {
          active: true,
          mode: "custom",
          condition,
          prompt: buildPrompt("custom", condition),
        };
      }
      default:
        return null;
    }
  }

  function getLoopArgumentCompletions(
    prefix: string,
  ): Array<{ value: string; label: string }> | null {
    const trimmed = prefix.trim().toLowerCase();
    if (trimmed.includes(" ")) return null;

    const options = [
      { value: "tests", label: "tests" },
      { value: "self", label: "self" },
      { value: "custom ", label: "custom" },
    ];
    const matches = options.filter((option) => option.label.startsWith(trimmed));
    if (!matches.length) return null;

    return matches;
  }

  pi.registerTool(
    defineTool({
      name: "signal_loop_success",
      label: "Signal Loop Success",
      description:
        "Stop the active loop when the breakout condition is satisfied. Only call this tool when explicitly instructed to do so by the user, tool or system prompt.",
      promptSnippet: "Signal that the active /loop breakout condition has been satisfied",
      promptGuidelines: [
        "Call this tool only when the active loop's breakout condition is actually satisfied.",
        "Do not call this tool unless a loop is currently active.",
      ],
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        if (!loopState.active) {
          return {
            content: [{ type: "text", text: "No active loop is running." }],
            details: { active: false },
          };
        }

        clearLoopState(ctx);

        return {
          content: [{ type: "text", text: "Loop ended." }],
          details: { active: false },
        };
      },
    }),
  );

  pi.registerCommand("loop", {
    description: "Start a follow-up loop until a breakout condition is met",
    getArgumentCompletions: getLoopArgumentCompletions,
    handler: async (args, ctx) => {
      let nextState = parseArgs(args);
      if (!nextState) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /loop tests | /loop custom <condition> | /loop self", "warning");
          return;
        }
        nextState = await showLoopSelector(ctx);
      }

      if (!nextState) {
        ctx.ui.notify("Loop cancelled", "info");
        return;
      }

      if (loopState.active) {
        const confirm = ctx.hasUI
          ? await withPromptSignal(pi, () =>
              ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?"),
            )
          : true;
        if (!confirm) {
          ctx.ui.notify("Loop unchanged", "info");
          return;
        }
      }

      const summarizedState: LoopStateData = { ...nextState, summary: undefined, loopCount: 0 };
      setLoopState(summarizedState, ctx);
      ctx.ui.notify("Loop active", "info");
      triggerLoopPrompt(ctx);

      const mode = nextState.mode!;
      const condition = nextState.condition;
      void (async () => {
        const summary = await summarizeBreakoutCondition(ctx, mode, condition);
        if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition)
          return;
        loopState = { ...loopState, summary };
        persistState(loopState);
        updateStatus(ctx, loopState);
      })();
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!loopState.active) return;

    if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
      const confirm = await withPromptSignal(pi, () =>
        ctx.ui.confirm("Break active loop?", "Operation aborted. Break out of the loop?"),
      );
      if (confirm) {
        breakLoop(ctx);
        return;
      }
    }

    triggerLoopPrompt(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!loopState.active || !loopState.mode || !ctx.model) return;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) return;

    const instructionParts = [
      event.customInstructions,
      getCompactionInstructions(loopState.mode, loopState.condition),
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const compaction = await compact(
        event.preparation,
        ctx.model,
        auth.apiKey,
        auth.headers,
        instructionParts,
        event.signal,
      );
      return { compaction };
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Loop compaction failed: ${message}`, "warning");
      }
      return;
    }
  });

  async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
    loopState = await loadState(ctx);
    updateStatus(ctx, loopState);

    if (loopState.active && loopState.mode && !loopState.summary) {
      const mode = loopState.mode;
      const condition = loopState.condition;
      void (async () => {
        const summary = await summarizeBreakoutCondition(ctx, mode, condition);
        if (!loopState.active || loopState.mode !== mode || loopState.condition !== condition)
          return;
        loopState = { ...loopState, summary };
        persistState(loopState);
        updateStatus(ctx, loopState);
      })();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreLoopState(ctx);
  });
}
