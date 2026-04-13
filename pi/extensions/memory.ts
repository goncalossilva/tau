import { complete, StringEnum, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
  defineTool,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";

const MEMORY_DIR_NAME = ".memory";
const CORE_BLOCK_NAMES = ["directives", "context", "focus", "pending"] as const;
const LOG_TYPES = [
  "decide",
  "ingest",
  "experiment",
  "plan",
  "prompt",
  "sleep",
  "gap",
  "lint",
] as const;

const CORE_LINE_CAP = 300;
const SLEEP_HINT_THRESHOLD = 20;
const LOG_TAIL_LINES = 100;
const DEFAULT_LOG_IMPORTANCE = 4;
const SLEEP_LOG_IMPORTANCE = 7;

const MEMORY_UPDATE_BLOCK_PARAMS = Type.Object({
  name: StringEnum(CORE_BLOCK_NAMES, { description: "Core block name" }),
  content: Type.String({ description: "Markdown content for the core block" }),
  importance: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 10, description: "Importance hint (1-10)" }),
  ),
});

const MEMORY_APPEND_LOG_PARAMS = Type.Object({
  type: StringEnum(LOG_TYPES, { description: "Log entry type" }),
  title: Type.String({ minLength: 1, description: "Short log entry title" }),
  body: Type.String({ description: "Markdown log entry body" }),
  importance: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 10, description: "Importance (1-10)" }),
  ),
});

const MEMORY_SLEEP_PARAMS = Type.Object({
  reason: Type.Optional(Type.String({ description: "Why memory consolidation is needed" })),
});

const MEMORY_SLEEP_SYSTEM_PROMPT = `You consolidate project-local repo memory.

Return valid JSON only. No markdown. No prose outside JSON.

Schema:
{
  "candidates": [
    {"title": "...", "content": "...", "sources": ["..."]}
  ],
  "blocks": {
    "directives": "...",
    "context": "...",
    "focus": "...",
    "pending": "..."
  },
  "log_entry": "...",
  "drift": [
    {
      "type": "misalignment | omission | contradiction | scope-creep",
      "description": "...",
      "source": "...",
      "expected": "...",
      "actual": "..."
    }
  ],
  "open_questions": ["..."]
}

Rules:
- Sleep is the only consolidation mechanism. Drift correction happens during sleep.
- Keep total lines across directives, context, focus, and pending under 300 after consolidation.
- Never modify current_brief.md.
- Never remove items from pending without resolution or explicit abandonment described in log_entry.
- Use candidates for durable long-form knowledge that belongs in wiki/reflections, not core.
- Keep core blocks short, concrete, and high-signal.
- Drift correction is mandatory.
- Drift includes: objectives in focus.md not aligned with current_brief.md; work in context.md or wiki/ that does not contribute to the brief; missing deliverables implied by the brief; contradictions between current decisions and brief constraints.
- If drift exists, do not update core blocks in ways that deepen drift. Only surface drift or explicitly correct it.
- Self-check that JSON.parse(output) succeeds before responding.`;

type MemoryBlockName = (typeof CORE_BLOCK_NAMES)[number];
type LogType = (typeof LOG_TYPES)[number];

type CoreBlocks = Record<MemoryBlockName, string>;

type MemoryState = {
  last_sleep_at: string | null;
  turns_since_sleep: number;
};

type CoreReadResult = {
  exists: boolean;
  blocks: CoreBlocks;
  missing: MemoryBlockName[];
  totalLines: number;
};

type MemoryStatus = {
  initialized: boolean;
  coreExists: boolean;
  coreLines: number;
  missingCoreFiles: MemoryBlockName[];
  lastSleepAt: string | null;
  turnsSinceSleep: number;
  hasCurrentBrief: boolean;
  hasLog: boolean;
};

type LogEntry = {
  timestamp: string;
  type: LogType;
  importance: number;
  title: string;
  body: string;
};

type SleepCandidate = {
  title: string;
  content: string;
  sources: string[];
};

type DriftType = "misalignment" | "omission" | "contradiction" | "scope-creep";

type DriftEntry = {
  type: DriftType;
  description: string;
  source: string;
  expected: string;
  actual: string;
};

type SleepOutput = {
  candidates: SleepCandidate[];
  blocks: Partial<CoreBlocks>;
  logEntry: string;
  drift: DriftEntry[];
  openQuestions: string[];
};

type SleepResult = {
  summary: string;
  updatedBlocks: MemoryBlockName[];
  reflectionPaths: string[];
  driftCount: number;
  openQuestionCount: number;
  lastSleepAt: string;
};

type SleepReplay = {
  blocks: CoreBlocks;
  totalLines: number;
  logTail: string;
  currentBrief: string | null;
};

type ModelSelection = {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
};

