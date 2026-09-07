import { spawn } from "node:child_process";
import {
  isBashToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "1-git-pr-status";

const PR_LOOKUP_TIMEOUT_MS = 5_000;
const BRANCH_CHECK_TIMEOUT_MS = 1_000;
const USER_BASH_SETTLE_DELAY_MS = 2_000;
const PROCESS_KILL_GRACE_MS = 500;
const PROCESS_PIPE_GRACE_MS = 100;

const GIT_BRANCH_CHANGE_COMMAND_PATTERN = /\bgit\s+(checkout|switch)\b/;
const GH_BRANCH_CHANGE_COMMAND_PATTERN = /\bgh\s+pr\s+checkout\b/;
const GH_PR_STATE_COMMAND_PATTERN = /\bgh\s+pr\s+(create|close|merge|ready|reopen)\b/;

type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

type PullRequestStatus = {
  number: number;
  url: string;
  state: PullRequestState;
};

type PullRequestLookupResult =
  | { kind: "found"; pullRequest: PullRequestStatus }
  | { kind: "none" }
  | { kind: "error" };

export default function gitPrStatusExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let currentBranch: string | null | undefined;
  let pullRequest: PullRequestStatus | undefined;
  let generation = 0;
  let refreshTimer: NodeJS.Timeout | undefined;
  let branchCheckTimer: NodeJS.Timeout | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let branchCheckInFlight: Promise<void> | undefined;
  let refreshQueued = false;
  let branchCheckQueued = false;
  let refreshController: AbortController | undefined;
  let branchCheckController: AbortController | undefined;

  pi.on("session_start", async (_event, nextCtx) => {
    await reset(nextCtx);
  });

  pi.on("user_bash", (event, nextCtx) => {
    if (!ctx) return;
    ctx = nextCtx;

    if (isBranchChangeCommand(event.command)) {
      scheduleBranchCheck(USER_BASH_SETTLE_DELAY_MS);
    } else if (isPullRequestStateCommand(event.command)) {
      scheduleRefresh(USER_BASH_SETTLE_DELAY_MS);
    }
  });

  pi.on("tool_result", async (event, nextCtx) => {
    if (!ctx) return;
    ctx = nextCtx;

    // PowerShell is intentionally not observed because Tau does not officially support Windows.
    if (!isBashToolResult(event)) return;
    if (typeof event.input.command !== "string") return;

    if (isBranchChangeCommand(event.input.command)) {
      scheduleBranchCheck(0);
    } else if (isPullRequestStateCommand(event.input.command)) {
      scheduleRefresh(0);
    }
  });

  pi.on("turn_end", async (_event, nextCtx) => {
    if (!ctx) return;
    ctx = nextCtx;
    scheduleBranchCheck(0);
  });

  pi.on("session_shutdown", async () => {
    await reset();
  });

  async function reset(nextCtx?: ExtensionContext): Promise<void> {
    const resetGeneration = ++generation;
    clearTimeout(refreshTimer);
    clearTimeout(branchCheckTimer);
    refreshTimer = undefined;
    branchCheckTimer = undefined;
    refreshQueued = false;
    branchCheckQueued = false;
    const pending = Promise.all([refreshInFlight, branchCheckInFlight]);
    refreshController?.abort();
    branchCheckController?.abort();
    const previousCtx = ctx;
    ctx = undefined;
    currentBranch = undefined;
    pullRequest = undefined;
    try {
      previousCtx?.ui.setStatus(STATUS_KEY, undefined);
    } finally {
      await pending;
    }
    if (generation === resetGeneration && nextCtx?.hasUI) {
      ctx = nextCtx;
      scheduleBranchCheck(0);
    }
  }

  function scheduleBranchCheck(delay: number): void {
    if (!ctx?.hasUI) return;
    clearTimeout(branchCheckTimer);
    const cwd = ctx.cwd;
    const branchGeneration = generation;
    branchCheckTimer = setTimeout(() => {
      branchCheckTimer = undefined;
      checkForBranchChange(cwd, branchGeneration);
    }, delay);
  }

  function checkForBranchChange(cwd: string, branchGeneration: number): void {
    if (branchCheckInFlight) {
      branchCheckQueued = true;
      return;
    }
    const controller = new AbortController();
    branchCheckController = controller;
    branchCheckInFlight = (async () => {
      try {
        const nextBranch = await loadCurrentBranch(cwd, controller.signal);
        if (generation !== branchGeneration || controller.signal.aborted) return;
        if (nextBranch === currentBranch) return;

        currentBranch = nextBranch;
        refreshController?.abort();
        pullRequest = undefined;
        applyStatus();
        scheduleRefresh(0);
      } catch {
        // A failed branch check is not evidence that the previous PR disappeared.
      } finally {
        branchCheckInFlight = undefined;
        branchCheckController = undefined;
        const queued = branchCheckQueued;
        branchCheckQueued = false;
        if (queued && generation === branchGeneration) scheduleBranchCheck(0);
      }
    })();
  }

  function scheduleRefresh(delay: number): void {
    if (!ctx?.hasUI) return;
    if (currentBranch === undefined) {
      scheduleBranchCheck(delay);
      return;
    }
    clearTimeout(refreshTimer);
    const cwd = ctx.cwd;
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
        const result = await loadPullRequestStatus(cwd, controller.signal);
        if (generation !== refreshGeneration || controller.signal.aborted) return;

        if (result.kind === "found") {
          pullRequest = result.pullRequest;
          applyStatus();
        } else if (result.kind === "none") {
          pullRequest = undefined;
          applyStatus();
        }
      } catch {
        // Cancellation and transport failures preserve the current branch's last known status.
      } finally {
        refreshInFlight = undefined;
        refreshController = undefined;
        const queued = refreshQueued;
        refreshQueued = false;
        if (queued && generation === refreshGeneration) scheduleRefresh(0);
      }
    })();
  }

  function applyStatus(): void {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      pullRequest ? formatPullRequestStatus(ctx, pullRequest) : undefined,
    );
  }
}

