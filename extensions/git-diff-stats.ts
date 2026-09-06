import {
  isEditToolResult,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const STATUS_KEY = "1-git-diff-stats";
const REFRESH_DEBOUNCE_MS = 250;
const WRITE_REFRESH_DEBOUNCE_MS = 1_000;
const GIT_KILL_GRACE_MS = 500;
const GIT_PIPE_GRACE_MS = 100;

type DiffStats = {
  added: number;
  removed: number;
};

function isInsideGitRepo(startDir: string): boolean {
  for (let currentDir = path.resolve(startDir); ; currentDir = path.dirname(currentDir)) {
    if (existsSync(path.join(currentDir, ".git"))) return true;
    if (path.dirname(currentDir) === currentDir) return false;
  }
}

function mergeNumstatEntries(output: string, statsByPath: Map<string, DiffStats>): void {
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const line = records[index];
    if (!line) continue;

    const firstTab = line.indexOf("\t");
    if (firstTab === -1) continue;

    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;

    let filePath = line.slice(secondTab + 1);
    if (!filePath) {
      // Renames carry separate old and new paths after the numstat record.
      index += 2;
      filePath = records[index];
    }
    if (!filePath || statsByPath.has(filePath)) continue;

    const addedToken = line.slice(0, firstTab);
    const removedToken = line.slice(firstTab + 1, secondTab);
    statsByPath.set(filePath, {
      added: addedToken === "-" ? 0 : Number(addedToken) || 0,
      removed: removedToken === "-" ? 0 : Number(removedToken) || 0,
    });
  }
}

async function gitText(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  options?: {
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    allowExitCode?: number;
  },
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let processError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;
    let escalated = false;
    const releaseOrphanedPipes = () => {
      if (!escalated || pipeTimer || (child.exitCode === null && child.signalCode === null)) return;
      pipeTimer = setTimeout(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, GIT_PIPE_GRACE_MS);
    };
    const onAbort = () => {
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        escalated = true;
        releaseOrphanedPipes();
      }, GIT_KILL_GRACE_MS);
    };

    child.on("error", (error) => {
      processError = error;
    });
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // Drain normally, but don't let a detached daemon retain cancelled work after Git exits.
    child.once("exit", releaseOrphanedPipes);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      clearTimeout(pipeTimer);
      child.removeListener("exit", releaseOrphanedPipes);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        killProcessGroup(child, "SIGKILL");
        reject(signal.reason);
        return;
      }
      if (processError) {
        reject(processError);
        return;
      }
      const exitCode = code ?? -1;
      if (exitCode !== 0 && exitCode !== options?.allowExitCode) {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        reject(new Error(details || `git ${args.join(" ")} failed`));
        return;
      }
      resolve(stdout);
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdin?.end(options?.stdin);
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process likely already exited.
    }
  }
}

async function computeLocalStats(cwd: string, signal: AbortSignal): Promise<DiffStats | undefined> {
  if (!isInsideGitRepo(cwd)) return undefined;

  const gitDir = (
    await gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"], signal)
  ).replace(/\n$/, "");
  const tempDir = await mkdtemp(path.join(gitDir, "pi-git-diff-stats-"));
  const tempIndex = path.join(tempDir, "index");
  const realIndex = path.join(gitDir, "index");

  try {
    try {
      await copyFile(realIndex, tempIndex);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    const headOid = (
      await gitText(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], signal, {
        allowExitCode: 1,
      })
    ).trim();
    const baseOid =
      headOid ||
      (await gitText(cwd, ["hash-object", "-t", "tree", "--stdin"], signal, { stdin: "" })).trim();

    const stagedDiff = await gitText(
      cwd,
      ["diff", "--cached", "--numstat", "-z", baseOid, "--"],
      signal,
      {
        env: { GIT_INDEX_FILE: tempIndex },
      },
    );
    await gitText(cwd, ["add", "-N", "--all"], signal, { env: { GIT_INDEX_FILE: tempIndex } });
    const workingTreeDiff = await gitText(cwd, ["diff", "--numstat", "-z", baseOid, "--"], signal, {
      env: { GIT_INDEX_FILE: tempIndex },
    });

    const statsByPath = new Map<string, DiffStats>();
    mergeNumstatEntries(workingTreeDiff, statsByPath);
    mergeNumstatEntries(stagedDiff, statsByPath);
    if (statsByPath.size === 0) return undefined;

    let added = 0;
    let removed = 0;
    for (const fileStats of statsByPath.values()) {
      added += fileStats.added;
      removed += fileStats.removed;
    }

    return { added, removed };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export default function gitDiffStatsExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let stats: DiffStats | undefined;
  let generation = 0;
  let refreshTimer: NodeJS.Timeout | undefined;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  let refreshController: AbortController | undefined;

  async function reset(nextCtx?: ExtensionContext): Promise<void> {
    const resetGeneration = ++generation;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    refreshQueued = false;
    const pending = refreshInFlight;
    refreshController?.abort();
    try {
      clearStatus();
      ctx = nextCtx;
      stats = undefined;
    } finally {
      await pending;
    }
    if (generation === resetGeneration && nextCtx?.hasUI) scheduleRefresh(0);
  }

  function clearStatus(): void {
    ctx?.ui.setStatus(STATUS_KEY, undefined);
  }

  function renderStatus(): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    activeCtx.ui.setStatus(
      STATUS_KEY,
      stats ? activeCtx.ui.theme.fg("dim", `+${stats.added} -${stats.removed}`) : undefined,
    );
  }

  function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    if (refreshTimer) clearTimeout(refreshTimer);

    const cwd = activeCtx.cwd;
    const refreshGeneration = generation;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh(cwd, refreshGeneration);
    }, delay);
  }

  function refresh(cwd: string, refreshGeneration: number): void {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    const controller = new AbortController();
    refreshController = controller;
    refreshInFlight = (async () => {
      try {
        const nextStats = await computeLocalStats(cwd, controller.signal);
        if (generation !== refreshGeneration) return;

        stats = nextStats;
        renderStatus();
      } catch {
        if (generation !== refreshGeneration) return;

        stats = undefined;
        clearStatus();
      } finally {
        refreshInFlight = null;
        refreshController = undefined;
        const queued = refreshQueued;
        refreshQueued = false;
        if (queued && generation === refreshGeneration) scheduleRefresh(0);
      }
    })();
  }

  pi.on("session_start", async (_event, nextCtx) => {
    await reset(nextCtx);
  });

  pi.on("tool_result", async (event, nextCtx) => {
    ctx = nextCtx;

    if (isEditToolResult(event) || isWriteToolResult(event)) {
      scheduleRefresh(WRITE_REFRESH_DEBOUNCE_MS);
    }
  });

  pi.on("turn_end", async (_event, nextCtx) => {
    ctx = nextCtx;
    scheduleRefresh();
  });

  pi.on("session_shutdown", async () => {
    await reset(undefined);
  });
}