export default function memoryExtension(pi: ExtensionAPI): void {
  let memoryPromptGuideline: string | undefined;
  let skipNextAgentEndIncrement = false;

  const refreshMemoryPrompt = async (ctx: ExtensionContext): Promise<void> => {
    memoryPromptGuideline = await loadMemoryPromptGuideline(ctx.cwd, ctx);
    registerTools();
  };

  const registerTools = (): void => {
    pi.registerTool(
      defineTool({
        name: "memory_update_block",
        label: "Memory Update Block",
        description: "Update one .memory/core block while enforcing the shared 300-line cap",
        promptSnippet: "Update one core memory block in .memory/core with 300-line cap enforcement",
        promptGuidelines: [
          "Use this tool when updating .memory/core/directives.md, context.md, focus.md, or pending.md.",
          "If a write would exceed the 300-line core cap, run memory_sleep or remove content first.",
        ],
        parameters: MEMORY_UPDATE_BLOCK_PARAMS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const result = await updateCoreBlock(ctx.cwd, params.name, params.content);
          await refreshMemoryPrompt(ctx);

          return {
            content: [
              {
                type: "text",
                text: `Updated .memory/core/${params.name}.md (${result.totalLines}/${CORE_LINE_CAP} lines total).`,
              },
            ],
            details: {
              block: params.name,
              total_lines: result.totalLines,
              importance: params.importance,
            },
          };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "memory_append_log",
        label: "Memory Append Log",
        description: "Append an entry to .memory/log.md using the repo memory log format",
        promptSnippet: "Append an entry to the repo memory log at .memory/log.md",
        promptGuidelines: [
          "Use this tool for non-trivial decisions, discoveries, experiments, plans, or prompt ingests worth remembering.",
          "The memory log is append-only. Do not rewrite or truncate older entries.",
        ],
        parameters: MEMORY_APPEND_LOG_PARAMS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const entry = await appendMemoryLog(
            ctx.cwd,
            params.type,
            params.title,
            params.body,
            params.importance,
          );

          return {
            content: [
              {
                type: "text",
                text: `Appended .memory/log.md entry: ${entry.title}.`,
              },
            ],
            details: entry,
          };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "memory_sleep",
        label: "Memory Sleep",
        description:
          "Manually consolidate repo memory, compress core blocks, write reflections, and surface drift",
        promptSnippet: "Manually consolidate repo memory with sleep-based consolidation",
        promptGuidelines: [
          "Use this tool for manual memory consolidation. Sleep is never automatic.",
          "Sleep is the only consolidation mechanism. Use it to compress context and surface drift against the current brief.",
          ...(memoryPromptGuideline ? [memoryPromptGuideline] : []),
        ],
        parameters: MEMORY_SLEEP_PARAMS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const result = await runMemorySleep(ctx.cwd, ctx, params.reason);
          skipNextAgentEndIncrement = true;
          await refreshMemoryPrompt(ctx);

          return {
            content: [{ type: "text", text: result.summary }],
            details: result,
          };
        },
      }),
    );
  };

  registerTools();

  pi.registerCommand("memory", {
    description: "Manage project-local memory in .memory/",
    getArgumentCompletions: getMemoryArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseMemoryCommandArgs(args);
      if (!parsed) {
        notify(
          ctx,
          "Usage: /memory init | status | sleep [reason] | log <text> | focus <text>",
          "warning",
        );
        return;
      }

      switch (parsed.command) {
        case "init": {
          const result = await initMemory(ctx.cwd);
          await refreshMemoryPrompt(ctx);
          notify(ctx, formatInitResult(result), "info");
          return;
        }
        case "status": {
          const status = await loadMemoryStatus(ctx.cwd);
          notify(ctx, formatMemoryStatus(status), "info");
          return;
        }
        case "sleep": {
          await runMemorySleep(ctx.cwd, ctx, parsed.text || undefined);
          await refreshMemoryPrompt(ctx);
          return;
        }
        case "log": {
          if (!parsed.text) {
            notify(ctx, "Usage: /memory log <text>", "warning");
            return;
          }
          const entry = await appendMemoryLog(
            ctx.cwd,
            "prompt",
            deriveLogTitle(parsed.text),
            parsed.text,
            DEFAULT_LOG_IMPORTANCE,
          );
          notify(ctx, `Appended .memory/log.md entry: ${entry.title}.`, "info");
          return;
        }
        case "focus": {
          if (!parsed.text) {
            notify(ctx, "Usage: /memory focus <text>", "warning");
            return;
          }
          const result = await updateCoreBlock(ctx.cwd, "focus", parsed.text);
          await refreshMemoryPrompt(ctx);
          notify(
            ctx,
            `Updated .memory/core/focus.md (${result.totalLines}/${CORE_LINE_CAP} lines total).`,
            "info",
          );
          return;
        }
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshMemoryPrompt(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (skipNextAgentEndIncrement) {
      skipNextAgentEndIncrement = false;
      return;
    }

    if (!(await pathExists(getMemoryPaths(ctx.cwd).memoryRoot))) {
      return;
    }

    const state = await incrementTurnsSinceSleep(ctx.cwd);
    if (state.turns_since_sleep > SLEEP_HINT_THRESHOLD) {
      notify(ctx, "Memory hint: run /memory sleep.", "info");
    }
  });
}

async function initMemory(cwd: string): Promise<{ created: string[]; gitignoreUpdated: boolean }> {
  const paths = getMemoryPaths(cwd);
  const lockPaths = [
    paths.gitignoreFile,
    paths.readmeFile,
    paths.logFile,
    paths.stateFile,
    paths.currentBriefFile,
    paths.rawDir,
    paths.reflectionsDir,
    ...Object.values(paths.coreFiles),
  ];

  return withMemoryMutationQueue(lockPaths, async () => initMemoryUnsafe(cwd));
}

async function updateCoreBlock(
  cwd: string,
  name: MemoryBlockName,
  content: string,
): Promise<{ totalLines: number }> {
  const paths = getMemoryPaths(cwd);
  return withMemoryMutationQueue(Object.values(paths.coreFiles), async () =>
    updateCoreBlockUnsafe(cwd, name, content),
  );
}

async function appendMemoryLog(
  cwd: string,
  type: LogType,
  title: string,
  body: string,
  importance?: number,
): Promise<LogEntry> {
  const paths = getMemoryPaths(cwd);
  return withFileMutationQueue(paths.logFile, async () =>
    appendMemoryLogUnsafe(cwd, {
      timestamp: nowIso(),
      type,
      importance: clampImportance(importance),
      title: normalizeTitle(title) || "Memory log entry",
      body: normalizeMarkdownBlock(body),
    }),
  );
}

async function runMemorySleep(
  cwd: string,
  ctx: ExtensionContext,
  reason?: string,
): Promise<SleepResult> {
  const paths = getMemoryPaths(cwd);
  const lockPaths = [
    paths.currentBriefFile,
    paths.logFile,
    paths.stateFile,
    ...Object.values(paths.coreFiles),
  ];

  return withMemoryMutationQueue(lockPaths, async () => {
    ensureMemoryInitialized(await pathExists(paths.memoryRoot));

    const replay = await collectSleepReplay(cwd);
    const selection = await selectSleepModel(ctx);
    const response = await complete(
      selection.model,
      {
        systemPrompt: MEMORY_SLEEP_SYSTEM_PROMPT,
        messages: [buildSleepUserMessage(replay, reason)],
      },
      {
        apiKey: selection.apiKey,
        headers: selection.headers,
        signal: ctx.signal,
      },
    );

    if (response.stopReason === "aborted") {
      throw new Error("Memory sleep aborted.");
    }

    if (response.stopReason === "error") {
      throw new Error("Memory sleep failed.");
    }

    const rawText = response.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    if (!rawText) {
      throw new Error("Memory sleep returned no text.");
    }

    const abstraction = parseSleepOutput(rawText);
    const nextBlocks = normalizeSleepBlocks(replay.blocks, abstraction.blocks);
    if (
      wouldWipePendingWithoutResolution(
        replay.blocks.pending,
        nextBlocks.pending,
        abstraction.logEntry,
      )
    ) {
      throw new Error(
        "Memory sleep proposed clearing pending.md without describing resolution or abandonment in log_entry.",
      );
    }

    const finalPending = appendPendingDriftAndQuestions(
      nextBlocks.pending,
      abstraction.drift,
      abstraction.openQuestions,
    );
    const finalBlocks: CoreBlocks = { ...nextBlocks, pending: finalPending };
    const finalCoreLines = getCoreLineCount(finalBlocks);

    if (finalCoreLines > CORE_LINE_CAP) {
      await appendMemoryLogUnsafe(cwd, {
        timestamp: nowIso(),
        type: "lint",
        importance: 7,
        title: "Sleep aborted: core line cap exceeded",
        body: normalizeMarkdownBlock(
          `Sleep proposed ${finalCoreLines} core lines, exceeding the ${CORE_LINE_CAP}-line cap. Run /memory sleep again with a tighter consolidation or remove core content first.`,
        ),
      });
      throw new Error(
        `Memory sleep proposed ${finalCoreLines} core lines, exceeding the ${CORE_LINE_CAP}-line cap.`,
      );
    }

    const reflectionPaths = await writeReflectionCandidates(cwd, abstraction.candidates);
    await writeCoreBlocksUnsafe(cwd, finalBlocks);

    const sleepTimestamp = nowIso();
    await appendMemoryLogUnsafe(cwd, {
      timestamp: sleepTimestamp,
      type: "sleep",
      importance: SLEEP_LOG_IMPORTANCE,
      title: buildSleepLogTitle(reason),
      body: abstraction.logEntry,
    });
    await writeStateUnsafe(cwd, {
      last_sleep_at: sleepTimestamp,
      turns_since_sleep: 0,
    });

    const updatedBlocks = CORE_BLOCK_NAMES.filter(
      (name) =>
        normalizeMarkdownBlock(replay.blocks[name]) !== normalizeMarkdownBlock(finalBlocks[name]),
    );
    const summary = buildSleepSummary(updatedBlocks, reflectionPaths, abstraction);
    notify(ctx, summary, "info");

    return {
      summary,
      updatedBlocks,
      reflectionPaths,
      driftCount: abstraction.drift.length,
      openQuestionCount: abstraction.openQuestions.length,
      lastSleepAt: sleepTimestamp,
    };
  });
}

async function incrementTurnsSinceSleep(cwd: string): Promise<MemoryState> {
  const paths = getMemoryPaths(cwd);
  return withFileMutationQueue(paths.stateFile, async () => {
    const state = await readStateUnsafe(cwd);
    const nextState: MemoryState = {
      ...state,
      turns_since_sleep: state.turns_since_sleep + 1,
    };
    await writeStateUnsafe(cwd, nextState);
    return nextState;
  });
}

async function loadMemoryPromptGuideline(
  cwd: string,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const core = await readCoreBlocksUnsafe(cwd);
  if (!core.exists) {
    return undefined;
  }

  if (core.missing.length > 0) {
    notify(
      ctx,
      `Memory warning: missing core block files (${core.missing.join(", ")}). Run /memory init to restore them.`,
      "warning",
    );
  }

  if (core.totalLines > CORE_LINE_CAP) {
    notify(
      ctx,
      `Memory warning: core blocks use ${core.totalLines}/${CORE_LINE_CAP} lines. Run /memory sleep or trim them.`,
      "warning",
    );
  }

  return buildMemoryCorePrompt(core.blocks);
}

async function loadMemoryStatus(cwd: string): Promise<MemoryStatus> {
  const paths = getMemoryPaths(cwd);
  const initialized = await pathExists(paths.memoryRoot);
  if (!initialized) {
    return {
      initialized: false,
      coreExists: false,
      coreLines: 0,
      missingCoreFiles: [...CORE_BLOCK_NAMES],
      lastSleepAt: null,
      turnsSinceSleep: 0,
      hasCurrentBrief: false,
      hasLog: false,
    };
  }

  const [core, state, hasCurrentBrief, hasLog] = await Promise.all([
    readCoreBlocksUnsafe(cwd),
    readStateUnsafe(cwd),
    pathExists(paths.currentBriefFile),
    pathExists(paths.logFile),
  ]);

  return {
    initialized: true,
    coreExists: core.exists,
    coreLines: core.totalLines,
    missingCoreFiles: core.missing,
    lastSleepAt: state.last_sleep_at,
    turnsSinceSleep: state.turns_since_sleep,
    hasCurrentBrief,
    hasLog,
  };
}

async function initMemoryUnsafe(
  cwd: string,
): Promise<{ created: string[]; gitignoreUpdated: boolean }> {
  const paths = getMemoryPaths(cwd);
  const created: string[] = [];

  await ensureDir(paths.memoryRoot);
  await ensureDir(paths.coreDir);
  await ensureDir(paths.wikiDir);
  await ensureDir(paths.reflectionsDir);
  await ensureDir(paths.rawDir);

  for (const name of CORE_BLOCK_NAMES) {
    if (await writeIfMissing(paths.coreFiles[name], "")) {
      created.push(path.relative(cwd, paths.coreFiles[name]));
    }
  }

  if (await writeIfMissing(paths.currentBriefFile, "")) {
    created.push(path.relative(cwd, paths.currentBriefFile));
  }

  if (await writeIfMissing(paths.logFile, "# Memory log\n")) {
    created.push(path.relative(cwd, paths.logFile));
  }

  if (await writeIfMissing(paths.stateFile, `${JSON.stringify(defaultMemoryState(), null, 2)}\n`)) {
    created.push(path.relative(cwd, paths.stateFile));
  }

  if (await writeIfMissing(paths.readmeFile, buildMemoryReadme())) {
    created.push(path.relative(cwd, paths.readmeFile));
  }

  const gitignoreUpdated = await ensureRawPathIgnored(paths.gitignoreFile);
  return { created, gitignoreUpdated };
}

async function updateCoreBlockUnsafe(
  cwd: string,
  name: MemoryBlockName,
  content: string,
): Promise<{ totalLines: number }> {
  const paths = getMemoryPaths(cwd);
  ensureMemoryInitialized(await pathExists(paths.memoryRoot));

  const current = await readCoreBlocksUnsafe(cwd);
  const nextBlocks: CoreBlocks = {
    ...current.blocks,
    [name]: normalizeMarkdownBlock(content),
  };
  const totalLines = getCoreLineCount(nextBlocks);

  if (totalLines > CORE_LINE_CAP) {
    throw new Error(
      `Core block update would exceed the ${CORE_LINE_CAP}-line cap (${totalLines}). Run memory_sleep or remove content first.`,
    );
  }

  await ensureDir(paths.coreDir);
  await fs.writeFile(paths.coreFiles[name], nextBlocks[name], "utf8");
  return { totalLines };
}

async function appendMemoryLogUnsafe(cwd: string, entry: LogEntry): Promise<LogEntry> {
  const paths = getMemoryPaths(cwd);
  ensureMemoryInitialized(await pathExists(paths.memoryRoot));

  const current = (await readTextIfExists(paths.logFile)) ?? "";
  const separator = current.trimEnd().length > 0 ? "\n\n" : "";
  const body = entry.body.trim() || "_No details._";
  const chunk = [
    `## ${entry.timestamp} | ${entry.type} | ${entry.importance} | ${entry.title}`,
    "",
    body,
  ].join("\n");

  await ensureDir(path.dirname(paths.logFile));
  await fs.writeFile(paths.logFile, `${current}${separator}${chunk}\n`, "utf8");
  return entry;
}

async function collectSleepReplay(cwd: string): Promise<SleepReplay> {
  const paths = getMemoryPaths(cwd);
  const [core, logText, currentBrief] = await Promise.all([
    readCoreBlocksUnsafe(cwd),
    readTextIfExists(paths.logFile),
    readTextIfExists(paths.currentBriefFile),
  ]);

  return {
    blocks: core.blocks,
    totalLines: core.totalLines,
    logTail: tailLines(logText ?? "", LOG_TAIL_LINES),
    currentBrief: currentBrief?.trim() ? currentBrief : null,
  };
}

async function writeReflectionCandidates(
  cwd: string,
  candidates: SleepCandidate[],
): Promise<string[]> {
  const paths = getMemoryPaths(cwd);
  await ensureDir(paths.reflectionsDir);

  const written: string[] = [];
  for (const candidate of candidates) {
    const filePath = await allocateReflectionPath(cwd, candidate.title);
    const content = buildReflectionContent(candidate);
    await withFileMutationQueue(filePath, async () => {
      await fs.writeFile(filePath, content, "utf8");
    });
    written.push(path.relative(cwd, filePath));
  }

  return written;
}

async function writeCoreBlocksUnsafe(cwd: string, blocks: CoreBlocks): Promise<void> {
  const paths = getMemoryPaths(cwd);
  await ensureDir(paths.coreDir);

  await Promise.all(
    CORE_BLOCK_NAMES.map((name) =>
      fs.writeFile(paths.coreFiles[name], normalizeMarkdownBlock(blocks[name]), "utf8"),
    ),
  );
}

async function readCoreBlocksUnsafe(cwd: string): Promise<CoreReadResult> {
  const paths = getMemoryPaths(cwd);
  const exists = await pathExists(paths.coreDir);
  const blocks = createEmptyCoreBlocks();
  const missing: MemoryBlockName[] = [];

  await Promise.all(
    CORE_BLOCK_NAMES.map(async (name) => {
      const text = await readTextIfExists(paths.coreFiles[name]);
      if (text === undefined) {
        if (exists) {
          missing.push(name);
        }
        return;
      }
      blocks[name] = text;
    }),
  );

  return {
    exists,
    blocks,
    missing: missing.sort((a, b) => CORE_BLOCK_NAMES.indexOf(a) - CORE_BLOCK_NAMES.indexOf(b)),
    totalLines: getCoreLineCount(blocks),
  };
}

async function readStateUnsafe(cwd: string): Promise<MemoryState> {
  const raw = await readTextIfExists(getMemoryPaths(cwd).stateFile);
  if (!raw?.trim()) {
    return defaultMemoryState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MemoryState>;
    return {
      last_sleep_at: typeof parsed.last_sleep_at === "string" ? parsed.last_sleep_at : null,
      turns_since_sleep:
        typeof parsed.turns_since_sleep === "number" && Number.isFinite(parsed.turns_since_sleep)
          ? Math.max(0, Math.trunc(parsed.turns_since_sleep))
          : 0,
    };
  } catch {
    return defaultMemoryState();
  }
}

async function writeStateUnsafe(cwd: string, state: MemoryState): Promise<void> {
  const paths = getMemoryPaths(cwd);
  await ensureDir(path.dirname(paths.stateFile));
  await fs.writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function allocateReflectionPath(cwd: string, title: string): Promise<string> {
  const paths = getMemoryPaths(cwd);
  const datePrefix = formatDateStamp(new Date());
  const slug = slugify(title);

  for (let index = 0; index < 10_000; index++) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const filePath = path.join(paths.reflectionsDir, `${datePrefix}-${slug}${suffix}.md`);
    if (!(await pathExists(filePath))) {
      return filePath;
    }
  }

  throw new Error("Could not allocate a reflection file path.");
}

async function ensureRawPathIgnored(gitignoreFile: string): Promise<boolean> {
  const rawLine = "/.memory/raw/";
  const current = (await readTextIfExists(gitignoreFile)) ?? "";
  const lines = current.replace(/\r/g, "").split("\n");
  const alreadyIgnored = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === rawLine || trimmed === ".memory/raw/" || trimmed === "/.memory/raw";
  });

  if (alreadyIgnored) {
    return false;
  }

  const prefix = current.length === 0 ? "" : current.endsWith("\n") ? "" : "\n";
  await fs.writeFile(gitignoreFile, `${current}${prefix}${rawLine}\n`, "utf8");
  return true;
}

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

