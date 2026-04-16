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
const LOG_TYPES = ["decision", "prompt", "plan", "experiment"] as const;
const IMPORTANCE_LEVELS = ["high", "medium", "low"] as const;

const CORE_LINE_CAP = 300;
const AUTO_DREAM_MIN_UNDREAMED = 8;
const AUTO_DREAM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CORE_DREAM_HINT_LINES = 240;
const MAX_PENDING_COMPACTIONS = 8;
const MAX_RECALLED_LOGS = 12;
const MAX_RECALL_TERMS = 20;
const RECALLED_BODY_LIMIT = 1200;
const DEFAULT_LOG_IMPORTANCE: ImportanceLevel = "medium";

const MEMORY_UPDATE_BLOCK_PARAMS = Type.Object({
  name: StringEnum(CORE_BLOCK_NAMES, { description: "Core block name" }),
  content: Type.String({ description: "Markdown content for the core block" }),
});

const MEMORY_APPEND_LOG_PARAMS = Type.Object({
  type: StringEnum(LOG_TYPES, { description: "Log entry type" }),
  title: Type.String({ minLength: 1, description: "Short log entry title" }),
  body: Type.String({ description: "Markdown log entry body" }),
  importance: Type.Optional(StringEnum(IMPORTANCE_LEVELS, { description: "Importance label" })),
});

const MEMORY_DREAM_PARAMS = Type.Object({
  reason: Type.Optional(Type.String({ description: "Why consolidation is needed" })),
});

const MEMORY_DREAM_SYSTEM_PROMPT = `You consolidate repo-local memory for a Pi extension.

Return valid JSON only. No markdown fences. No prose outside JSON.

Schema:
{
  "blocks": {
    "directives": "...",
    "context": "...",
    "focus": "...",
    "pending": "..."
  },
  "summary": "..."
}

Rules:
- Update only the four core blocks.
- Keep the combined total across all returned blocks at or below 300 lines.
- Enforce the cap only in your output, not by dropping input context from the read phase.
- directives: stable rules, preferences, and standing operating constraints.
- context: stable architecture, behavior, important decisions, and durable takeaways.
- focus: the current objective and immediate next steps.
- pending: unresolved follow-ups, open questions, blocked work.
- research/ is only for short abstracts of actual external SOTA research relevant to the current problem. Do not invent or rewrite research files here.
- raw/ is only for user-requested media assets used to collaborate with the user. Do not use raw/ as scratch storage.
- Preserve unresolved pending items. Do not clear pending unless the summary explicitly says they were resolved or abandoned.
- Keep every block short, concrete, and high-signal.
- Self-check that JSON.parse(output) succeeds before responding.`;

const STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "also",
  "been",
  "before",
  "being",
  "between",
  "brief",
  "build",
  "built",
  "cannot",
  "could",
  "dream",
  "extension",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "memory",
  "more",
  "must",
  "need",
  "only",
  "other",
  "over",
  "project",
  "repo",
  "session",
  "should",
  "since",
  "some",
  "that",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "used",
  "user",
  "using",
  "when",
  "with",
  "work",
  "would",
]);

type MemoryBlockName = (typeof CORE_BLOCK_NAMES)[number];
type LogType = (typeof LOG_TYPES)[number];
type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

type CoreBlocks = Record<MemoryBlockName, string>;

type LogEntry = {
  timestamp: string;
  type: LogType;
  importance: ImportanceLevel;
  title: string;
  body: string;
};

type PendingCompaction = {
  timestamp: string;
  summary: string;
};

type MemoryState = {
  last_log_at: string | null;
  last_dream_at: string | null;
  last_dream_log_at: string | null;
  pending_compactions: PendingCompaction[];
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
  lastLogAt: string | null;
  lastDreamAt: string | null;
  lastDreamLogAt: string | null;
  undreamedLogs: number;
  pendingCompactions: number;
  researchFiles: number;
  hasLog: boolean;
};

type DreamReplay = {
  blocks: CoreBlocks;
  totalLines: number;
  recentEntries: LogEntry[];
  recalledEntries: LogEntry[];
  pendingCompactions: PendingCompaction[];
  researchFiles: string[];
};

type DreamOutput = {
  blocks: Partial<CoreBlocks>;
  summary: string;
};