function isBranchChangeCommand(command: string): boolean {
  return (
    GIT_BRANCH_CHANGE_COMMAND_PATTERN.test(command) ||
    GH_BRANCH_CHANGE_COMMAND_PATTERN.test(command)
  );
}

function isPullRequestStateCommand(command: string): boolean {
  return GH_PR_STATE_COMMAND_PATTERN.test(command);
}

function formatPullRequestStatus(ctx: ExtensionContext, status: PullRequestStatus): string {
  const suffix = status.state === "OPEN" ? "" : ` (${status.state.toLowerCase()})`;
  return ctx.ui.theme.fg("dim", `#${status.number}${suffix}`);
}

async function loadCurrentBranch(cwd: string, signal: AbortSignal): Promise<string | null> {
  const result = await statusCommand(
    "git",
    ["branch", "--show-current"],
    cwd,
    signal,
    BRANCH_CHECK_TIMEOUT_MS,
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read Git branch");
  return result.stdout.trim() || null;
}

async function loadPullRequestStatus(
  cwd: string,
  signal: AbortSignal,
): Promise<PullRequestLookupResult> {
  const result = await statusCommand(
    "gh",
    ["pr", "view", "--json", "number,url,state"],
    cwd,
    signal,
    PR_LOOKUP_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    return result.stderr.toLowerCase().includes("no pull requests found for branch")
      ? { kind: "none" }
      : { kind: "error" };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      number?: unknown;
      state?: unknown;
      url?: unknown;
    };
    if (parsed.state !== "OPEN" && parsed.state !== "CLOSED" && parsed.state !== "MERGED")
      return { kind: "error" };
    if (typeof parsed.number !== "number" || !Number.isInteger(parsed.number) || parsed.number <= 0)
      return { kind: "error" };
    if (typeof parsed.url !== "string" || !parsed.url.trim()) return { kind: "error" };

    return {
      kind: "found",
      pullRequest: { number: parsed.number, url: parsed.url.trim(), state: parsed.state },
    };
  } catch {
    return { kind: "error" };
  }
}

/** Own the command and its pipes through close, including cancellation and timeout escalation. */
async function statusCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let processError: Error | undefined;
    let cancelled = false;
    let escalated = false;
    let killTimer: NodeJS.Timeout | undefined;
    let pipeTimer: NodeJS.Timeout | undefined;
    const releaseOrphanedPipes = () => {
      if (!escalated || pipeTimer || (child.exitCode === null && child.signalCode === null)) return;
      pipeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PROCESS_PIPE_GRACE_MS);
    };
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        escalated = true;
        releaseOrphanedPipes();
      }, PROCESS_KILL_GRACE_MS);
    };
    const timeoutTimer = setTimeout(onAbort, timeout);
    child.on("error", (error) => {
      processError = error;
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", releaseOrphanedPipes);
    child.once("close", (code) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(pipeTimer);
      child.removeListener("exit", releaseOrphanedPipes);
      signal.removeEventListener("abort", onAbort);
      if (cancelled) {
        killProcessGroup(child, "SIGKILL");
        reject(signal.reason ?? new Error(`${command} timed out`));
      } else if (processError) {
        reject(processError);
      } else {
        resolve({ stdout, stderr, code: code ?? -1 });
      }
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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
