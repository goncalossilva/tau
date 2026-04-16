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

// --- Constants and schemas ---

const MEMORY_DIR_NAME = ".agents/memory";
const CORE_BLOCK_NAMES = ["directives", "context", "focus", "pending"] as const;
const LOG_TYPES = ["decision", "prompt", "plan", "experiment"] as const;
const IMPORTANCE_LEVELS = ["high", "medium", "low"] as const;

// Keep core small and readable. The line cap is the primary structure constraint.
// The character cap is a secondary backstop against packing too much dense text into too few lines.
const CORE_LINE_CAP = 300;
const CORE_CHAR_CAP = 20_000;
const AUTO_DREAM_MIN_UNDREAMED_LOGS = 8;
const AUTO_DREAM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const AUTO_DREAM_CORE_LINE_THRESHOLD = 240;
const MAX_PENDING_COMPACTIONS = 8;
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
  supersedes: Type.Optional(
    Type.Array(
      Type.String({ description: "Prior memory references superseded by this log entry" }),
    ),
  ),
  invalidates: Type.Optional(
    Type.Array(Type.String({ description: "Prior assumptions invalidated by this log entry" })),
  ),
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
- Keep the combined total across all returned blocks at or below ${CORE_LINE_CAP} lines and ${CORE_CHAR_CAP} characters.
- Enforce both caps only in your output, not by dropping input context from the read phase.
- Consolidate only from the provided core, undreamed logs, and compaction notes. Do not retrieve or invent older log entries.
- directives: stable rules, preferences, and standing constraints.
- context: stable architecture, behavior, important decisions, and lessons from failed or rejected attempts.
- focus: the current objective and immediate next steps.
- pending: unresolved follow-ups, open questions, blocked work.
- Use explicit invalidates/supersedes links when resolving contradictions.
- Preserve unresolved pending items. Do not clear pending unless the summary explicitly says they were resolved or abandoned.
- Keep every block short, concrete, and high-signal.
- Self-check that JSON.parse(output) succeeds before responding.`;

// --- Types and errors ---

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
  supersedes: string[];
  invalidates: string[];
};

type PendingCompaction = {
  timestamp: string;
  summary: string;
};

type MemoryState = {
  // Newest timestamp appended to log.md.
  lastLogAt: string | null;
  // Timestamp of the most recent successful dream run.
  lastDreamAt: string | null;
  // Next dream replays log.md entries newer than this timestamp.
  lastDreamedLogAt: string | null;
  // session_compact summaries waiting to be folded into core.
  pendingCompactions: PendingCompaction[];
};

type MemoryStateFile = {
  last_log_at: string | null;
  last_dream_at: string | null;
  last_dreamed_log_at: string | null;
  pending_compactions: PendingCompaction[];
};

type CoreReadResult = {
  exists: boolean;
  blocks: CoreBlocks;
  missing: MemoryBlockName[];
  totalLines: number;
  totalChars: number;
};

type MemoryStatus = {
  initialized: boolean;
  coreExists: boolean;
  coreLines: number;
  coreChars: number;
  missingCoreFiles: MemoryBlockName[];
  lastLogAt: string | null;
  lastDreamAt: string | null;
  lastDreamedLogAt: string | null;
  undreamedLogs: number;
  pendingCompactions: number;
  researchFiles: number;
  hasLog: boolean;
};

type DreamReplay = {
  readme: string;
  blocks: CoreBlocks;
  totalLines: number;
  totalChars: number;
  undreamedEntries: LogEntry[];
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
  lastDreamedLogAt: string | null;
  summaryPath: string | null;
};

type AutoDreamStatus = {
  coreLines: number;
  undreamedLogs: number;
  oldestUndreamedAt: string | null;
  pendingCompactions: number;
};

type AutoDreamTrigger = "session_start" | "session_compact";

type AutoDreamState = {
  promise: Promise<void> | null;
};

type ModelSelection = {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
};

class MemoryReadmeMissingError extends Error {
  constructor(readmePath: string) {
    super(`${readmePath} is missing. Run /memory init to recreate it or restore it from git.`);
    this.name = "MemoryReadmeMissingError";
  }
}

function isMemoryReadmeMissingError(error: unknown): error is MemoryReadmeMissingError {
  return error instanceof MemoryReadmeMissingError;
}

// --- Core memory operations ---

async function toolDream(
  cwd: string,
  ctx: ExtensionContext,
  reason?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: DreamResult }> {
  try {
    const result = await runMemoryDream(cwd, ctx, reason);
    return {
      content: [{ type: "text", text: result.summary }],
      details: result,
    };
  } catch (error) {
    if (isMemoryReadmeMissingError(error)) {
      notify(ctx, error.message, "warning");
    }
    throw error;
  }
}

async function maybeScheduleAutoDream(
  cwd: string,
  ctx: ExtensionContext,
  trigger: AutoDreamTrigger,
  state: AutoDreamState,
): Promise<boolean> {
  if (!ctx.model) {
    return false;
  }

  if (state.promise) {
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
  state.promise = runMemoryDream(cwd, ctx, reason)
    .then(() => undefined)
    .catch((error) => {
      if (isMemoryReadmeMissingError(error)) {
        return;
      }
      notify(ctx, formatAutoDreamError(error), "warning");
    })
    .finally(() => {
      state.promise = null;
    });

  return true;
}

// Mutating entry points acquire the path locks they need before touching memory files.
async function initMemory(cwd: string): Promise<{ created: string[]; gitignoreUpdated: boolean }> {
  const paths = getMemoryPaths(cwd);
  const lockPaths = [
    paths.gitignoreFile,
    paths.readmeFile,
    paths.logFile,
    paths.stateFile,
    paths.compactionsDir,
    paths.researchDir,
    paths.attachmentsDir,
    ...Object.values(paths.coreFiles),
  ];

  return withMemoryMutationQueue(lockPaths, async () => initMemoryUnsafe(cwd));
}

async function updateCoreBlock(
  cwd: string,
  name: MemoryBlockName,
  content: string,
): Promise<{ totalLines: number; totalChars: number }> {
  const paths = getMemoryPaths(cwd);
  return withMemoryMutationQueue(Object.values(paths.coreFiles), async () =>
    updateCoreBlockUnsafe(cwd, name, content),
  );
}

async function appendMemoryLog(
  cwd: string,
  entry: {
    type: LogType;
    title: string;
    body: string;
    importance?: ImportanceLevel;
    supersedes?: string[];
    invalidates?: string[];
  },
): Promise<LogEntry> {
  const paths = getMemoryPaths(cwd);
  return withMemoryMutationQueue([paths.logFile, paths.stateFile], async () =>
    appendMemoryLogUnsafe(cwd, {
      timestamp: nowIso(),
      type: entry.type,
      importance: entry.importance ?? DEFAULT_LOG_IMPORTANCE,
      title: normalizeTitle(entry.title) || "Memory log entry",
      body: normalizeMarkdownBlock(entry.body),
      supersedes: normalizeMemoryReferences(entry.supersedes),
      invalidates: normalizeMemoryReferences(entry.invalidates),
    }),
  );
}

async function enqueuePendingCompaction(cwd: string, compaction: PendingCompaction): Promise<void> {
  const paths = getMemoryPaths(cwd);
  await withFileMutationQueue(paths.stateFile, async () => {
    const state = await readStateUnsafe(cwd);
    const pending = [...state.pendingCompactions, normalizePendingCompaction(compaction)]
      .filter((entry): entry is PendingCompaction => entry !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-MAX_PENDING_COMPACTIONS);

    await writeStateUnsafe(cwd, {
      ...state,
      pendingCompactions: pending,
    });
  });
}

// Dream reads current core, log.md entries newer than lastDreamedLogAt,
// pending compactions, and the memory README rules.
// Dream writes rewritten core blocks, a dream summary in compactions/,
// and state.json with lastDreamAt, lastDreamedLogAt, and an empty pendingCompactions queue.
async function runMemoryDream(
  cwd: string,
  ctx: ExtensionContext,
  reason?: string,
): Promise<DreamResult> {
  const paths = getMemoryPaths(cwd);
  const lockPaths = [
    paths.logFile,
    paths.stateFile,
    paths.compactionsDir,
    ...Object.values(paths.coreFiles),
  ];

  return withMemoryMutationQueue(lockPaths, async () => {
    ensureMemoryInitialized(await pathExists(paths.memoryRoot));

    const replay = await collectDreamReplay(cwd);
    if (!shouldRunDream(replay, reason)) {
      const summary = "Memory dream: nothing to consolidate.";
      notify(ctx, summary, "info");
      return {
        summary,
        updatedBlocks: [],
        consumedLogs: 0,
        consumedCompactions: 0,
        lastDreamAt: (await readStateUnsafe(cwd)).lastDreamAt ?? nowIso(),
        lastDreamedLogAt: (await readStateUnsafe(cwd)).lastDreamedLogAt,
        summaryPath: null,
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

    const finalCoreChars = getCoreCharCount(finalBlocks);
    if (finalCoreChars > CORE_CHAR_CAP) {
      throw new Error(
        `Memory dream proposed ${finalCoreChars} core characters, exceeding the ${CORE_CHAR_CAP}-character cap.`,
      );
    }

    await writeCoreBlocksUnsafe(cwd, finalBlocks);

    const previousState = await readStateUnsafe(cwd);
    const dreamTimestamp = nowIso();
    const lastDreamedLogAt =
      replay.undreamedEntries.at(-1)?.timestamp ?? previousState.lastDreamedLogAt;
    await writeStateUnsafe(cwd, {
      ...previousState,
      lastDreamAt: dreamTimestamp,
      lastDreamedLogAt,
      pendingCompactions: [],
    });

    const updatedBlocks = CORE_BLOCK_NAMES.filter(
      (name) =>
        normalizeMarkdownBlock(replay.blocks[name]) !== normalizeMarkdownBlock(finalBlocks[name]),
    );
    const summary = buildDreamSummary(updatedBlocks, replay, abstraction.summary);
    const summaryPath = await writeDreamSummary(cwd, {
      timestamp: dreamTimestamp,
      reason,
      summary,
      updatedBlocks,
      undreamedEntries: replay.undreamedEntries,
      pendingCompactions: replay.pendingCompactions,
      lastDreamedLogAt,
    });
    notify(ctx, summary, "info");

    return {
      summary,
      updatedBlocks,
      consumedLogs: replay.undreamedEntries.length,
      consumedCompactions: replay.pendingCompactions.length,
      lastDreamAt: dreamTimestamp,
      lastDreamedLogAt,
      summaryPath,
    };
  });
}

async function loadMemoryPrompt(cwd: string): Promise<string | undefined> {
  const paths = getMemoryPaths(cwd);
  if (!(await pathExists(paths.memoryRoot))) {
    return undefined;
  }

  const [readme, core, researchFiles] = await Promise.all([
    readMemoryReadme(cwd),
    readCoreBlocksUnsafe(cwd),
    listResearchFiles(cwd),
  ]);

  return buildMemoryPrompt(readme, core.blocks, researchFiles);
}

async function loadMemoryStatus(cwd: string): Promise<MemoryStatus> {
  const paths = getMemoryPaths(cwd);
  const initialized = await pathExists(paths.memoryRoot);
  if (!initialized) {
    return {
      initialized: false,
      coreExists: false,
      coreLines: 0,
      coreChars: 0,
      missingCoreFiles: [...CORE_BLOCK_NAMES],
      lastLogAt: null,
      lastDreamAt: null,
      lastDreamedLogAt: null,
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
    coreChars: core.totalChars,
    missingCoreFiles: core.missing,
    lastLogAt: entries.at(-1)?.timestamp ?? state.lastLogAt,
    lastDreamAt: state.lastDreamAt,
    lastDreamedLogAt: state.lastDreamedLogAt,
    undreamedLogs: countUndreamedLogs(entries, state.lastDreamedLogAt),
    pendingCompactions: state.pendingCompactions.length,
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
  const undreamedEntries = selectUndreamedLogEntries(entries, state.lastDreamedLogAt);

  return {
    coreLines: core.totalLines,
    undreamedLogs: undreamedEntries.length,
    oldestUndreamedAt: undreamedEntries[0]?.timestamp ?? null,
    pendingCompactions: state.pendingCompactions.length,
  };
}

// Mutating *Unsafe helpers assume the corresponding path locks are already held.
async function initMemoryUnsafe(
  cwd: string,
): Promise<{ created: string[]; gitignoreUpdated: boolean }> {
  const paths = getMemoryPaths(cwd);
  const created: string[] = [];

  await ensureDir(paths.memoryRoot);
  await ensureDir(paths.coreDir);
  await ensureDir(paths.compactionsDir);
  await ensureDir(paths.researchDir);
  await ensureDir(paths.attachmentsDir);

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

  const gitignoreUpdated = await ensureAttachmentsPathIgnored(paths.gitignoreFile);
  return { created, gitignoreUpdated };
}

async function updateCoreBlockUnsafe(
  cwd: string,
  name: MemoryBlockName,
  content: string,
): Promise<{ totalLines: number; totalChars: number }> {
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

  const totalChars = getCoreCharCount(nextBlocks);
  if (totalChars > CORE_CHAR_CAP) {
    throw new Error(
      `Core block update would exceed the ${CORE_CHAR_CAP}-character cap (${totalChars}). Run memory_dream or remove content first.`,
    );
  }

  await ensureDir(paths.coreDir);
  await fs.writeFile(paths.coreFiles[name], nextBlocks[name], "utf8");
  return { totalLines, totalChars };
}

async function appendMemoryLogUnsafe(cwd: string, entry: LogEntry): Promise<LogEntry> {
  const paths = getMemoryPaths(cwd);
  ensureMemoryInitialized(await pathExists(paths.memoryRoot));

  const current = (await readTextIfExists(paths.logFile)) ?? "";
  const prefix = current.trim().length > 0 ? current.trimEnd() : "# Memory log";
  const chunk = [
    `## ${entry.timestamp} | ${entry.type} | ${entry.importance} | ${entry.title}`,
    "",
    renderLogEntryBody(entry),
  ].join("\n");

  await ensureDir(path.dirname(paths.logFile));
  await fs.writeFile(paths.logFile, `${prefix}\n\n${chunk}\n`, "utf8");

  const state = await readStateUnsafe(cwd);
  await writeStateUnsafe(cwd, {
    ...state,
    lastLogAt: entry.timestamp,
  });

  return entry;
}