type DreamResult = {
  summary: string;
  updatedBlocks: MemoryBlockName[];
  consumedLogs: number;
  consumedCompactions: number;
  lastDreamAt: string;
  lastDreamLogAt: string | null;
};

type AutoDreamStatus = {
  coreLines: number;
  undreamedLogs: number;
  oldestUndreamedAt: string | null;
  pendingCompactions: number;
};

type AutoDreamTrigger = "session_start" | "session_compact";

type ModelSelection = {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
};

export default function memoryExtension(pi: ExtensionAPI): void {
  let autoDreamPromise: Promise<void> | null = null;
  let pendingStartupDreamCheck = false;

  pi.registerTool(
    defineTool({
      name: "memory_update_block",
      label: "Memory Update Block",
      description: "Update one .memory/core block while enforcing the shared 300-line cap",
      promptSnippet: "Update one core memory block in .memory/core with 300-line cap enforcement",
      promptGuidelines: [
        "Use this tool when updating .memory/core/directives.md, context.md, focus.md, or pending.md.",
        "If a write would exceed the 300-line core cap, run memory_dream or remove content first.",
      ],
      parameters: MEMORY_UPDATE_BLOCK_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await updateCoreBlock(ctx.cwd, params.name, params.content);

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
        "Use this tool for non-trivial decisions, discoveries, plans, experiments, prompt ingests, and raw media additions worth remembering.",
        "Use importance labels high, medium, or low.",
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
      name: "memory_dream",
      label: "Memory Dream",
      description:
        "Consolidate repo memory into .memory/core from newer log entries and compaction context",
      promptSnippet: "Consolidate repo memory with dream-based core compression",
      promptGuidelines: [
        "Dream is the only consolidation mechanism for .memory/core.",
        "Use this tool when logs have accumulated, core needs compression, or recent compaction context should be folded into memory.",
      ],
      parameters: MEMORY_DREAM_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return toolDream(ctx.cwd, ctx, params.reason);
      },
    }),
  );

  pi.registerCommand("memory", {
    description: "Manage project-local memory in .memory/",
    getArgumentCompletions: getMemoryArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseMemoryCommandArgs(args);
      if (!parsed) {
        notify(
          ctx,
          "Usage: /memory init | status | dream [reason] | log <text> | focus <text>",
          "warning",
        );
        return;
      }

      switch (parsed.command) {
        case "init": {
          const result = await initMemory(ctx.cwd);
          notify(ctx, formatInitResult(result), "info");
          return;
        }
        case "status": {
          const status = await loadMemoryStatus(ctx.cwd);
          notify(ctx, formatMemoryStatus(status), "info");
          return;
        }
        case "dream": {
          await toolDream(ctx.cwd, ctx, parsed.text || undefined);
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

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = await loadMemoryPrompt(ctx.cwd);
    if (!prompt) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    pendingStartupDreamCheck = !(await maybeScheduleAutoDream(
      ctx.cwd,
      ctx,
      "session_start",
      setAutoDreamPromise,
    ));
  });

  pi.on("model_select", async (event, ctx) => {
    if (!pendingStartupDreamCheck) {
      return;
    }

    if (event.source !== "restore" && event.previousModel) {
      return;
    }

    pendingStartupDreamCheck = false;
    await maybeScheduleAutoDream(ctx.cwd, ctx, "session_start", setAutoDreamPromise);
  });

  pi.on("session_compact", async (event, ctx) => {
    const paths = getMemoryPaths(ctx.cwd);
    if (!(await pathExists(paths.memoryRoot))) {
      return;
    }

    await enqueuePendingCompaction(ctx.cwd, {
      timestamp: event.compactionEntry.timestamp,
      summary: event.compactionEntry.summary,
    });
    await maybeScheduleAutoDream(ctx.cwd, ctx, "session_compact", setAutoDreamPromise);
  });

  function setAutoDreamPromise(promise: Promise<void> | null): void {
    autoDreamPromise = promise;
  }

  async function maybeScheduleAutoDream(
    cwd: string,
    ctx: ExtensionContext,
    trigger: AutoDreamTrigger,
    setPromise: (promise: Promise<void> | null) => void,
  ): Promise<boolean> {
    if (!ctx.model) {
      return false;
    }

    if (autoDreamPromise) {
      return true;
    }

    const paths = getMemoryPaths(cwd);
    if (!(await pathExists(paths.memoryRoot))) {
      return true;
    }

    const status = await loadAutoDreamStatus(cwd);
    if (!shouldAutoDream(status, trigger)) {
      return true;
    }

    const reason = buildAutoDreamReason(status, trigger);
    const promise = runMemoryDream(cwd, ctx, reason)
      .then(() => undefined)
      .catch((error) => {
        notify(ctx, formatAutoDreamError(error), "warning");
      })
      .finally(() => {
        setPromise(null);
      });

    setPromise(promise);
    return true;
  }
}

async function toolDream(
  cwd: string,
  ctx: ExtensionContext,
  reason?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: DreamResult }> {
  const result = await runMemoryDream(cwd, ctx, reason);
  return {
    content: [{ type: "text", text: result.summary }],
    details: result,
  };
}

async function initMemory(cwd: string): Promise<{ created: string[]; gitignoreUpdated: boolean }> {
  const paths = getMemoryPaths(cwd);
  const lockPaths = [
    paths.gitignoreFile,
    paths.readmeFile,
    paths.logFile,
    paths.stateFile,
    paths.researchDir,
    paths.rawDir,
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
  importance?: ImportanceLevel,
): Promise<LogEntry> {
  const paths = getMemoryPaths(cwd);
  return withMemoryMutationQueue([paths.logFile, paths.stateFile], async () =>
    appendMemoryLogUnsafe(cwd, {
      timestamp: nowIso(),
      type,
      importance: importance ?? DEFAULT_LOG_IMPORTANCE,
      title: normalizeTitle(title) || "Memory log entry",
      body: normalizeMarkdownBlock(body),
    }),
  );
}

async function enqueuePendingCompaction(cwd: string, compaction: PendingCompaction): Promise<void> {
  const paths = getMemoryPaths(cwd);
  await withFileMutationQueue(paths.stateFile, async () => {
    const state = await readStateUnsafe(cwd);
    const pending = [...state.pending_compactions, normalizePendingCompaction(compaction)]
      .filter((entry): entry is PendingCompaction => entry !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-MAX_PENDING_COMPACTIONS);

    await writeStateUnsafe(cwd, {
      ...state,
      pending_compactions: pending,
    });
  });
}

async function runMemoryDream(
  cwd: string,
  ctx: ExtensionContext,
  reason?: string,
): Promise<DreamResult> {
  const paths = getMemoryPaths(cwd);
  const lockPaths = [paths.logFile, paths.stateFile, ...Object.values(paths.coreFiles)];

  return withMemoryMutationQueue(lockPaths, async () => {
    ensureMemoryInitialized(await pathExists(paths.memoryRoot));

    const replay = await collectDreamReplay(cwd, reason);
    if (!shouldRunDream(replay, reason)) {
      const summary = "Memory dream: nothing to consolidate.";
      notify(ctx, summary, "info");
      return {
        summary,
        updatedBlocks: [],
        consumedLogs: 0,
        consumedCompactions: 0,
        lastDreamAt: (await readStateUnsafe(cwd)).last_dream_at ?? nowIso(),
        lastDreamLogAt: (await readStateUnsafe(cwd)).last_dream_log_at,
      };
    }

    const selection = await selectDreamModel(ctx);
    const response = await complete(
      selection.model,
      {
        systemPrompt: MEMORY_DREAM_SYSTEM_PROMPT,
        messages: [buildDreamUserMessage(replay, reason)],
      },
      {
        apiKey: selection.apiKey,
        headers: selection.headers,
        signal: ctx.signal,
      },
    );

    if (response.stopReason === "aborted") {
      throw new Error("Memory dream aborted.");
    }

    if (response.stopReason === "error") {
      throw new Error("Memory dream failed.");
    }

    const rawText = response.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    if (!rawText) {
      throw new Error("Memory dream returned no text.");
    }

    const abstraction = parseDreamOutput(rawText);
    const finalBlocks = normalizeDreamBlocks(replay.blocks, abstraction.blocks);
    if (
      wouldWipePendingWithoutResolution(
        replay.blocks.pending,
        finalBlocks.pending,
        abstraction.summary,
      )
    ) {
      throw new Error(
        "Memory dream proposed clearing pending.md without saying it was resolved or abandoned.",
      );
    }

    const finalCoreLines = getCoreLineCount(finalBlocks);
    if (finalCoreLines > CORE_LINE_CAP) {
      throw new Error(
        `Memory dream proposed ${finalCoreLines} core lines, exceeding the ${CORE_LINE_CAP}-line cap.`,
      );
    }

    await writeCoreBlocksUnsafe(cwd, finalBlocks);

    const previousState = await readStateUnsafe(cwd);
    const dreamTimestamp = nowIso();
    const lastDreamLogAt =
      replay.recentEntries.at(-1)?.timestamp ?? previousState.last_dream_log_at;
    await writeStateUnsafe(cwd, {
      ...previousState,
      last_dream_at: dreamTimestamp,
      last_dream_log_at: lastDreamLogAt,
      pending_compactions: [],
    });

    const updatedBlocks = CORE_BLOCK_NAMES.filter(
      (name) =>
        normalizeMarkdownBlock(replay.blocks[name]) !== normalizeMarkdownBlock(finalBlocks[name]),
    );
    const summary = buildDreamSummary(updatedBlocks, replay, abstraction.summary);
    notify(ctx, summary, "info");

    return {
      summary,
      updatedBlocks,
      consumedLogs: replay.recentEntries.length,
      consumedCompactions: replay.pendingCompactions.length,
      lastDreamAt: dreamTimestamp,
      lastDreamLogAt,
    };
  });
}

async function loadMemoryPrompt(cwd: string): Promise<string | undefined> {
  const paths = getMemoryPaths(cwd);
  if (!(await pathExists(paths.memoryRoot))) {
    return undefined;
  }

  const [core, researchFiles] = await Promise.all([
    readCoreBlocksUnsafe(cwd),
    listResearchFiles(cwd),
  ]);

  return buildMemoryPrompt(core.blocks, researchFiles);
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
      lastLogAt: null,
      lastDreamAt: null,
      lastDreamLogAt: null,
      undreamedLogs: 0,
      pendingCompactions: 0,
      researchFiles: 0,
      hasLog: false,
    };
  }

  const [core, state, logText, researchFiles, hasLog] = await Promise.all([
    readCoreBlocksUnsafe(cwd),
    readStateUnsafe(cwd),
    readTextIfExists(paths.logFile),
    listResearchFiles(cwd),
    pathExists(paths.logFile),
  ]);
  const entries = parseMemoryLog(logText ?? "");

  return {
    initialized: true,
    coreExists: core.exists,
    coreLines: core.totalLines,
    missingCoreFiles: core.missing,
    lastLogAt: entries.at(-1)?.timestamp ?? state.last_log_at,
    lastDreamAt: state.last_dream_at,
    lastDreamLogAt: state.last_dream_log_at,
    undreamedLogs: countUndreamedLogs(entries, state.last_dream_log_at),
    pendingCompactions: state.pending_compactions.length,
    researchFiles: researchFiles.length,
    hasLog,
  };
}