function buildSleepUserMessage(replay: SleepReplay, reason?: string): UserMessage {
  const prompt = [
    reason?.trim() ? `Sleep reason: ${reason.trim()}` : "Sleep reason: manual consolidation.",
    `Current core lines: ${replay.totalLines}/${CORE_LINE_CAP}`,
    "Pending drift and open questions will be appended after your returned pending block, so keep pending concise.",
    "",
    "<replay>",
    "## directives.md",
    replay.blocks.directives.trimEnd() || "(empty)",
    "",
    "## context.md",
    replay.blocks.context.trimEnd() || "(empty)",
    "",
    "## focus.md",
    replay.blocks.focus.trimEnd() || "(empty)",
    "",
    "## pending.md",
    replay.blocks.pending.trimEnd() || "(empty)",
    "",
    "## log.md (last 100 lines)",
    replay.logTail || "(empty)",
    "",
    "## current_brief.md",
    replay.currentBrief ?? "(missing or empty)",
    "</replay>",
  ].join("\n");

  return {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
}

async function selectSleepModel(ctx: ExtensionContext): Promise<ModelSelection> {
  if (!ctx.model) {
    throw new Error("No active model selected for memory sleep.");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }

  return {
    model: ctx.model,
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}

function parseSleepOutput(rawText: string): SleepOutput {
  const parsed = parsePossiblyWrappedJson(rawText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Memory sleep output must be a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const blocksRecord =
    record.blocks && typeof record.blocks === "object"
      ? (record.blocks as Record<string, unknown>)
      : {};

  const blocks: Partial<CoreBlocks> = {};
  for (const name of CORE_BLOCK_NAMES) {
    const value = blocksRecord[name];
    if (typeof value === "string") {
      blocks[name] = normalizeMarkdownBlock(value);
    }
  }

  return {
    candidates: validateSleepCandidates(record.candidates),
    blocks,
    logEntry:
      typeof record.log_entry === "string" && record.log_entry.trim()
        ? normalizeMarkdownBlock(record.log_entry)
        : "Consolidated repo memory.",
    drift: validateDriftEntries(record.drift),
    openQuestions: validateOpenQuestions(record.open_questions),
  };
}

function validateSleepCandidates(input: unknown): SleepCandidate[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const candidates: SleepCandidate[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? normalizeTitle(record.title) : "";
    const content =
      typeof record.content === "string" ? normalizeMarkdownBlock(record.content) : "";
    const sources = Array.isArray(record.sources)
      ? record.sources.filter(
          (source): source is string => typeof source === "string" && source.trim().length > 0,
        )
      : [];

    if (!title || !content) {
      continue;
    }

    candidates.push({ title, content, sources });
  }

  return candidates;
}

function validateDriftEntries(input: unknown): DriftEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const drift: DriftEntry[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = normalizeDriftType(record.type);
    const description = normalizeInlineText(record.description);
    const source = normalizeInlineText(record.source);
    const expected = normalizeInlineText(record.expected);
    const actual = normalizeInlineText(record.actual);

    if (!type || !description || !source || !expected || !actual) {
      continue;
    }

    drift.push({ type, description, source, expected, actual });
  }

  return drift;
}

function validateOpenQuestions(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const questions: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const value = normalizeInlineText(item);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    questions.push(value);
  }

  return questions;
}

function normalizeSleepBlocks(current: CoreBlocks, next: Partial<CoreBlocks>): CoreBlocks {
  const normalized = createEmptyCoreBlocks();
  for (const name of CORE_BLOCK_NAMES) {
    normalized[name] = normalizeMarkdownBlock(next[name] ?? current[name]);
  }
  return normalized;
}

function appendPendingDriftAndQuestions(
  pending: string,
  drift: DriftEntry[],
  openQuestions: string[],
): string {
  let next = normalizeMarkdownBlock(pending);

  const driftItems = drift
    .filter((item) => !next.includes(item.description))
    .map((item) => formatDriftEntry(item));
  next = appendMarkdownSection(next, "Drift", driftItems);

  const questionItems = openQuestions
    .filter((question) => !next.includes(question))
    .map((question) => `- ${question}`);
  next = appendMarkdownSection(next, "Open questions", questionItems);

  return normalizeMarkdownBlock(next);
}

function appendMarkdownSection(markdown: string, heading: string, items: string[]): string {
  if (items.length === 0) {
    return normalizeMarkdownBlock(markdown);
  }

  const headingLine = `## ${heading}`;
  const lines = markdown ? markdown.replace(/\r/g, "").split("\n") : [];
  const insertLines = items.flatMap((item, index) =>
    index === 0 ? item.split("\n") : ["", ...item.split("\n")],
  );
  const headingIndex = lines.findIndex((line) => line.trim() === headingLine);

  if (headingIndex === -1) {
    const sectionLines = [headingLine, "", ...insertLines];
    const suffix = lines.length === 0 ? sectionLines : ["", ...sectionLines];
    return normalizeMarkdownBlock([...lines, ...suffix].join("\n"));
  }

  let nextSectionIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^##\s+/.test(line.trim()),
  );
  if (nextSectionIndex === -1) {
    nextSectionIndex = lines.length;
  }

  const needsSpacer =
    nextSectionIndex > headingIndex + 1 && lines[nextSectionIndex - 1]?.trim() !== "";
  const insertion = needsSpacer ? ["", ...insertLines] : insertLines;
  lines.splice(nextSectionIndex, 0, ...insertion);
  return normalizeMarkdownBlock(lines.join("\n"));
}

