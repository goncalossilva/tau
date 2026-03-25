import { isEditToolResult, isWriteToolResult, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const STATUS_KEY = "git-diff-stats";
const REFRESH_DEBOUNCE_MS = 250;

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
  for (const line of output.split("\n")) {
    if (!line) continue;

    const firstTab = line.indexOf("\t");
    if (firstTab === -1) continue;

    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;

    const filePath = line.slice(secondTab + 1);
    if (statsByPath.has(filePath)) continue;

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
  options?: {
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    });

    let stdout = "";
    let stderr = "";

    child.on("error", reject);
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        reject(new Error(details || `git ${args.join(" ")} failed`));
        return;
      }

      resolve(stdout.trim());
    });

    child.stdin?.end(options?.stdin);
  });
}

async function computeLocalStats(cwd: string): Promise<DiffStats | undefined> {
  if (!isInsideGitRepo(cwd)) return undefined;

  const gitDir = await gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
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

    const addIntent = gitText(cwd, ["add", "-N", "--all"], { env: { GIT_INDEX_FILE: tempIndex } });
    const head = spawn("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let headStdout = "";
    let headStderr = "";
    head.stdout?.on("data", (chunk: Buffer) => {
      headStdout += chunk.toString("utf8");
    });
    head.stderr?.on("data", (chunk: Buffer) => {
      headStderr += chunk.toString("utf8");
    });

    const headOidPromise = new Promise<string | undefined>((resolve, reject) => {
      head.on("error", reject);
      head.on("close", (code) => {
        if (code === 0) {
          resolve(headStdout.trim());
          return;
        }
        if (code === 1) {
          resolve(undefined);
          return;
        }

        const details = [headStdout.trim(), headStderr.trim()].filter(Boolean).join("\n");
        reject(new Error(details || "git rev-parse --verify --quiet HEAD failed"));
      });
    });

    const [, headOid] = await Promise.all([addIntent, headOidPromise]);
    const baseOid = headOid ?? (await gitText(cwd, ["hash-object", "-t", "tree", "--stdin"], { stdin: "" }));

    const [workingTreeDiff, stagedDiff] = await Promise.all([
      gitText(cwd, ["diff", "--numstat", baseOid, "--"], { env: { GIT_INDEX_FILE: tempIndex } }),
      gitText(cwd, ["diff", "--cached", "--numstat", baseOid, "--"], { env: { GIT_INDEX_FILE: tempIndex } }),
    ]);

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

  function reset(nextCtx?: ExtensionContext): void {
    clearStatus();
    ctx = nextCtx;
    stats = undefined;
    generation += 1;
    resetRefreshState();

    if (nextCtx?.hasUI) scheduleRefresh(0);
  }

  function clearStatus(): void {
    ctx?.ui.setStatus(STATUS_KEY, undefined);
  }

  function renderStatus(): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    activeCtx.ui.setStatus(STATUS_KEY, stats ? activeCtx.ui.theme.fg("dim", `+${stats.added} -${stats.removed}`) : undefined);
  }

  function resetRefreshState(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    refreshInFlight = null;
    refreshQueued = false;
  }

  function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    if (refreshTimer) clearTimeout(refreshTimer);

    const cwd = activeCtx.cwd;
    const refreshGeneration = generation;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh(cwd, refreshGeneration);
    }, delay);
  }

  async function refresh(cwd: string, refreshGeneration: number): Promise<void> {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    const promise = (async () => {
      try {
        const nextStats = await computeLocalStats(cwd);
        if (generation !== refreshGeneration) return;

        stats = nextStats;
        renderStatus();
      } catch {
        if (generation !== refreshGeneration) return;

        stats = undefined;
        clearStatus();
      }
    })();

    refreshInFlight = promise;

    try {
      await promise;
    } finally {
      if (refreshInFlight !== promise) return;

      refreshInFlight = null;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh(0);
      }
    }
  }

  pi.on("session_start", async (_event, nextCtx) => {
    reset(nextCtx);
  });

  pi.on("session_switch", async (_event, nextCtx) => {
    reset(nextCtx);
  });

  pi.on("tool_result", async (event, nextCtx) => {
    ctx = nextCtx;

    if (isEditToolResult(event) || isWriteToolResult(event)) {
      scheduleRefresh(0);
    }
  });

  pi.on("turn_end", async (_event, nextCtx) => {
    ctx = nextCtx;
    scheduleRefresh();
  });

  pi.on("session_shutdown", async () => {
    reset(undefined);
  });
}