async function collectDreamReplay(cwd: string): Promise<DreamReplay> {
  const paths = getMemoryPaths(cwd);
  const [readme, core, state, logText, researchFiles] = await Promise.all([
    readMemoryReadme(cwd),
    readCoreBlocksUnsafe(cwd),
    readStateUnsafe(cwd),
    readTextIfExists(paths.logFile),
    listResearchFiles(cwd),
  ]);
  const entries = parseMemoryLog(logText ?? "");
  const undreamedEntries = selectUndreamedLogEntries(entries, state.lastDreamedLogAt);

  return {
    readme,
    blocks: core.blocks,
    totalLines: core.totalLines,
    totalChars: core.totalChars,
    undreamedEntries,
    pendingCompactions: state.pendingCompactions,
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
    totalChars: getCoreCharCount(blocks),
  };
}

async function readStateUnsafe(cwd: string): Promise<MemoryState> {
  const raw = await readTextIfExists(getMemoryPaths(cwd).stateFile);
  if (!raw?.trim()) {
    return defaultMemoryState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MemoryStateFile>;
    return {
      lastLogAt: typeof parsed.last_log_at === "string" ? parsed.last_log_at : null,
      lastDreamAt: typeof parsed.last_dream_at === "string" ? parsed.last_dream_at : null,
      lastDreamedLogAt:
        typeof parsed.last_dreamed_log_at === "string" ? parsed.last_dreamed_log_at : null,
      pendingCompactions: Array.isArray(parsed.pending_compactions)
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
  const stateFile: MemoryStateFile = {
    last_log_at: state.lastLogAt,
    last_dream_at: state.lastDreamAt,
    last_dreamed_log_at: state.lastDreamedLogAt,
    pending_compactions: state.pendingCompactions,
  };
  await ensureDir(path.dirname(paths.stateFile));
  await fs.writeFile(paths.stateFile, `${JSON.stringify(stateFile, null, 2)}\n`, "utf8");
}

async function writeCompactionSummary(cwd: string, compaction: PendingCompaction): Promise<void> {
  const paths = getMemoryPaths(cwd);
  await withFileMutationQueue(paths.compactionsDir, async () => {
    ensureMemoryInitialized(await pathExists(paths.memoryRoot));

    const filePath = path.join(
      paths.compactionsDir,
      `${formatTimestampForFilename(compaction.timestamp)}-compaction.md`,
    );
    await ensureDir(paths.compactionsDir);
    await fs.writeFile(filePath, buildCompactionSummaryContent(compaction), "utf8");
  });
}

async function writeDreamSummary(
  cwd: string,
  summary: {
    timestamp: string;
    reason?: string;
    summary: string;
    updatedBlocks: MemoryBlockName[];
    undreamedEntries: LogEntry[];
    pendingCompactions: PendingCompaction[];
    lastDreamedLogAt: string | null;
  },
): Promise<string> {
  const paths = getMemoryPaths(cwd);
  const filePath = path.join(
    paths.compactionsDir,
    `${formatTimestampForFilename(summary.timestamp)}-dream.md`,
  );
  await ensureDir(paths.compactionsDir);
  await fs.writeFile(filePath, buildDreamSummaryContent(summary), "utf8");
  return path.relative(cwd, filePath);
}

// Runtime memory use reads .agents/memory/README.md from disk.
// /memory init recreates it when missing.
async function readMemoryReadme(cwd: string): Promise<string> {
  const readmePath = getMemoryPaths(cwd).readmeFile;
  const readme = await readTextIfExists(readmePath);
  if (readme !== undefined) {
    return readme;
  }

  throw new MemoryReadmeMissingError(path.relative(cwd, readmePath));
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

async function ensureAttachmentsPathIgnored(gitignoreFile: string): Promise<boolean> {
  const attachmentsLine = "/.agents/memory/attachments/";
  const current = (await readTextIfExists(gitignoreFile)) ?? "";
  const lines = current.replace(/\r/g, "").split("\n");
  const alreadyIgnored = lines.some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === attachmentsLine ||
      trimmed === ".agents/memory/attachments/" ||
      trimmed === "/.agents/memory/attachments"
    );
  });

  if (alreadyIgnored) {
    return false;
  }

  const prefix = current.length === 0 ? "" : current.endsWith("\n") ? "" : "\n";
  await fs.writeFile(gitignoreFile, `${current}${prefix}${attachmentsLine}\n`, "utf8");
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

// --- Prompt and command helpers ---

function buildDreamUserMessage(replay: DreamReplay, reason?: string): UserMessage {
  const prompt = [
    reason?.trim() ? `Dream reason: ${reason.trim()}` : "Dream reason: consolidate repo memory.",
    `Current core size: ${replay.totalLines}/${CORE_LINE_CAP} lines, ${replay.totalChars}/${CORE_CHAR_CAP} chars`,
    "",
    "Source-of-truth memory rules:",
    "<memory-readme>",
    replay.readme.trimEnd() || "(missing)",
    "</memory-readme>",
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
    "<undreamed-log>",
    formatLogEntriesForPrompt(replay.undreamedEntries) || "(none)",
    "</undreamed-log>",
    "",
    "<compaction-notes>",
    formatPendingCompactionsForPrompt(replay.pendingCompactions) || "(none)",
    "</compaction-notes>",
    "",
    "<research-files>",
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
    throw new Error("error" in auth ? auth.error : "Memory dream is missing model auth.");
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

// Reject dream proposals that clear pending.md unless the summary says the work
// was resolved or abandoned.
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

function buildMemoryPrompt(readme: string, blocks: CoreBlocks, researchFiles: string[]): string {
  const sections = [
    "<repo_memory>",
    "Use repo memory for continuity across sessions in this repo.",
    "Source-of-truth memory rules:",
    "<memory-readme>",
    readme.trimEnd() || "(missing)",
    "</memory-readme>",
    "",
    researchFiles.length > 0
      ? `Research abstracts available: ${researchFiles.join(", ")}`
      : "Research abstracts available: none.",
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
    "This repository uses Pi-managed project-local memory under `.agents/memory/`.",
    "",
    "## Layout",
    "",
    `- \`core/\` — four short markdown blocks (\`directives.md\`, \`context.md\`, \`focus.md\`, \`pending.md\`). Their combined total must stay at or below ${CORE_LINE_CAP} lines and ${CORE_CHAR_CAP} characters. Enforce both caps only when writing core or finalizing a dream, not when reading.`,
    "- `log.md` — append-only markdown log for decisions, prompts, plans, experiments, attachment additions, and lessons from failed or rejected attempts. Use explicit `supersedes` and `invalidates` links when an entry replaces or corrects prior memory.",
    "- `compactions/` — immutable dream and compaction summaries with provenance.",
    "- `research/` — use it for short abstracts of actual external SOTA research that materially informs the current work. Read relevant files on demand before relying on them.",
    "- `attachments/` — only user-requested or user-facing files used to collaborate with the user. This folder is gitignored. Do not use it as scratch space. If you add something here, also append a log entry naming the file and why it exists.",
    "",
    "## Write rules",
    "",
    "- If work is left unfinished, update `core/pending.md`.",
    "- If architecture or behavior changes, update `core/context.md`.",
    "- If user preferences or standing constraints change, update `core/directives.md`.",
    "- If focus shifts, update `core/focus.md`.",
    "- If an important decision, prompt ingest, plan, experiment, attachment addition, or lesson from a failed or rejected attempt happens, append to `log.md`.",
    "- If a new log entry replaces or corrects prior memory, include explicit `supersedes` and/or `invalidates` links.",
    "- If the user provides a substantial brief, append it as a `prompt | high` log entry.",
    "",
    "## Dream",
    "",
    "Dream is the only consolidation mechanism for `core/`.",
    "",
    "Pi can trigger dreaming automatically on session start when logs are stale and after compaction when new compaction context should be folded into memory. You can also run `/memory dream` manually.",
    "",
    "Dream reads all log entries newer than the last dreamed log timestamp plus pending compaction summaries. It does not automatically retrieve older log entries.",
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
    replay.undreamedEntries.length > 0
      ? `consumed ${replay.undreamedEntries.length} new log entr${replay.undreamedEntries.length === 1 ? "y" : "ies"}`
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

  if (status.undreamedLogs >= AUTO_DREAM_MIN_UNDREAMED_LOGS) {
    return `Automatic dream on session start with ${status.undreamedLogs} undreamed log entries.`;
  }

  if (status.coreLines >= AUTO_DREAM_CORE_LINE_THRESHOLD && status.undreamedLogs > 0) {
    return `Automatic dream on session start with core at ${status.coreLines}/${CORE_LINE_CAP} lines and fresh log backlog.`;
  }

  return "Automatic dream on session start because undreamed memory is stale.";
}

function formatLogEntriesForPrompt(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  return entries
    .map((entry) => {
      return [
        `## ${entry.timestamp} | ${entry.type} | ${entry.importance} | ${entry.title}`,
        "",
        renderLogEntryBody(entry),
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
    ? `Initialized .agents/memory/ (${parts.join(", ")}).`
    : "Memory already initialized.";
}

function formatMemoryStatus(status: MemoryStatus): string {
  if (!status.initialized) {
    return "Memory: not initialized. Run /memory init.";
  }

  const lines = [
    "Memory: initialized",
    `Core lines: ${status.coreLines}/${CORE_LINE_CAP}`,
    `Core chars: ${status.coreChars}/${CORE_CHAR_CAP}`,
    `Last log: ${status.lastLogAt ?? "never"}`,
    `Last dream: ${status.lastDreamAt ?? "never"}`,
    `Last dreamed log timestamp: ${status.lastDreamedLogAt ?? "never"}`,
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
): { command: "init" | "status" | "dream"; text: string } | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }

  const firstSpace = trimmed.indexOf(" ");
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const text = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  if (command === "init" || command === "status" || command === "dream") {
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
  ];
  const matches = options.filter((option) => option.label.startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

// --- Parsing and utilities ---

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
    lastLogAt: null,
    lastDreamAt: null,
    lastDreamedLogAt: null,
    pendingCompactions: [],
  };
}

function getMemoryPaths(cwd: string): {
  memoryRoot: string;
  coreDir: string;
  compactionsDir: string;
  researchDir: string;
  attachmentsDir: string;
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
    compactionsDir: path.join(memoryRoot, "compactions"),
    researchDir: path.join(memoryRoot, "research"),
    attachmentsDir: path.join(memoryRoot, "attachments"),
    logFile: path.join(memoryRoot, "log.md"),
    stateFile: path.join(memoryRoot, "state.json"),
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
    replay.undreamedEntries.length > 0 ||
    replay.pendingCompactions.length > 0 ||
    replay.totalLines >= AUTO_DREAM_CORE_LINE_THRESHOLD ||
    Boolean(reason?.trim())
  );
}

// Auto-dream runs immediately when pending compactions exist.
// Otherwise it only runs on session_start, based on log backlog, core size, or log age.
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

  if (status.undreamedLogs >= AUTO_DREAM_MIN_UNDREAMED_LOGS) {
    return true;
  }

  if (status.coreLines >= AUTO_DREAM_CORE_LINE_THRESHOLD) {
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
  let current: Omit<LogEntry, "body" | "supersedes" | "invalidates"> | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (!current) {
      return;
    }

    const parsedBody = parseLogEntryBody(bodyLines.join("\n"));
    entries.push({
      ...current,
      body: parsedBody.body,
      supersedes: parsedBody.supersedes,
      invalidates: parsedBody.invalidates,
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

function selectUndreamedLogEntries(
  entries: LogEntry[],
  lastDreamedLogAt: string | null,
): LogEntry[] {
  if (!lastDreamedLogAt) {
    return [...entries];
  }
  return entries.filter((entry) => entry.timestamp > lastDreamedLogAt);
}

function countUndreamedLogs(entries: LogEntry[], lastDreamedLogAt: string | null): number {
  return selectUndreamedLogEntries(entries, lastDreamedLogAt).length;
}

function parseLogEntryBody(body: string): {
  body: string;
  supersedes: string[];
  invalidates: string[];
} {
  const normalized = body.replace(/\r/g, "").trimEnd();
  if (!normalized) {
    return {
      body: "",
      supersedes: [],
      invalidates: [],
    };
  }

  const lines = normalized.split("\n");
  const headingIndex = lines.lastIndexOf("## Memory links");
  if (headingIndex === -1) {
    return {
      body: normalizeMarkdownBlock(normalized),
      supersedes: [],
      invalidates: [],
    };
  }

  const linkLines = lines.slice(headingIndex + 1).filter((line) => line.trim().length > 0);
  const supersedes: string[] = [];
  const invalidates: string[] = [];

  for (const line of linkLines) {
    const supersedesMatch = line.match(/^-\s+Supersedes:\s+(.+)$/);
    if (supersedesMatch) {
      supersedes.push(normalizeInlineText(supersedesMatch[1]));
      continue;
    }

    const invalidatesMatch = line.match(/^-\s+Invalidates:\s+(.+)$/);
    if (invalidatesMatch) {
      invalidates.push(normalizeInlineText(invalidatesMatch[1]));
      continue;
    }

    return {
      body: normalizeMarkdownBlock(normalized),
      supersedes: [],
      invalidates: [],
    };
  }

  return {
    body: normalizeMarkdownBlock(lines.slice(0, headingIndex).join("\n")),
    supersedes: normalizeMemoryReferences(supersedes),
    invalidates: normalizeMemoryReferences(invalidates),
  };
}

function renderLogEntryBody(entry: LogEntry): string {
  const body = entry.body.trim() || "_No details._";
  const linkLines = [
    ...entry.supersedes.map((reference) => `- Supersedes: ${reference}`),
    ...entry.invalidates.map((reference) => `- Invalidates: ${reference}`),
  ];

  if (linkLines.length === 0) {
    return body;
  }

  return [body, "", "## Memory links", "", ...linkLines].join("\n");
}

function normalizeMemoryReferences(input: string[] | undefined): string[] {
  const seen = new Set<string>();
  const references: string[] = [];

  for (const value of input ?? []) {
    const normalized = normalizeInlineText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    references.push(normalized);
  }

  return references;
}

function formatTimestampForFilename(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function buildCompactionSummaryContent(compaction: PendingCompaction): string {
  return [
    "# Compaction summary",
    "",
    `- Timestamp: ${compaction.timestamp}`,
    "- Source: session_compact",
    "",
    "## Summary",
    "",
    compaction.summary.trim() || "_No summary._",
    "",
  ].join("\n");
}

function buildDreamSummaryContent(summary: {
  timestamp: string;
  reason?: string;
  summary: string;
  updatedBlocks: MemoryBlockName[];
  undreamedEntries: LogEntry[];
  pendingCompactions: PendingCompaction[];
  lastDreamedLogAt: string | null;
}): string {
  const logRange =
    summary.undreamedEntries.length > 0
      ? `${summary.undreamedEntries[0]?.timestamp} → ${summary.undreamedEntries.at(-1)?.timestamp}`
      : "none";

  return [
    "# Dream summary",
    "",
    `- Timestamp: ${summary.timestamp}`,
    `- Reason: ${normalizeInlineText(summary.reason ?? "") || "automatic or manual consolidation"}`,
    `- Updated blocks: ${summary.updatedBlocks.join(", ") || "none"}`,
    `- Undreamed log count: ${summary.undreamedEntries.length}`,
    `- Undreamed log range: ${logRange}`,
    `- Pending compaction count: ${summary.pendingCompactions.length}`,
    `- Last dreamed log timestamp: ${summary.lastDreamedLogAt ?? "none"}`,
    "",
    "## Pending compaction timestamps",
    "",
    summary.pendingCompactions.length > 0
      ? summary.pendingCompactions.map((entry) => `- ${entry.timestamp}`).join("\n")
      : "- none",
    "",
    "## Summary",
    "",
    summary.summary.trim() || "_No summary._",
    "",
  ].join("\n");
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

function getCoreCharCount(blocks: CoreBlocks): number {
  return CORE_BLOCK_NAMES.reduce((total, name) => total + countChars(blocks[name]), 0);
}

function countLines(text: string): number {
  const normalized = text.replace(/\r/g, "").replace(/\n+$/g, "");
  return normalized ? normalized.split("\n").length : 0;
}

function countChars(text: string): number {
  return text.replace(/\r/g, "").replace(/\n+$/g, "").length;
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

// --- Extension registration ---

export default function memoryExtension(pi: ExtensionAPI): void {
  const autoDreamState: AutoDreamState = { promise: null };
  let pendingStartupDreamCheck = false;

  pi.registerTool(
    defineTool({
      name: "memory_update_block",
      label: "Memory Update Block",
      description: `Update one .agents/memory/core block while enforcing the shared ${CORE_LINE_CAP}-line and ${CORE_CHAR_CAP}-character caps`,
      promptSnippet: `Update one core memory block in .agents/memory/core with ${CORE_LINE_CAP}-line and ${CORE_CHAR_CAP}-character cap enforcement`,
      promptGuidelines: [
        "Use this tool when updating .agents/memory/core/directives.md, context.md, focus.md, or pending.md.",
        `If a write would exceed the ${CORE_LINE_CAP}-line or ${CORE_CHAR_CAP}-character core cap, run memory_dream or remove content first.`,
      ],
      parameters: MEMORY_UPDATE_BLOCK_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await updateCoreBlock(ctx.cwd, params.name, params.content);

        return {
          content: [
            {
              type: "text",
              text: `Updated .agents/memory/core/${params.name}.md (${result.totalLines}/${CORE_LINE_CAP} lines, ${result.totalChars}/${CORE_CHAR_CAP} chars).`,
            },
          ],
          details: {
            block: params.name,
            total_lines: result.totalLines,
            total_chars: result.totalChars,
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_append_log",
      label: "Memory Append Log",
      description: "Append an entry to .agents/memory/log.md using the repo memory log format",
      promptSnippet: "Append an entry to the repo memory log at .agents/memory/log.md",
      promptGuidelines: [
        "Use this tool for important decisions, discoveries, plans, experiments, prompt ingests, and attachment additions worth remembering.",
        "Use importance labels high, medium, or low.",
        "If this entry replaces or corrects prior memory, set supersedes and/or invalidates links explicitly.",
        "The memory log is append-only. Do not rewrite or truncate older entries.",
      ],
      parameters: MEMORY_APPEND_LOG_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const entry = await appendMemoryLog(ctx.cwd, {
          type: params.type,
          title: params.title,
          body: params.body,
          importance: params.importance,
          supersedes: params.supersedes,
          invalidates: params.invalidates,
        });

        return {
          content: [
            {
              type: "text",
              text: `Appended .agents/memory/log.md entry: ${entry.title}.`,
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
        "Consolidate repo memory into .agents/memory/core from newer log entries and compaction context",
      promptSnippet: "Consolidate repo memory with dream-based core compression",
      promptGuidelines: [
        "Dream is the only consolidation mechanism for .agents/memory/core.",
        "Use this tool when logs have accumulated, core needs compression, or recent compaction context should be folded into memory.",
      ],
      parameters: MEMORY_DREAM_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return toolDream(ctx.cwd, ctx, params.reason);
      },
    }),
  );

  pi.registerCommand("memory", {
    description: "Manage project-local memory in .agents/memory/",
    getArgumentCompletions: getMemoryArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseMemoryCommandArgs(args);
      if (!parsed) {
        notify(ctx, "Usage: /memory init | status | dream [reason]", "warning");
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
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const prompt = await loadMemoryPrompt(ctx.cwd);
      if (!prompt) {
        return;
      }

      return {
        systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
      };
    } catch (error) {
      if (isMemoryReadmeMissingError(error)) {
        notify(ctx, `Repo memory disabled: ${error.message}`, "warning");
        return;
      }
      throw error;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    pendingStartupDreamCheck = !(await maybeScheduleAutoDream(
      ctx.cwd,
      ctx,
      "session_start",
      autoDreamState,
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
    await maybeScheduleAutoDream(ctx.cwd, ctx, "session_start", autoDreamState);
  });

  pi.on("session_compact", async (event, ctx) => {
    const paths = getMemoryPaths(ctx.cwd);
    if (!(await pathExists(paths.memoryRoot))) {
      return;
    }

    const pendingCompaction = {
      timestamp: event.compactionEntry.timestamp,
      summary: event.compactionEntry.summary,
    };

    await Promise.all([
      enqueuePendingCompaction(ctx.cwd, pendingCompaction),
      writeCompactionSummary(ctx.cwd, pendingCompaction),
    ]);
    await maybeScheduleAutoDream(ctx.cwd, ctx, "session_compact", autoDreamState);
  });
}