function wouldWipePendingWithoutResolution(
  previousPending: string,
  nextPending: string,
  logEntry: string,
): boolean {
  if (!previousPending.trim()) {
    return false;
  }

  if (nextPending.trim()) {
    return false;
  }

  return !mentionsResolution(logEntry);
}

function mentionsResolution(logEntry: string): boolean {
  return /\b(resolve|resolved|abandon|abandoned|drop|dropped|complete|completed|close|closed)\b/i.test(
    logEntry,
  );
}

function buildReflectionContent(candidate: SleepCandidate): string {
  const lines = [`# ${candidate.title}`, "", candidate.content.trim()];
  if (candidate.sources.length > 0) {
    lines.push("", "## Sources", ...candidate.sources.map((source) => `- ${source}`));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildMemoryCorePrompt(blocks: CoreBlocks): string {
  const sections = [
    "<memory_core>",
    "Read .memory/README.md before relying on or updating repo memory.",
    "",
    `### directives.md\n${blocks.directives.trimEnd() || "(empty)"}`,
    "",
    `### context.md\n${blocks.context.trimEnd() || "(empty)"}`,
    "",
    `### focus.md\n${blocks.focus.trimEnd() || "(empty)"}`,
    "",
    `### pending.md\n${blocks.pending.trimEnd() || "(empty)"}`,
    "</memory_core>",
  ];
  return sections.join("\n");
}

function buildMemoryReadme(): string {
  return [
    "# Repo memory",
    "",
    "This repository uses project-local memory under `.memory/`.",
    "",
    "## Layout",
    "",
    "- `core/` — four short markdown blocks (`directives.md`, `context.md`, `focus.md`, `pending.md`). Their combined total must stay at or below 300 lines.",
    "- `wiki/` — longer-lived knowledge, reflections, and `current_brief.md`.",
    "- `raw/` — large artifacts and media referenced by memory. This folder is gitignored.",
    "- `log.md` — append-only markdown log of decisions, plans, ingests, experiments, and sleeps.",
    "- `.state.json` — local memory state for `last_sleep_at` and `turns_since_sleep`.",
    "",
    "## Write rules",
    "",
    "- If work is left unfinished, update `core/pending.md`.",
    "- If architecture or behavior changes, update `core/context.md`.",
    "- If a non-trivial decision or discovery happens, append to `log.md`.",
    "- If the user gives a substantial brief, write it to `wiki/current_brief.md` before acting.",
    "",
    "## Sleep",
    "",
    "Sleep is the only consolidation mechanism. Run `/memory sleep` manually when core memory needs compression, knowledge should move into `wiki/`, or you need drift surfaced against `wiki/current_brief.md`.",
    "",
  ].join("\n");
}

function buildSleepLogTitle(reason?: string): string {
  const normalizedReason = normalizeInlineText(reason ?? "");
  if (!normalizedReason) {
    return "Memory sleep";
  }
  return truncateText(`Memory sleep: ${normalizedReason}`, 80);
}

function buildSleepSummary(
  updatedBlocks: MemoryBlockName[],
  reflectionPaths: string[],
  abstraction: SleepOutput,
): string {
  const parts = [
    updatedBlocks.length > 0 ? `updated ${updatedBlocks.join(", ")}` : "updated no core blocks",
    reflectionPaths.length > 0
      ? `wrote ${reflectionPaths.length} reflection${reflectionPaths.length === 1 ? "" : "s"}`
      : "wrote no reflections",
    abstraction.drift.length > 0
      ? `surfaced ${abstraction.drift.length} drift item${abstraction.drift.length === 1 ? "" : "s"}`
      : "no drift surfaced",
    abstraction.openQuestions.length > 0
      ? `added ${abstraction.openQuestions.length} open question${abstraction.openQuestions.length === 1 ? "" : "s"}`
      : "no new open questions",
  ];

  return `Memory sleep: ${parts.join("; ")}.`;
}

function formatDriftEntry(entry: DriftEntry): string {
  return [
    `- [${entry.type}] ${entry.description}`,
    `  - Source: ${entry.source}`,
    `  - Expected: ${entry.expected}`,
    `  - Actual: ${entry.actual}`,
  ].join("\n");
}

function formatInitResult(result: { created: string[]; gitignoreUpdated: boolean }): string {
  const parts: string[] = [];
  if (result.created.length > 0) {
    parts.push(`created ${result.created.length} path${result.created.length === 1 ? "" : "s"}`);
  }
  if (result.gitignoreUpdated) {
    parts.push("updated .gitignore");
  }

  return parts.length > 0
    ? `Initialized .memory/ (${parts.join(", ")}).`
    : "Memory already initialized.";
}

function formatMemoryStatus(status: MemoryStatus): string {
  if (!status.initialized) {
    return "Memory: not initialized. Run /memory init.";
  }

  const lines = [
    "Memory: initialized",
    `Core lines: ${status.coreLines}/${CORE_LINE_CAP}`,
    `Last sleep: ${status.lastSleepAt ?? "never"}`,
    `Turns since sleep: ${status.turnsSinceSleep}`,
    `Current brief: ${status.hasCurrentBrief ? "present" : "missing"}`,
    `Log: ${status.hasLog ? "present" : "missing"}`,
  ];

  if (!status.coreExists) {
    lines.push("Core blocks: missing");
  } else if (status.missingCoreFiles.length > 0) {
    lines.push(`Missing core files: ${status.missingCoreFiles.join(", ")}`);
  }

  return lines.join("\n");
}

function parseMemoryCommandArgs(
  args: string,
): { command: "init" | "status" | "sleep" | "log" | "focus"; text: string } | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }

  const firstSpace = trimmed.indexOf(" ");
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const text = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  if (
    command === "init" ||
    command === "status" ||
    command === "sleep" ||
    command === "log" ||
    command === "focus"
  ) {
    return { command, text };
  }

  return null;
}

function getMemoryArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const normalized = prefix.trimStart().toLowerCase();
  if (normalized.includes(" ")) {
    return null;
  }

  const options = [
    { value: "init", label: "init" },
    { value: "status", label: "status" },
    { value: "sleep", label: "sleep" },
    { value: "log ", label: "log" },
    { value: "focus ", label: "focus" },
  ];
  const matches = options.filter((option) => option.label.startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

function createEmptyCoreBlocks(): CoreBlocks {
  return {
    directives: "",
    context: "",
    focus: "",
    pending: "",
  };
}

function defaultMemoryState(): MemoryState {
  return {
    last_sleep_at: null,
    turns_since_sleep: 0,
  };
}

function getMemoryPaths(cwd: string): {
  memoryRoot: string;
  coreDir: string;
  wikiDir: string;
  reflectionsDir: string;
  rawDir: string;
  currentBriefFile: string;
  logFile: string;
  stateFile: string;
  readmeFile: string;
  gitignoreFile: string;
  coreFiles: Record<MemoryBlockName, string>;
} {
  const memoryRoot = path.join(cwd, MEMORY_DIR_NAME);
  const coreDir = path.join(memoryRoot, "core");
  const wikiDir = path.join(memoryRoot, "wiki");

  return {
    memoryRoot,
    coreDir,
    wikiDir,
    reflectionsDir: path.join(wikiDir, "reflections"),
    rawDir: path.join(memoryRoot, "raw"),
    currentBriefFile: path.join(wikiDir, "current_brief.md"),
    logFile: path.join(memoryRoot, "log.md"),
    stateFile: path.join(memoryRoot, ".state.json"),
    readmeFile: path.join(memoryRoot, "README.md"),
    gitignoreFile: path.join(cwd, ".gitignore"),
    coreFiles: {
      directives: path.join(coreDir, "directives.md"),
      context: path.join(coreDir, "context.md"),
      focus: path.join(coreDir, "focus.md"),
      pending: path.join(coreDir, "pending.md"),
    },
  };
}

function getCoreLineCount(blocks: CoreBlocks): number {
  return CORE_BLOCK_NAMES.reduce((total, name) => total + countLines(blocks[name]), 0);
}

function countLines(text: string): number {
  const normalized = text.replace(/\r/g, "").replace(/\n+$/g, "");
  return normalized ? normalized.split("\n").length : 0;
}

function normalizeMarkdownBlock(text: string): string {
  const normalized = text.replace(/\r/g, "").trimEnd();
  return normalized ? `${normalized}\n` : "";
}

function normalizeTitle(text: string): string {
  return truncateText(normalizeInlineText(text), 80);
}

function normalizeInlineText(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function normalizeDriftType(value: unknown): DriftType | null {
  if (
    value === "misalignment" ||
    value === "omission" ||
    value === "contradiction" ||
    value === "scope-creep"
  ) {
    return value;
  }
  return null;
}

function clampImportance(importance?: number): number {
  if (typeof importance !== "number" || !Number.isFinite(importance)) {
    return DEFAULT_LOG_IMPORTANCE;
  }
  return Math.min(10, Math.max(1, Math.trunc(importance)));
}

function deriveLogTitle(text: string): string {
  const firstLine = text.replace(/\r/g, "").split("\n")[0] ?? text;
  return normalizeTitle(firstLine || "Memory log entry");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function tailLines(text: string, limit: number): string {
  if (!text.trim()) {
    return "";
  }
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.slice(-limit).join("\n").trim();
}

function slugify(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "reflection";
}

function formatDateStamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureMemoryInitialized(initialized: boolean): void {
  if (!initialized) {
    throw new Error("Memory is not initialized. Run /memory init first.");
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function withMemoryMutationQueue<T>(filePaths: string[], fn: () => Promise<T>): Promise<T> {
  const uniquePaths = Array.from(
    new Set(filePaths.map((filePath) => path.resolve(filePath))),
  ).sort();
  return acquireQueuedPaths(uniquePaths, 0, fn);
}

async function acquireQueuedPaths<T>(
  filePaths: string[],
  index: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (index >= filePaths.length) {
    return fn();
  }

  return withFileMutationQueue(filePaths[index], () =>
    acquireQueuedPaths(filePaths, index + 1, fn),
  );
}

function notify(
  ctx: Pick<ExtensionContext | ExtensionCommandContext, "hasUI" | "ui">,
  text: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }

  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${text}\n`);
}

function parsePossiblyWrappedJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Empty output");
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced || trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Output is not valid JSON");
  }
}
