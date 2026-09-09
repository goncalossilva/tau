import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parsePrReference } from "./request.js";
import { runReviewCommand, type ReviewCommandContext } from "./runner.js";
import { joinAll } from "./runtime.js";
import type { ReviewFingerprint, ReviewTarget } from "./schema.js";

export type ResolvedScope =
  | {
      kind: "working-tree";
      trackedFiles: string[];
      untrackedFiles: string[];
      hasHead: boolean;
      description: string;
    }
  | {
      kind: "branch-diff";
      baseBranch: string;
      mergeBase: string;
      diffFiles: string[];
      description: string;
    }
  | {
      kind: "commit";
      sha: string;
      description: string;
    }
  | {
      kind: "folder";
      paths: string[];
      description: string;
    }
  | {
      kind: "custom";
      instructions: string;
      description: string;
    };

const REVIEW_UNTRACKED_HASH_DISABLED = "__disabled__";

export type GitStatusReporter = (message: string, type?: "info" | "warning" | "error") => void;

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(context: ReviewCommandContext, args: string[]) {
  return runReviewCommand(context, "git", args);
}

export async function isGitRepo(context: ReviewCommandContext): Promise<boolean> {
  const result = await runGit(context, ["rev-parse", "--git-dir"]);
  return result.code === 0;
}

async function getCurrentBranch(context: ReviewCommandContext): Promise<string | null> {
  const { stdout, code } = await runGit(context, ["branch", "--show-current"]);
  if (code !== 0) return null;
  const branch = stdout.trim();
  return branch.length > 0 ? branch : null;
}