async function loadAutoDreamStatus(cwd: string): Promise<AutoDreamStatus> {
  const paths = getMemoryPaths(cwd);
  const [core, state, logText] = await Promise.all([
    readCoreBlocksUnsafe(cwd),
    readStateUnsafe(cwd),
    readTextIfExists(paths.logFile),
  ]);
  const entries = parseMemoryLog(logText ?? "");
  const recentEntries = selectRecentLogEntries(entries, state.last_dream_log_at);

  return {
    coreLines: core.totalLines,
    undreamedLogs: recentEntries.length,
    oldestUndreamedAt: recentEntries[0]?.timestamp ?? null,
    pendingCompactions: state.pending_compactions.length,
  };
}

async function initMemoryUnsafe(
  cwd: string,
): Promise<{ created: string[]; gitignoreUpdated: boolean }> {
  const paths = getMemoryPaths(cwd);
  const created: string[] = [];

  await ensureDir(paths.memoryRoot);
  await ensureDir(paths.coreDir);
  await ensureDir(paths.researchDir);
  await ensureDir(paths.rawDir);

  for (const name of CORE_BLOCK_NAMES) {
    if (await writeIfMissing(paths.coreFiles[name], "")) {
      created.push(path.relative(cwd, paths.coreFiles[name]));
    }
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
      `Core block update would exceed the ${CORE_LINE_CAP}-line cap (${totalLines}). Run memory_dream or remove content first.`,
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
  const prefix = current.trim().length > 0 ? current.trimEnd() : "# Memory log";
  const body = entry.body.trim() || "_No details._";
  const chunk = [
    `## ${entry.timestamp} | ${entry.type} | ${entry.importance} | ${entry.title}`,
    "",
    body,
  ].join("\n");

  await ensureDir(path.dirname(paths.logFile));
  await fs.writeFile(paths.logFile, `${prefix}\n\n${chunk}\n`, "utf8");

  const state = await readStateUnsafe(cwd);
  await writeStateUnsafe(cwd, {
    ...state,
    last_log_at: entry.timestamp,
  });

  return entry;
}

async function collectDreamReplay(cwd: string, reason?: string): Promise<DreamReplay> {
  const paths = getMemoryPaths(cwd);
  const [core, state, logText, researchFiles] = await Promise.all([
    readCoreBlocksUnsafe(cwd),
    readStateUnsafe(cwd),
    readTextIfExists(paths.logFile),
    listResearchFiles(cwd),
  ]);
  const entries = parseMemoryLog(logText ?? "");
  const recentEntries = selectRecentLogEntries(entries, state.last_dream_log_at);
  const recalledEntries = selectRecalledLogEntries(
    entries,
    recentEntries,
    core.blocks,
    reason,
    state.pending_compactions,
  );

  return {
    blocks: core.blocks,
    totalLines: core.totalLines,
    recentEntries,
    recalledEntries,
    pendingCompactions: state.pending_compactions,
    researchFiles,
  };
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
      last_log_at: typeof parsed.last_log_at === "string" ? parsed.last_log_at : null,
      last_dream_at: typeof parsed.last_dream_at === "string" ? parsed.last_dream_at : null,
      last_dream_log_at:
        typeof parsed.last_dream_log_at === "string" ? parsed.last_dream_log_at : null,
      pending_compactions: Array.isArray(parsed.pending_compactions)
        ? parsed.pending_compactions
            .map((entry) => normalizePendingCompaction(entry))
            .filter((entry): entry is PendingCompaction => entry !== null)
            .slice(-MAX_PENDING_COMPACTIONS)
        : [],
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

async function listResearchFiles(cwd: string): Promise<string[]> {
  const researchDir = getMemoryPaths(cwd).researchDir;
  if (!(await pathExists(researchDir))) {
    return [];
  }

  const entries = await fs.readdir(researchDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(cwd, path.join(researchDir, entry.name)))
    .sort();
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

function buildDreamUserMessage(replay: DreamReplay, reason?: string): UserMessage {
  const prompt = [
    reason?.trim() ? `Dream reason: ${reason.trim()}` : "Dream reason: consolidate repo memory.",
    `Current core lines: ${replay.totalLines}/${CORE_LINE_CAP}`,
    "",
    "<core>",
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
    "</core>",
    "",
    `<recent-log count="${replay.recentEntries.length}">`,
    formatLogEntriesForPrompt(replay.recentEntries, false) || "(none)",
    "</recent-log>",
    "",
    `<recalled-log count="${replay.recalledEntries.length}">`,
    formatLogEntriesForPrompt(replay.recalledEntries, true) || "(none)",
    "</recalled-log>",
    "",
    `<compaction-notes count="${replay.pendingCompactions.length}">`,
    formatPendingCompactionsForPrompt(replay.pendingCompactions) || "(none)",
    "</compaction-notes>",
    "",
    `<research-files count="${replay.researchFiles.length}">`,
    replay.researchFiles.join("\n") || "(none)",
    "</research-files>",
  ].join("\n");

  return {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
}

async function selectDreamModel(ctx: ExtensionContext): Promise<ModelSelection> {
  if (!ctx.model) {
    throw new Error("No active model selected for memory dream.");
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

function parseDreamOutput(rawText: string): DreamOutput {
  const parsed = parsePossiblyWrappedJson(rawText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Memory dream output must be a JSON object.");
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

  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? normalizeInlineText(record.summary)
      : "Consolidated repo memory.";

  return { blocks, summary };
}

function normalizeDreamBlocks(current: CoreBlocks, next: Partial<CoreBlocks>): CoreBlocks {
  const normalized = createEmptyCoreBlocks();
  for (const name of CORE_BLOCK_NAMES) {
    normalized[name] = normalizeMarkdownBlock(next[name] ?? current[name]);
  }
  return normalized;
}

function wouldWipePendingWithoutResolution(
  previousPending: string,
  nextPending: string,
  summary: string,
): boolean {
  if (!previousPending.trim()) {
    return false;
  }

  if (nextPending.trim()) {
    return false;
  }

  return !mentionsResolution(summary);
}

function mentionsResolution(text: string): boolean {
  return /\b(resolve|resolved|abandon|abandoned|drop|dropped|complete|completed|close|closed)\b/i.test(
    text,
  );
}

function buildMemoryPrompt(blocks: CoreBlocks, researchFiles: string[]): string {
  const sections = [
    "<repo_memory>",
    "Use repo memory only for project-local continuity.",
    "Rules:",
    `- .memory/core/ is immediate working memory. Enforce the shared ${CORE_LINE_CAP}-line cap only when writing core or finalizing a dream.`,
    "- .memory/research/ is only for short abstracts of actual external SOTA research relevant to the current problem. Do not store local notes, plans, or project summaries there.",
    "- .memory/raw/ is only for user-requested media files used to collaborate with the user. If you add one, also append a log entry naming the file and why it exists.",
    "- .memory/log.md is append-only and should capture non-trivial decisions, prompt ingests, plans, experiments, and raw media additions.",
    "- If the user provides a substantial brief, append it as a prompt entry with high importance.",
    researchFiles.length > 0
      ? `- Research abstracts available: ${researchFiles.join(", ")}`
      : "- Research abstracts available: none.",
    "",
    `### directives.md\n${blocks.directives.trimEnd() || "(empty)"}`,
    "",
    `### context.md\n${blocks.context.trimEnd() || "(empty)"}`,
    "",
    `### focus.md\n${blocks.focus.trimEnd() || "(empty)"}`,
    "",
    `### pending.md\n${blocks.pending.trimEnd() || "(empty)"}`,
    "</repo_memory>",
  ];
  return sections.join("\n");
}

function buildMemoryReadme(): string {
  return [
    "# Repo memory",
    "",
    "This repository uses Pi-managed project-local memory under `.memory/`.",
    "",
    "## Layout",
    "",
    `- \`core/\` — four short markdown blocks (\`directives.md\`, \`context.md\`, \`focus.md\`, \`pending.md\`). Their combined total must stay at or below ${CORE_LINE_CAP} lines. Enforce that cap only when writing core or finalizing a dream, not when reading.`,
    "- `research/` — short abstracts of actual external SOTA research relevant to the current problem. Do not use this for local notes, plans, implementation details, or project summaries.",
    "- `raw/` — only user-requested media files used to collaborate with the user. This folder is gitignored. If you add something here, also append a log entry naming the file and why it exists.",
    "- `log.md` — append-only markdown log for decisions, prompts, plans, experiments, and raw media additions.",
    "- `.state.json` — internal Pi state for the last log timestamp, last dream timestamp, and pending compaction notes. Do not edit it manually unless recovery is required.",
    "",
    "## Write rules",
    "",
    "- If work is left unfinished, update `core/pending.md`.",
    "- If architecture or behavior changes, update `core/context.md`.",
    "- If user preferences or standing constraints change, update `core/directives.md`.",
    "- If focus shifts, update `core/focus.md`.",
    "- If a non-trivial decision, prompt ingest, plan, experiment, or raw media addition happens, append to `log.md`.",
    "- If the user provides a substantial brief, append it as a `prompt | high` log entry.",
    "",
    "## Dream",
    "",
    "Dream is the only consolidation mechanism for `core/`.",
    "",
    "Pi can trigger dreaming automatically on session start when logs are stale and after compaction when new compaction context should be folded into memory. You can also run `/memory dream` manually.",
    "",
    "Dream reads all log entries newer than the last dreamed log timestamp and may recall older high-signal log entries while consolidating.",
    "",
  ].join("\n");
}

function buildDreamSummary(
  updatedBlocks: MemoryBlockName[],
  replay: DreamReplay,
  summary: string,
): string {
  const parts = [
    updatedBlocks.length > 0 ? `updated ${updatedBlocks.join(", ")}` : "updated no core blocks",
    replay.recentEntries.length > 0
      ? `consumed ${replay.recentEntries.length} new log entr${replay.recentEntries.length === 1 ? "y" : "ies"}`
      : "consumed no new log entries",
    replay.pendingCompactions.length > 0
      ? `folded ${replay.pendingCompactions.length} compaction note${replay.pendingCompactions.length === 1 ? "" : "s"}`
      : "folded no compaction notes",
  ];

  return `Memory dream: ${parts.join("; ")}. ${truncateText(summary, 160)}`;
}

function buildAutoDreamReason(status: AutoDreamStatus, trigger: AutoDreamTrigger): string {
  if (trigger === "session_compact") {
    return `Automatic dream after compaction with ${status.pendingCompactions} pending compaction note${status.pendingCompactions === 1 ? "" : "s"}.`;
  }

  if (status.undreamedLogs >= AUTO_DREAM_MIN_UNDREAMED) {
    return `Automatic dream on session start with ${status.undreamedLogs} undreamed log entries.`;
  }

  if (status.coreLines >= CORE_DREAM_HINT_LINES && status.undreamedLogs > 0) {
    return `Automatic dream on session start with core at ${status.coreLines}/${CORE_LINE_CAP} lines and fresh log backlog.`;
  }

  return "Automatic dream on session start because undreamed memory is stale.";
}

function formatLogEntriesForPrompt(entries: LogEntry[], truncateBodies: boolean): string {
  if (entries.length === 0) {
    return "";
  }

  return entries
    .map((entry) => {
      const body = truncateBodies
        ? truncateText(entry.body.trim(), RECALLED_BODY_LIMIT)
        : entry.body.trim();
      return [
        `## ${entry.timestamp} | ${entry.type} | ${entry.importance} | ${entry.title}`,
        "",
        body || "_No details._",
      ].join("\n");
    })
    .join("\n\n");
}

function formatPendingCompactionsForPrompt(compactions: PendingCompaction[]): string {
  if (compactions.length === 0) {
    return "";
  }

  return compactions
    .map((compaction) => {
      return [`## ${compaction.timestamp}`, "", compaction.summary.trim() || "_No summary._"].join(
        "\n",
      );
    })
    .join("\n\n");
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
    `Last log: ${status.lastLogAt ?? "never"}`,
    `Last dream: ${status.lastDreamAt ?? "never"}`,
    `Last dreamed log: ${status.lastDreamLogAt ?? "never"}`,
    `Undreamed logs: ${status.undreamedLogs}`,
    `Pending compactions: ${status.pendingCompactions}`,
    `Research abstracts: ${status.researchFiles}`,
    `Log: ${status.hasLog ? "present" : "missing"}`,
  ];

  if (!status.coreExists) {
    lines.push("Core blocks: missing");
  } else if (status.missingCoreFiles.length > 0) {
    lines.push(`Missing core files: ${status.missingCoreFiles.join(", ")}`);
  }

  return lines.join("\n");
}

function formatAutoDreamError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Memory dream skipped: ${message}`;
}

function parseMemoryCommandArgs(
  args: string,
): { command: "init" | "status" | "dream" | "log" | "focus"; text: string } | null {
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
    command === "dream" ||
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
    { value: "dream", label: "dream" },
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
    last_log_at: null,
    last_dream_at: null,
    last_dream_log_at: null,
    pending_compactions: [],
  };
}

function getMemoryPaths(cwd: string): {
  memoryRoot: string;
  coreDir: string;
  researchDir: string;
  rawDir: string;
  logFile: string;
  stateFile: string;
  readmeFile: string;
  gitignoreFile: string;
  coreFiles: Record<MemoryBlockName, string>;
} {
  const memoryRoot = path.join(cwd, MEMORY_DIR_NAME);
  const coreDir = path.join(memoryRoot, "core");

  return {
    memoryRoot,
    coreDir,
    researchDir: path.join(memoryRoot, "research"),
    rawDir: path.join(memoryRoot, "raw"),
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

function shouldRunDream(replay: DreamReplay, reason?: string): boolean {
  return (
    replay.recentEntries.length > 0 ||
    replay.pendingCompactions.length > 0 ||
    replay.totalLines >= CORE_DREAM_HINT_LINES ||
    Boolean(reason?.trim())
  );
}

function shouldAutoDream(status: AutoDreamStatus, trigger: AutoDreamTrigger): boolean {
  if (status.pendingCompactions > 0) {
    return true;
  }

  if (trigger !== "session_start") {
    return false;
  }

  if (status.undreamedLogs === 0) {
    return false;
  }

  if (status.undreamedLogs >= AUTO_DREAM_MIN_UNDREAMED) {
    return true;
  }

  if (status.coreLines >= CORE_DREAM_HINT_LINES) {
    return true;
  }

  if (!status.oldestUndreamedAt) {
    return false;
  }

  return Date.now() - Date.parse(status.oldestUndreamedAt) >= AUTO_DREAM_MAX_AGE_MS;
}

function parseMemoryLog(text: string): LogEntry[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const entries: LogEntry[] = [];
  let current: Omit<LogEntry, "body"> | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (!current) {
      return;
    }

    entries.push({
      ...current,
      body: normalizeMarkdownBlock(bodyLines.join("\n")),
    });
    current = null;
    bodyLines = [];
  };

  for (const line of lines) {
    const match = line.match(
      /^##\s+([^|]+?)\s+\|\s+(decision|prompt|plan|experiment)\s+\|\s+(high|medium|low)\s+\|\s+(.+?)\s*$/,
    );
    if (match) {
      flush();
      current = {
        timestamp: match[1].trim(),
        type: match[2] as LogType,
        importance: match[3] as ImportanceLevel,
        title: normalizeTitle(match[4]) || "Memory log entry",
      };
      continue;
    }

    if (current) {
      bodyLines.push(line);
    }
  }

  flush();
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function selectRecentLogEntries(entries: LogEntry[], lastDreamLogAt: string | null): LogEntry[] {
  if (!lastDreamLogAt) {
    return [...entries];
  }
  return entries.filter((entry) => entry.timestamp > lastDreamLogAt);
}

function selectRecalledLogEntries(
  entries: LogEntry[],
  recentEntries: LogEntry[],
  blocks: CoreBlocks,
  reason: string | undefined,
  pendingCompactions: PendingCompaction[],
): LogEntry[] {
  const recentKeys = new Set(recentEntries.map((entry) => `${entry.timestamp}|${entry.title}`));
  const recallTerms = extractRecallTerms([
    blocks.directives,
    blocks.context,
    blocks.focus,
    blocks.pending,
    reason ?? "",
    ...recentEntries.map((entry) => `${entry.title}\n${entry.body}`),
    ...pendingCompactions.map((entry) => entry.summary),
  ]);

  return entries
    .filter((entry) => !recentKeys.has(`${entry.timestamp}|${entry.title}`))
    .map((entry) => ({ entry, score: scoreRecalledEntry(entry, recallTerms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.timestamp.localeCompare(a.entry.timestamp))
    .slice(0, MAX_RECALLED_LOGS)
    .map(({ entry }) => entry)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function extractRecallTerms(texts: string[]): string[] {
  const counts = new Map<string, number>();

  for (const text of texts) {
    for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{3,}/g) ?? []) {
      if (STOP_WORDS.has(token) || /^\d+$/.test(token)) {
        continue;
      }
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_RECALL_TERMS)
    .map(([token]) => token);
}

function scoreRecalledEntry(entry: LogEntry, recallTerms: string[]): number {
  const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
  let score = importanceWeight(entry.importance);

  for (const term of recallTerms) {
    if (haystack.includes(term)) {
      score += 2;
    }
  }

  if (entry.importance === "high") {
    score += 2;
  }

  return score;
}

function importanceWeight(importance: ImportanceLevel): number {
  switch (importance) {
    case "high":
      return 3;
    case "medium":
      return 1;
    case "low":
      return 0;
  }
}

function countUndreamedLogs(entries: LogEntry[], lastDreamLogAt: string | null): number {
  return selectRecentLogEntries(entries, lastDreamLogAt).length;
}

function normalizePendingCompaction(input: unknown): PendingCompaction | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const timestamp = record.timestamp;
  const summary = record.summary;
  if (typeof timestamp !== "string" || !timestamp.trim() || typeof summary !== "string") {
    return null;
  }

  return {
    timestamp: timestamp.trim(),
    summary: normalizeMarkdownBlock(summary),
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
  return truncateText(normalizeInlineText(text), 100);
}

function normalizeInlineText(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
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
