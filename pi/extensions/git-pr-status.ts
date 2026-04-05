import {
  isBashToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "0-git-pr-status";

const REFRESH_DEBOUNCE_MS = 250;
const PR_LOOKUP_TIMEOUT_MS = 5_000;
const BRANCH_CHECK_TIMEOUT_MS = 1_000;
const USER_BASH_SETTLE_DELAY_MS = 2_000;

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

function isBranchChangeCommand(command: string): boolean {
  return GIT_BRANCH_CHANGE_COMMAND_PATTERN.test(command) || GH_BRANCH_CHANGE_COMMAND_PATTERN.test(command);
}

function isPullRequestStateCommand(command: string): boolean {
  return GH_PR_STATE_COMMAND_PATTERN.test(command);
}

function createHyperlink(url: string, text: string): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

function isNoPullRequestError(stderr: string): boolean {
  return stderr.toLowerCase().includes("no pull requests found for branch");
}

async function loadCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: BRANCH_CHECK_TIMEOUT_MS });
  if (result.killed || result.code !== 0) return undefined;

  const branch = result.stdout.trim();
  return branch || undefined;
}

async function loadPullRequestStatus(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<PullRequestLookupResult> {
  const result = await pi.exec("gh", ["pr", "view", "--json", "number,url,state"], {
    cwd,
    signal,
    timeout: PR_LOOKUP_TIMEOUT_MS,
  });

  if (result.killed) return { kind: "error" };
  if (result.code !== 0) {
    return isNoPullRequestError(result.stderr) ? { kind: "none" } : { kind: "error" };
  }

  const output = result.stdout.trim();
  if (!output) return { kind: "error" };

  try {
    const parsed = JSON.parse(output) as {
      number?: unknown;
      state?: unknown;
      url?: unknown;
    };

    if (parsed.state !== "OPEN" && parsed.state !== "CLOSED" && parsed.state !== "MERGED") return { kind: "error" };
    if (typeof parsed.number !== "number" || !Number.isInteger(parsed.number) || parsed.number <= 0) return { kind: "error" };
    if (typeof parsed.url !== "string") return { kind: "error" };

    const url = parsed.url.trim();
    if (!url) return { kind: "error" };

    return {
      kind: "found",
      pullRequest: {
        number: parsed.number,
        url,
        state: parsed.state,
      },
    };
  } catch {
    return { kind: "error" };
  }
}

function formatPullRequestStatus(ctx: ExtensionContext, status: PullRequestStatus): string {
  const suffix = status.state === "OPEN" ? "" : ` (${status.state.toLowerCase()})`;
  const label = ctx.ui.theme.underline(ctx.ui.theme.fg("dim", `#${status.number}${suffix}`));
  return createHyperlink(status.url, label);
}

export default function gitPrStatusExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let currentBranch: string | undefined;
  let pullRequest: PullRequestStatus | undefined;
  let generation = 0;
  let refreshTimer: NodeJS.Timeout | undefined;
  let branchCheckTimer: NodeJS.Timeout | undefined;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;
  let activeRefreshAbortController: AbortController | undefined;

  function reset(nextCtx?: ExtensionContext): void {
    ctx?.ui.setStatus(STATUS_KEY, undefined);
    ctx = nextCtx;
    currentBranch = undefined;
    pullRequest = undefined;
    generation += 1;

    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (branchCheckTimer) clearTimeout(branchCheckTimer);
    branchCheckTimer = undefined;
    activeRefreshAbortController?.abort();
    activeRefreshAbortController = undefined;
    refreshInFlight = null;
    refreshQueued = false;

    if (!nextCtx?.hasUI) return;

    primeCurrentBranch(nextCtx.cwd, generation);
    scheduleRefresh(0);
  }

  function applyStatus(): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    activeCtx.ui.setStatus(
      STATUS_KEY,
      pullRequest ? formatPullRequestStatus(activeCtx, pullRequest) : undefined,
    );
  }

  function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    if (refreshTimer) clearTimeout(refreshTimer);

    const refreshGeneration = generation;
    const cwd = activeCtx.cwd;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh(cwd, refreshGeneration);
    }, delay);
  }

  async function primeCurrentBranch(cwd: string, branchGeneration: number): Promise<void> {
    const branch = await loadCurrentBranch(pi, cwd);
    if (generation !== branchGeneration) return;
    currentBranch = branch;
  }

  function scheduleBranchCheck(delay = 0): void {
    const activeCtx = ctx;
    if (!activeCtx?.hasUI) return;

    if (branchCheckTimer) clearTimeout(branchCheckTimer);

    const branchGeneration = generation;
    const cwd = activeCtx.cwd;
    branchCheckTimer = setTimeout(() => {
      branchCheckTimer = undefined;
      void checkForBranchChange(cwd, branchGeneration);
    }, delay);
  }

  async function checkForBranchChange(cwd: string, branchGeneration: number): Promise<void> {
    const nextBranch = await loadCurrentBranch(pi, cwd);
    if (generation !== branchGeneration) return;
    if (nextBranch === currentBranch) return;

    currentBranch = nextBranch;
    pullRequest = undefined;
    applyStatus();
    scheduleRefresh(0);
  }

  async function refresh(cwd: string, refreshGeneration: number): Promise<void> {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    const abortController = new AbortController();
    activeRefreshAbortController = abortController;

    const promise = (async () => {
      const result = await loadPullRequestStatus(pi, cwd, abortController.signal);
      if (generation !== refreshGeneration) return;

      if (result.kind === "found") {
        pullRequest = result.pullRequest;
        applyStatus();
        return;
      }

      if (result.kind === "none") {
        pullRequest = undefined;
        applyStatus();
      }
    })();

    refreshInFlight = promise;

    try {
      await promise;
    } catch {
      if (generation !== refreshGeneration || abortController.signal.aborted) return;
    } finally {
      if (activeRefreshAbortController === abortController) {
        activeRefreshAbortController = undefined;
      }
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

  pi.on("user_bash", (event, nextCtx) => {
    ctx = nextCtx;

    if (isBranchChangeCommand(event.command)) {
      scheduleBranchCheck(USER_BASH_SETTLE_DELAY_MS);
      return undefined;
    }

    if (isPullRequestStateCommand(event.command)) {
      scheduleRefresh(USER_BASH_SETTLE_DELAY_MS);
    }

    return undefined;
  });

  pi.on("tool_result", async (event, nextCtx) => {
    ctx = nextCtx;

    if (!isBashToolResult(event)) return;
    if (typeof event.input.command !== "string") return;

    if (isBranchChangeCommand(event.input.command)) {
      scheduleBranchCheck(0);
      return;
    }

    if (isPullRequestStateCommand(event.input.command)) {
      scheduleRefresh(0);
    }
  });

  pi.on("turn_end", async (_event, nextCtx) => {
    ctx = nextCtx;
    scheduleBranchCheck(0);
  });

  pi.on("session_shutdown", async () => {
    reset(undefined);
  });
}