async function resolveHeadSha(context: ReviewCommandContext): Promise<string | null> {
  const { code, stdout } = await runGit(context, ["rev-parse", "--verify", "HEAD"]);
  if (code !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

async function hasHeadCommit(context: ReviewCommandContext): Promise<boolean> {
  return (await resolveHeadSha(context)) !== null;
}

async function getDefaultBranch(context: ReviewCommandContext): Promise<string> {
  const remoteHead = await runGit(context, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace(/^origin\//, "");
  }

  const branches = await runGit(context, ["branch", "--format=%(refname:short)"]);
  if (branches.code === 0) {
    const names = parseGitFileList(branches.stdout);
    if (names.includes("main")) return "main";
    if (names.includes("master")) return "master";
    if (names.length > 0) return names[0];
  }

  return "main";
}

async function getMergeBase(context: ReviewCommandContext, branch: string): Promise<string | null> {
  const { stdout, code } = await runGit(context, ["merge-base", "HEAD", branch]);
  if (code !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

function parseGitFileList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getTrackedChangedFiles(
  context: ReviewCommandContext,
  hasHead?: boolean,
): Promise<string[]> {
  const headAvailable = hasHead ?? (await hasHeadCommit(context));
  if (!headAvailable) {
    const [staged, unstaged] = await joinAll([
      runGit(context, ["diff", "--cached", "--name-only"]),
      runGit(context, ["diff", "--name-only"]),
    ]);

    const files = new Set<string>([
      ...(staged.code === 0 ? parseGitFileList(staged.stdout) : []),
      ...(unstaged.code === 0 ? parseGitFileList(unstaged.stdout) : []),
    ]);
    return Array.from(files).sort((a, b) => a.localeCompare(b));
  }

  const { stdout, code } = await runGit(context, ["diff", "HEAD", "--name-only"]);
  if (code !== 0) return [];
  return parseGitFileList(stdout);
}

async function getUntrackedFiles(context: ReviewCommandContext): Promise<string[]> {
  const { stdout, code } = await runGit(context, ["ls-files", "--others", "--exclude-standard"]);
  if (code !== 0) return [];
  return parseGitFileList(stdout);
}

async function getDiffFilesInRange(
  context: ReviewCommandContext,
  range: string,
): Promise<string[]> {
  const { stdout, code } = await runGit(context, ["diff", "--name-only", range]);
  if (code !== 0) return [];
  return parseGitFileList(stdout);
}

async function hasPendingTrackedChanges(context: ReviewCommandContext): Promise<boolean> {
  const { stdout, code } = await runGit(context, ["status", "--porcelain"]);
  if (code !== 0) return false;
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  return lines.some((line) => !line.startsWith("??"));
}

async function getPrInfo(
  context: ReviewCommandContext,
  prNumber: number,
): Promise<{ baseBranch: string; headBranch: string } | null> {
  const { stdout, code } = await runReviewCommand(context, "gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "baseRefName,headRefName",
  ]);
  if (code !== 0) return null;
  try {
    const data = JSON.parse(stdout);
    if (typeof data?.baseRefName === "string" && typeof data?.headRefName === "string") {
      return {
        baseBranch: data.baseRefName,
        headBranch: data.headRefName,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function checkoutPr(
  context: ReviewCommandContext,
  prNumber: number,
): Promise<{ ok: boolean; error?: string }> {
  const fetch = await runGit(context, ["fetch", "origin", `refs/pull/${prNumber}/head`]);
  if (fetch.code !== 0) {
    const error = (fetch.stderr || fetch.stdout || "Failed to fetch PR").trim();
    return { ok: false, error };
  }

  const checkout = await runGit(context, ["switch", "--detach", "FETCH_HEAD"]);
  if (checkout.code !== 0) {
    const error = (checkout.stderr || checkout.stdout || "Failed to checkout PR").trim();
    return { ok: false, error };
  }

  return { ok: true };
}

export async function getPrCheckoutBlockedError(
  context: ReviewCommandContext,
): Promise<string | null> {
  return (await hasPendingTrackedChanges(context))
    ? "Cannot checkout PR with pending tracked changes. Commit or stash first."
    : null;
}

export async function preparePrCheckoutScope(
  context: ReviewCommandContext,
  reportStatus: GitStatusReporter | undefined,
  details: { prNumber: number; baseBranch: string; headBranch: string },
): Promise<
  | { ok: false; error: string }
  | { ok: true; scope: Extract<ResolvedScope, { kind: "branch-diff" }> }
> {
  const blockedError = await getPrCheckoutBlockedError(context);
  if (blockedError) {
    return { ok: false, error: blockedError };
  }

  reportStatus?.(`Checking out PR #${details.prNumber}...`, "info");
  const checkout = await checkoutPr(context, details.prNumber);
  if (!checkout.ok) {
    return {
      ok: false,
      error: `Failed to checkout PR #${details.prNumber}: ${checkout.error ?? "unknown error"}`,
    };
  }
  reportStatus?.(`Checked out PR #${details.prNumber} (${details.headBranch}).`, "info");

  const resolvedScope = await resolveBranchDiffScope(context, {
    baseBranch: details.baseBranch,
    description: (diffFileCount) =>
      `PR #${details.prNumber} diff vs ${details.baseBranch} (${diffFileCount} files)`,
    mergeBaseError: `Could not determine merge-base against PR base branch ${details.baseBranch}.`,
    emptyDiffError: `No differences found for PR #${details.prNumber} against ${details.baseBranch}.`,
  });
  if (!resolvedScope.scope || resolvedScope.scope.kind !== "branch-diff") {
    return {
      ok: false,
      error: resolvedScope.error ?? `Failed to resolve PR #${details.prNumber} scope.`,
    };
  }

  return { ok: true, scope: resolvedScope.scope };
}

export async function loadProjectReviewGuidelines({
  cwd,
  signal,
}: ReviewCommandContext): Promise<string | null> {
  let currentDir = path.resolve(cwd);

  while (true) {
    signal?.throwIfAborted();
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await fs.stat(piDir).catch(() => null);
    if (piStats?.isDirectory()) {
      try {
        const content = await fs.readFile(guidelinesPath, { encoding: "utf8", signal });
        const trimmed = content.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

async function hashGitDiff(context: ReviewCommandContext): Promise<string> {
  const head = await runGit(context, ["diff", "--no-ext-diff", "HEAD"]);
  if (head.code === 0) return hashString(head.stdout);

  const [staged, unstaged] = await joinAll([
    runGit(context, ["diff", "--no-ext-diff", "--cached"]),
    runGit(context, ["diff", "--no-ext-diff"]),
  ]);
  const stagedHash = staged.code === 0 ? hashString(staged.stdout) : null;
  const unstagedHash = unstaged.code === 0 ? hashString(unstaged.stdout) : null;
  if (!stagedHash && !unstagedHash) return hashString("");
  return hashString(`${stagedHash ?? ""}\n${unstagedHash ?? ""}`);
}

async function computeUntrackedContentHash(
  context: ReviewCommandContext,
  precomputedUntrackedFiles?: string[],
): Promise<string> {
  const untrackedFiles = [
    ...(precomputedUntrackedFiles ?? (await getUntrackedFiles(context))),
  ].sort((a, b) => a.localeCompare(b));
  if (untrackedFiles.length === 0) return hashString("");

  const { stdout, code } = await runReviewCommand(
    context,
    "git",
    ["hash-object", "--stdin-paths"],
    untrackedFiles.join("\n"),
  );
  const hashes = code === 0 ? stdout.trim().split("\n") : [];
  const entries = untrackedFiles.map((file, i) => `${file}\0${hashes[i] ?? "missing"}`);
  return hashString(entries.join("\n"));
}

export async function computeCurrentFingerprint(
  context: ReviewCommandContext,
  includeUntracked: boolean,
  precomputedUntrackedFiles?: string[],
): Promise<ReviewFingerprint> {
  const [headSha, branch, trackedDiffHash, untrackedHash] = await joinAll([
    resolveHeadSha(context).then((sha) => sha ?? ""),
    getCurrentBranch(context).then((branch) => branch ?? ""),
    hashGitDiff(context),
    includeUntracked
      ? computeUntrackedContentHash(context, precomputedUntrackedFiles)
      : Promise.resolve(REVIEW_UNTRACKED_HASH_DISABLED),
  ]);

  return { headSha, branch, trackedDiffHash, untrackedHash };
}

export function fingerprintsEqual(a: ReviewFingerprint, b: ReviewFingerprint): boolean {
  return (
    a.headSha === b.headSha &&
    a.branch === b.branch &&
    a.trackedDiffHash === b.trackedDiffHash &&
    a.untrackedHash === b.untrackedHash
  );
}

// --- Scope resolution ---

type BranchDiffScopeOptions = {
  baseBranch: string;
  description: (diffFileCount: number) => string;
  mergeBaseError: string;
  emptyDiffError: string;
};

async function resolveBranchDiffScope(
  context: ReviewCommandContext,
  options: BranchDiffScopeOptions,
): Promise<{ scope?: ResolvedScope; error?: string }> {
  const mergeBase = await getMergeBase(context, options.baseBranch);
  if (!mergeBase) {
    return { error: options.mergeBaseError };
  }

  const range = `${mergeBase}..HEAD`;
  const diffFiles = await getDiffFilesInRange(context, range);
  if (diffFiles.length === 0) {
    return { error: options.emptyDiffError };
  }

  return {
    scope: {
      kind: "branch-diff",
      baseBranch: options.baseBranch,
      mergeBase,
      diffFiles,
      description: options.description(diffFiles.length),
    },
  };
}

export async function resolveScope(
  context: ReviewCommandContext,
  target: ReviewTarget,
  reportStatus?: GitStatusReporter,
): Promise<{ scope?: ResolvedScope; error?: string }> {
  switch (target.type) {
    case "auto":
    case "uncommitted": {
      const [headSha, untrackedFiles] = await joinAll([
        resolveHeadSha(context),
        getUntrackedFiles(context),
      ]);
      const hasHead = headSha !== null;
      const trackedFiles = await getTrackedChangedFiles(context, hasHead);
      if (trackedFiles.length > 0 || untrackedFiles.length > 0) {
        return {
          scope: {
            kind: "working-tree",
            trackedFiles,
            untrackedFiles,
            hasHead,
            description: `working tree (tracked: ${trackedFiles.length}, untracked: ${untrackedFiles.length})`,
          },
        };
      }

      if (target.type === "uncommitted") {
        return { error: "No uncommitted changes to review." };
      }

      const baseBranch = await getDefaultBranch(context);
      return resolveBranchDiffScope(context, {
        baseBranch,
        description: (diffFileCount) => `branch diff vs ${baseBranch} (${diffFileCount} files)`,
        mergeBaseError: `Could not determine merge-base against ${baseBranch}`,
        emptyDiffError: `No reviewable changes found (clean working tree and no branch diff vs ${baseBranch}). Use an explicit mode (branch/commit/pr/folder/custom).`,
      });
    }
    case "branch": {
      return resolveBranchDiffScope(context, {
        baseBranch: target.branch,
        description: (diffFileCount) => `branch diff vs ${target.branch} (${diffFileCount} files)`,
        mergeBaseError: `Could not determine merge-base against ${target.branch}`,
        emptyDiffError: `No differences found against branch ${target.branch}.`,
      });
    }
    case "commit": {
      return {
        scope: {
          kind: "commit",
          sha: target.sha,
          description: `commit ${target.sha}`,
        },
      };
    }
    case "pr": {
      const blockedError = await getPrCheckoutBlockedError(context);
      if (blockedError) {
        return { error: blockedError };
      }

      const prNumber = parsePrReference(target.ref);
      if (!prNumber) {
        return { error: `Invalid PR reference: ${target.ref}` };
      }

      reportStatus?.(`Fetching PR #${prNumber} information...`, "info");
      const prInfo = await getPrInfo(context, prNumber);
      if (!prInfo) {
        return {
          error: `Could not load PR #${prNumber}. Ensure gh is authenticated and PR exists.`,
        };
      }

      const preparedPrScope = await preparePrCheckoutScope(context, reportStatus, {
        prNumber,
        baseBranch: prInfo.baseBranch,
        headBranch: prInfo.headBranch,
      });
      if (!preparedPrScope.ok) {
        return { error: preparedPrScope.error };
      }

      return { scope: preparedPrScope.scope };
    }
    case "folder": {
      if (target.paths.length === 0) return { error: "No folder/file paths provided." };
      return {
        scope: {
          kind: "folder",
          paths: target.paths,
          description: `snapshot review for ${target.paths.join(", ")}`,
        },
      };
    }
    case "custom": {
      if (!target.instructions.trim()) return { error: "Custom instructions are empty." };
      return {
        scope: {
          kind: "custom",
          instructions: target.instructions.trim(),
          description: "custom review instructions",
        },
      };
    }
  }
}

export function buildScopeInstructions(scope: ResolvedScope): string {
  switch (scope.kind) {
    case "working-tree": {
      const trackedCommand = scope.hasHead
        ? "`git diff HEAD`"
        : "`git diff --cached` and `git diff`";
      const tracked =
        scope.trackedFiles.length > 0
          ? `- First capture the full tracked diff with: ${trackedCommand} (treat this diff as mandatory review context).\n- Tracked files (${scope.trackedFiles.length}):\n${scope.trackedFiles.map((f) => `  - ${f}`).join("\n")}`
          : "- There are no tracked-file diffs.";
      const untracked =
        scope.untrackedFiles.length > 0
          ? `- Also review untracked files as snapshots by reading them directly.\n- Untracked files (${scope.untrackedFiles.length}):\n${scope.untrackedFiles.map((f) => `  - ${f}`).join("\n")}`
          : "- There are no untracked files.";
      return `Scope: working tree review.\n${tracked}\n${untracked}`;
    }
    case "branch-diff": {
      return `Scope: branch diff review against base branch ${scope.baseBranch}.\n- Merge base: ${scope.mergeBase}\n- First capture the full diff with: \`git diff ${scope.mergeBase}..HEAD\` (treat this diff as mandatory review context).\n- Files in diff (${scope.diffFiles.length}):\n${scope.diffFiles.map((f) => `  - ${f}`).join("\n")}`;
    }
    case "commit": {
      return `Scope: commit review for ${scope.sha}.\n- First capture the full commit patch with: \`git show --stat --patch ${scope.sha}\` (treat this patch as mandatory review context).\n- Focus only on changes introduced by this commit.`;
    }
    case "folder": {
      return `Scope: snapshot review of selected paths (not a diff).\n- Paths:\n${scope.paths
        .map((p) => `  - ${p}`)
        .join("\n")}\n- Read files directly from these paths and review what exists currently.`;
    }
    case "custom": {
      return `Scope: custom review instructions.\n- Additional user instruction: ${scope.instructions}`;
    }
  }
}
