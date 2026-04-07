/**
 * Worktree Extension
 *
 * Commands:
 *  - /worktree new <branch> [--from <ref>]
 *      Creates a new worktree at ../<project>-<branch-normalized> and prints manual open instructions.
 *
 *  - /worktree switch <branch> [--from <ref>]
 *      Switches in-place to an existing worktree, or creates it first when missing.
 *
 *  - /worktree archive <branch>
 *      Removes the worktree for <branch> and deletes the local branch if it's pushed (has upstream).
 *
 *  - /worktree clean
 *      Archives all worktrees whose checked out branch has an upstream.
 *
 *  - /worktree list
 *      Lists worktrees and their status.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import {
  CURRENT_SESSION_VERSION,
  DynamicBorder,
  SessionManager,
  highlightCode,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import {
  Box,
  Container,
  type SelectItem,
  SelectList,
  Text,
  matchesKey,
} from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const STATUS_KEY = "0-worktree";
const MANUAL_OPEN_MESSAGE_TYPE = "worktree-open-command";
const RESTORE_STASH_MESSAGE_TYPE = "worktree-restore-command";
const SCRIPT_RERUN_MESSAGE_TYPE = "worktree-script-rerun-command";
const MANUAL_OPEN_INTRO =
  "Worktree ready. Open it in a separate terminal or tmux pane with this command";

type PromptStatus = "completed" | "error";

async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
  pi.events.emit("ui:prompt_start", { source: "worktree" });

  let status: PromptStatus = "completed";
  try {
    return await run();
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    pi.events.emit("ui:prompt_end", { source: "worktree", status });
  }
}

const FETCH_TIMEOUT_MS = 60_000;
const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// fs.copyFileSync mode: attempt COW (reflink/clonefile) then fall back to regular
// copy, and fail if the destination already exists (skip-on-exist for idempotency).
const COPYFILE_COW_EXCL = fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL;

type Subcommand = "new" | "switch" | "archive" | "clean" | "list";

type DirtyAction = "skip" | "stash" | "force" | "prompt";

type DirtyState = "clean" | "dirty" | "unknown";

interface WorktreeInfo {
  path: string;
  head?: string;
  branchRef?: string;
  detached?: boolean;
  locked?: boolean;
  lockedReason?: string;
}

interface RepoInfo {
  /** Root of the main/original worktree (parent of the common .git dir) */
  mainRoot: string;
  /** Root of the current worktree */
  currentRoot: string;
  /** Directory name of mainRoot (used for naming worktrees) */
  projectName: string;
  /** Parent directory where worktrees will be created */
  parentDir: string;
}

interface ArchiveOutcome {
  branch: string;
  worktreePath: string;
  removed: boolean;
  branchDeleted: boolean;
  skippedReason?: string;
}

interface SwitchMainResult {
  proceed: boolean;
  switched: boolean;
  stashSpec?: string;
}

interface SetupAction {
  label: string;
  command: string;
  source: string;
}

type CommandMessageDetails = {
  intro: string;
  command: string;
  copiedToClipboard: boolean;
};

function tokenizeArgs(args: string): string[] {
  const trimmed = args.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/g).filter(Boolean);
}

function normalizeBranchForPath(branch: string): string {
  return (
    branch
      .trim()
      .replace(/^refs\/heads\//, "")
      .toLowerCase()
      // Only allow lowercase letters, numbers and dashes in the final path segment.
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
  );
}

function stripRefsHeadsPrefix(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, "");
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/(["\\$`!])/g, "\\$1");
}

function shellQuoteCompact(value: string): string {
  const home = process.env.HOME;
  if (!home) return shellQuote(value);

  if (value === home) return "$HOME";

  if (value.startsWith(`${home}/`)) {
    const suffix = value.slice(home.length + 1);
    return `"$HOME/${escapeForDoubleQuotes(suffix)}"`;
  }

  return shellQuote(value);
}

function runClipboardCommand(command: string, args: string[], text: string): boolean {
  try {
    const result = spawnSync(command, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function copyToClipboard(text: string): boolean {
  if (process.platform === "darwin") {
    return runClipboardCommand("pbcopy", [], text);
  }

  if (process.platform === "win32") {
    return runClipboardCommand("clip", [], text);
  }

  if (process.platform === "linux") {
    return (
      runClipboardCommand("wl-copy", [], text) ||
      runClipboardCommand("xclip", ["-selection", "clipboard"], text) ||
      runClipboardCommand("xsel", ["--clipboard", "--input"], text)
    );
  }

  return false;
}

function formatCommandMessageIntro(intro: string, copiedToClipboard: boolean): string {
  return `${intro}${copiedToClipboard ? " (copied to clipboard)" : ""}:`;
}

function buildManualOpenCommand(targetPath: string): string {
  return `cd ${shellQuoteCompact(targetPath)} && pi`;
}

function showCommandMessage(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  customType: string,
  intro: string,
  command: string,
): void {
  const copiedToClipboard = copyToClipboard(command);
  if (!ctx.hasUI) {
    console.log(formatCommandMessageIntro(intro, copiedToClipboard));
    console.log(command);
    return;
  }

  pi.sendMessage({
    customType,
    content: intro,
    display: true,
    details: {
      intro,
      command,
      copiedToClipboard,
    } satisfies CommandMessageDetails,
  });
}

function showManualOpenCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
): void {
  showCommandMessage(pi, ctx, MANUAL_OPEN_MESSAGE_TYPE, MANUAL_OPEN_INTRO, command);
}

function showRestoreStashCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetPath: string,
  stashSpec: string,
): void {
  showCommandMessage(
    pi,
    ctx,
    RESTORE_STASH_MESSAGE_TYPE,
    `Main-worktree changes were stashed as ${stashSpec}. Restore them in the new worktree with this command`,
    `cd ${shellQuoteCompact(targetPath)} && git stash apply ${shellQuote(stashSpec)}`,
  );
}

function showScriptRerunCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  label: string,
  exitCode: number,
  worktreeRoot: string,
  command: string,
): void {
  showCommandMessage(
    pi,
    ctx,
    SCRIPT_RERUN_MESSAGE_TYPE,
    `${label} failed (exit ${exitCode}). Re-run it manually with this command`,
    `cd ${shellQuoteCompact(worktreeRoot)} && ${command}`,
  );
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isSameOrInsidePath(childPath: string, parentPath: string): boolean {
  const rel = path.relative(realpathOrResolve(parentPath), realpathOrResolve(childPath));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function describePhaseScript(phase: "setup" | "archive", label: string): string {
  const suffix = ` ${phase}`;
  if (label.toLowerCase().endsWith(suffix)) {
    const source = label.slice(0, -suffix.length).trim();
    if (source.length > 0) {
      return `${phase} for ${source}`;
    }
  }
  return label;
}

function formatRunningScriptStatusText(phase: "setup" | "archive", label: string): string {
  return `running ${describePhaseScript(phase, label)}`;
}

function formatFinishedScriptNotificationText(phase: "setup" | "archive", label: string): string {
  return `Finished ${describePhaseScript(phase, label)}`;
}

async function withSpinnerStatus<T>(
  ctx: ExtensionCommandContext,
  initialText: string,
  fn: (setStatusText: (text: string) => void) => Promise<T>,
): Promise<T> {
  if (!ctx.hasUI) return fn(() => {});

  let frame = 0;
  let text = initialText;
  const render = () => {
    ctx.ui.setStatus(STATUS_KEY, `${STATUS_SPINNER_FRAMES[frame]} ${text}`);
  };
  const setStatusText = (nextText: string) => {
    text = nextText;
    render();
  };

  render();
  const timer = setInterval(() => {
    frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
    render();
  }, STATUS_SPINNER_INTERVAL_MS);

  try {
    return await fn(setStatusText);
  } finally {
    clearInterval(timer);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) {
  return pi.exec("git", args, { cwd, ...options });
}

async function mustGitStdout(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  errorPrefix: string,
): Promise<string> {
  const result = await git(pi, cwd, args);
  if (result.code !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${errorPrefix}${details ? `\n${details}` : ""}`);
  }
  return result.stdout;
}

async function getRepoInfo(pi: ExtensionAPI, cwd: string): Promise<RepoInfo> {
  const currentRoot = (
    await mustGitStdout(
      pi,
      cwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      "Not a git repository",
    )
  ).trim();

  const commonDir = (
    await mustGitStdout(
      pi,
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      "Not a git repository",
    )
  ).trim();

  const mainRoot = path.dirname(commonDir);
  const projectName = path.basename(mainRoot);
  const parentDir = path.dirname(mainRoot);

  return { mainRoot, currentRoot, projectName, parentDir };
}

function parseWorktreeListPorcelain(stdout: string): WorktreeInfo[] {
  const lines = stdout.split("\n");
  const worktrees: WorktreeInfo[] = [];

  let current: Partial<WorktreeInfo> | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim() === "") {
      if (current?.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current?.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
      continue;
    }

    if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length).trim();
      continue;
    }

    if (line === "detached") {
      current.detached = true;
      continue;
    }

    if (line === "locked") {
      current.locked = true;
      continue;
    }

    if (line.startsWith("locked ")) {
      current.locked = true;
      current.lockedReason = line.slice("locked ".length).trim();
      continue;
    }
  }

  if (current?.path) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
}

async function pruneWorktrees(pi: ExtensionAPI, repoRoot: string): Promise<void> {
  // Best-effort: remove stale worktree entries.
  // Locked worktrees are not pruned.
  await git(pi, repoRoot, ["worktree", "prune"]);
}

async function listWorktrees(pi: ExtensionAPI, repoRoot: string): Promise<WorktreeInfo[]> {
  const stdout = await mustGitStdout(
    pi,
    repoRoot,
    ["worktree", "list", "--porcelain"],
    "Failed to list worktrees",
  );
  return parseWorktreeListPorcelain(stdout);
}

function branchNameFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

async function isDirty(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const result = await git(pi, cwd, ["status", "--porcelain"]);
  if (result.code !== 0) return false;
  return result.stdout.trim().length > 0;
}

async function getDirtyState(pi: ExtensionAPI, cwd: string): Promise<DirtyState> {
  const result = await git(pi, cwd, ["status", "--porcelain"]);
  if (result.code !== 0) return "unknown";
  return result.stdout.trim().length > 0 ? "dirty" : "clean";
}

async function stashAll(pi: ExtensionAPI, cwd: string, message: string): Promise<void> {
  const result = await git(pi, cwd, ["stash", "push", "-u", "-m", message]);
  if (result.code !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`Failed to stash changes${details ? `\n${details}` : ""}`);
  }
}

async function getLatestStashRevision(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await git(pi, cwd, ["rev-parse", "--verify", "--quiet", "stash@{0}"]);
  if (result.code !== 0) return undefined;
  const revision = result.stdout.trim();
  return revision.length > 0 ? revision : undefined;
}

async function localBranchExists(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await git(pi, repoRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.code === 0;
}

async function getUpstream(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
): Promise<string | null> {
  const result = await git(pi, repoRoot, [
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  ]);
  if (result.code !== 0) return null;
  const upstream = result.stdout.trim();
  return upstream.length > 0 ? upstream : null;
}

async function getAheadBehind(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  upstream: string,
): Promise<{ ahead: number; behind: number } | null> {
  const result = await git(pi, repoRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `${branch}...${upstream}`,
  ]);
  if (result.code !== 0) return null;

  const parts = result.stdout.trim().split(/\s+/g);
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);

  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

async function getDefaultMainBranch(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const remoteHead = await git(pi, repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead.code === 0) {
    const full = remoteHead.stdout.trim();
    if (full.startsWith("origin/")) {
      const candidate = full.slice("origin/".length);
      if (await localBranchExists(pi, repoRoot, candidate)) return candidate;
      return candidate;
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (await localBranchExists(pi, repoRoot, candidate)) return candidate;
  }

  return "main";
}

function defaultWorktreePath(repo: RepoInfo, branch: string): string | null {
  const normalized = normalizeBranchForPath(branch);
  if (!normalized) return null;
  return path.join(repo.parentDir, `${repo.projectName}-${normalized}`);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

type WorktreePathState = "ok" | "missing" | "invalid-path" | "inaccessible";

function getWorktreePathState(p: string): WorktreePathState {
  try {
    const stat = fs.statSync(p);
    return stat.isDirectory() ? "ok" : "invalid-path";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "inaccessible";
    return "inaccessible";
  }
}

function worktreeAtPath(
  worktrees: WorktreeInfo[],
  candidatePath: string,
): WorktreeInfo | undefined {
  const resolved = realpathOrResolve(candidatePath);
  return worktrees.find((w) => realpathOrResolve(w.path) === resolved);
}

function pathExistsAndIsNotEmptyDir(p: string): boolean {
  if (!fs.existsSync(p)) return false;
  if (!isDirectory(p)) return true;

  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return true;
  }
}

async function resolveWorktreePath(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: RepoInfo,
  worktrees: WorktreeInfo[],
  branch: string,
): Promise<string | null> {
  const defaultCandidate = defaultWorktreePath(repo, branch);
  let candidate: string;

  if (!defaultCandidate) {
    if (!ctx.hasUI) {
      throw new Error(`Branch name cannot be normalized to a directory name: ${branch}`);
    }

    const suggested = path.join(repo.parentDir, `${repo.projectName}-worktree`);
    ctx.ui.notify(
      `Branch name "${branch}" normalizes to an empty directory name. Please choose a worktree directory.`,
      "warning",
    );
    const input = await withPromptSignal(pi, () =>
      ctx.ui.input("Enter worktree directory", suggested),
    );
    if (!input) return null;
    candidate = path.isAbsolute(input) ? input : path.resolve(repo.currentRoot, input);
  } else {
    candidate = defaultCandidate;
  }

  while (true) {
    const existingWt = worktreeAtPath(worktrees, candidate);
    const nonEmpty = pathExistsAndIsNotEmptyDir(candidate);

    if (!existingWt && !nonEmpty) return candidate;

    const reason = existingWt
      ? `Path is already used by an existing worktree (${existingWt.branchRef ? branchNameFromRef(existingWt.branchRef) : "detached"})`
      : "Path already exists and is not empty";

    if (!ctx.hasUI) {
      throw new Error(`${reason}: ${candidate}`);
    }

    ctx.ui.notify(`${reason}: ${candidate}`, "warning");
    const input = await withPromptSignal(pi, () =>
      ctx.ui.input("Enter a different worktree directory", candidate),
    );
    if (!input) return null;

    candidate = path.isAbsolute(input) ? input : path.resolve(repo.currentRoot, input);
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coerce a config value (string or string[]) into a single shell command, or null. */
function asCommand(value: unknown): string | null {
  if (typeof value === "string") return asNonEmptyString(value);
  if (Array.isArray(value)) {
    const parts = value.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
    return parts.length > 0 ? parts.join(" && ") : null;
  }
  return null;
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inferSetupActions(worktreeRoot: string): SetupAction[] {
  const actions: SetupAction[] = [];

  // Conductor: conductor.json → scripts.setup
  // https://docs.conductor.build/core/conductor-json
  const conductorConfigPath = path.join(worktreeRoot, "conductor.json");
  const conductorConfig = readJsonFile(conductorConfigPath) as any;
  const conductorSetup = asNonEmptyString(conductorConfig?.scripts?.setup);
  if (conductorSetup) {
    actions.push({ label: "Conductor setup", command: conductorSetup, source: "conductor.json" });
  }

  // 1Code: .1code/worktree.json → setup-worktree (or setup-worktree-unix / setup-worktree-windows)
  // Values can be a string or string[]. Generic key takes priority, then platform-specific.
  // https://github.com/21st-dev/1code → src/main/lib/git/worktree-config.ts
  const oneCodeConfigPath = path.join(worktreeRoot, ".1code", "worktree.json");
  const oneCodeConfig = readJsonFile(oneCodeConfigPath) as any;
  if (oneCodeConfig) {
    const platformKey =
      process.platform === "win32" ? "setup-worktree-windows" : "setup-worktree-unix";
    const oneCodeSetup =
      asCommand(oneCodeConfig["setup-worktree"]) ?? asCommand(oneCodeConfig[platformKey]);
    if (oneCodeSetup) {
      actions.push({ label: "1Code setup", command: oneCodeSetup, source: ".1code/worktree.json" });
    }
  }

  // Cursor: .cursor/worktrees.json → same schema as 1Code
  // https://cursor.com/docs/configuration/worktrees
  const cursorConfigPath = path.join(worktreeRoot, ".cursor", "worktrees.json");
  const cursorConfig = readJsonFile(cursorConfigPath) as any;
  if (cursorConfig) {
    const platformKey =
      process.platform === "win32" ? "setup-worktree-windows" : "setup-worktree-unix";
    const cursorSetup =
      asCommand(cursorConfig["setup-worktree"]) ?? asCommand(cursorConfig[platformKey]);
    if (cursorSetup) {
      actions.push({
        label: "Cursor setup",
        command: cursorSetup,
        source: ".cursor/worktrees.json",
      });
    }
  }

  // Superset: .superset/config.json → setup (string[])
  const supersetConfigPath = path.join(worktreeRoot, ".superset", "config.json");
  const supersetConfig = readJsonFile(supersetConfigPath) as any;
  const supersetSetup = asCommand(supersetConfig?.setup);
  if (supersetSetup) {
    actions.push({
      label: "Superset setup",
      command: supersetSetup,
      source: ".superset/config.json",
    });
  }

  // CCPM: .claude/scripts/{bootstrap,setup,init}.sh
  // https://github.com/elysenko/ccpm
  const ccpmDir = path.join(worktreeRoot, ".claude", "scripts");
  if (fs.existsSync(ccpmDir) && isDirectory(ccpmDir)) {
    for (const script of ["bootstrap.sh", "setup.sh", "init.sh"]) {
      if (isFile(path.join(ccpmDir, script))) {
        const relScript = `./.claude/scripts/${script}`;
        actions.push({
          label: `CCPM: .claude/scripts/${script}`,
          command: `bash ${shellQuote(relScript)}`,
          source: `.claude/scripts/${script}`,
        });
      }
    }
  }

  return actions;
}

function inferArchiveActions(worktreeRoot: string): SetupAction[] {
  const actions: SetupAction[] = [];

  // Conductor: conductor.json → scripts.archive
  // https://docs.conductor.build/core/conductor-json
  const conductorConfigPath = path.join(worktreeRoot, "conductor.json");
  const conductorConfig = readJsonFile(conductorConfigPath) as any;
  const conductorArchive = asNonEmptyString(conductorConfig?.scripts?.archive);
  if (conductorArchive) {
    actions.push({
      label: "Conductor archive",
      command: conductorArchive,
      source: "conductor.json",
    });
  }

  // Superset: .superset/config.json → teardown (string[])
  const supersetConfigPath = path.join(worktreeRoot, ".superset", "config.json");
  const supersetConfig = readJsonFile(supersetConfigPath) as any;
  const supersetTeardown = asCommand(supersetConfig?.teardown);
  if (supersetTeardown) {
    actions.push({
      label: "Superset teardown",
      command: supersetTeardown,
      source: ".superset/config.json",
    });
  }

  return actions;
}

/**
 * Parse a .worktreeinclude file into glob patterns suitable for path.matchesGlob().
 *
 * .worktreeinclude uses gitignore syntax. We implement a practical subset:
 * - Blank lines and # comments are skipped
 * - ! prefix negates a pattern
 * - Trailing / marks directory-only patterns
 * - Leading / anchors to the worktree root
 * - Patterns without internal / match at any depth (prepend **​/)
 *
 * Full gitignore supports character classes ([a-z]), escaped characters, etc.
 * This simplified parser covers the patterns seen in practice (.worktreeinclude
 * files typically list build artifact directories like target/, node_modules/).
 * Using path.matchesGlob() (built into Node 22) avoids external dependencies.
 */
function parseWorktreeIncludePatterns(content: string): Array<{ glob: string; negate: boolean }> {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((pattern) => {
      const negate = pattern.startsWith("!");
      const raw = negate ? pattern.slice(1) : pattern;

      let glob: string;
      if (raw.startsWith("/")) {
        // Leading / anchors to root — strip it (paths from ls-files are already root-relative)
        glob = raw.slice(1);
      } else {
        // If no internal / (ignoring trailing /), match at any depth per gitignore spec
        const withoutTrailing = raw.endsWith("/") ? raw.slice(0, -1) : raw;
        if (!withoutTrailing.includes("/")) {
          glob = `**/${raw}`;
        } else {
          glob = raw;
        }
      }
      return { glob, negate };
    });
}

function matchesWorktreeInclude(
  entry: string,
  patterns: Array<{ glob: string; negate: boolean }>,
): boolean {
  // Normalize trailing slashes: git ls-files --directory appends / to directories,
  // and patterns may or may not have trailing /. Strip both for matching since
  // --directory already ensures we only get directory entries for directory patterns.
  const normalizedEntry = entry.replace(/\/$/, "");
  let matched = false;
  for (const { glob, negate } of patterns) {
    const normalizedGlob = glob.replace(/\/$/, "");
    if (path.matchesGlob(normalizedEntry, normalizedGlob)) {
      matched = !negate;
    }
  }
  return matched;
}

/**
 * Recursively copy a directory using per-file COW (reflink/clonefile) where the
 * filesystem supports it, falling back to regular copy otherwise. Existing files
 * are silently skipped for idempotent re-runs.
 *
 * This matches worktrunk's copy_dir_recursive: per-file reflink spreads I/O
 * operations over time rather than issuing them in a single burst (macOS
 * clonefile on large directories can saturate disk I/O and block interactive
 * processes). Symlinks are preserved (re-created, not followed).
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(srcPath);
        fs.symlinkSync(target, destPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    } else if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath, COPYFILE_COW_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
}

async function applyWorktreeInclude(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sourceRoot: string,
  destRoot: string,
  worktrees: WorktreeInfo[],
): Promise<void> {
  if (!ctx.hasUI) return;

  const includeFile = path.join(sourceRoot, ".worktreeinclude");
  if (!isFile(includeFile)) return;

  let content: string;
  try {
    content = fs.readFileSync(includeFile, "utf8");
  } catch {
    return;
  }

  const patterns = parseWorktreeIncludePatterns(content);
  if (patterns.length === 0) return;

  // List gitignored entries in the source worktree.
  // --directory stops at directory boundaries (avoids listing thousands of files in target/).
  const lsResult = await git(pi, sourceRoot, [
    "ls-files",
    "--ignored",
    "--exclude-standard",
    "-o",
    "--directory",
    "--no-empty-directory",
  ]);
  if (lsResult.code !== 0) return;

  const ignoredEntries = lsResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Filter to entries matching .worktreeinclude patterns.
  let entriesToCopy = ignoredEntries.filter((entry) => matchesWorktreeInclude(entry, patterns));

  // Exclude entries that contain other worktrees (prevents recursive copying when
  // worktrees are nested inside the source, e.g., worktree-path = ".worktrees/...").
  const worktreePaths = worktrees.map((wt) => realpathOrResolve(wt.path));
  const sourceRealpath = realpathOrResolve(sourceRoot);
  entriesToCopy = entriesToCopy.filter((entry) => {
    const entryAbs = realpathOrResolve(path.join(sourceRoot, entry.replace(/\/$/, "")));
    return !worktreePaths.some(
      (wtPath) => wtPath !== sourceRealpath && isSameOrInsidePath(wtPath, entryAbs),
    );
  });

  if (entriesToCopy.length === 0) return;

  const listing = entriesToCopy.map((e) => `  ${e}`).join("\n");
  const ok = await withPromptSignal(pi, () =>
    ctx.ui.confirm(
      "Copy cached files from main worktree?",
      `Found .worktreeinclude. Copy these gitignored entries:\n\n${listing}`,
    ),
  );
  if (!ok) return;

  await withSpinnerStatus(ctx, "copying cached files", async () => {
    for (const entry of entriesToCopy) {
      const src = path.join(sourceRoot, entry.replace(/\/$/, ""));
      const dest = path.join(destRoot, entry.replace(/\/$/, ""));

      // Validate paths stay within their respective roots (defense against
      // crafted .gitignore + .worktreeinclude producing ../ components).
      if (!isSameOrInsidePath(src, sourceRoot) || !isSameOrInsidePath(dest, destRoot)) continue;

      if (!fs.existsSync(src)) continue;

      try {
        const srcStat = fs.lstatSync(src);
        if (srcStat.isDirectory()) {
          copyDirRecursive(src, dest);
        } else if (srcStat.isSymbolicLink()) {
          const target = fs.readlinkSync(src);
          const destParent = path.dirname(dest);
          if (!fs.existsSync(destParent)) {
            fs.mkdirSync(destParent, { recursive: true });
          }
          try {
            fs.symlinkSync(target, dest);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          }
        } else {
          const destParent = path.dirname(dest);
          if (!fs.existsSync(destParent)) {
            fs.mkdirSync(destParent, { recursive: true });
          }
          try {
            fs.copyFileSync(src, dest, COPYFILE_COW_EXCL);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to copy ${entry}: ${message}`, "warning");
      }
    }
  });

  ctx.ui.notify("Cached files copied", "info");
}

async function runProjectScripts(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  worktreeRoot: string,
  phase: "setup" | "archive",
  actions: SetupAction[],
): Promise<void> {
  if (!ctx.hasUI || actions.length === 0) return;

  let chosen: SetupAction | undefined;

  if (actions.length === 1) {
    const action = actions[0];
    const ok = await withPromptSignal(pi, () =>
      ctx.ui.confirm(`Run worktree ${phase}?`, `${action.label}\n\nCommand:\n${action.command}`),
    );
    if (!ok) return;
    chosen = action;
  } else {
    const options = ["Skip", ...actions.map((a) => `${a.label} (${a.source})`)];
    const choice = await withPromptSignal(pi, () =>
      ctx.ui.select(`Choose ${phase} script to run`, options),
    );
    if (!choice || choice === "Skip") return;

    const idx = options.indexOf(choice) - 1;
    const selectedAction = actions[idx];
    if (!selectedAction) return;

    const ok = await withPromptSignal(pi, () =>
      ctx.ui.confirm(
        `Run worktree ${phase}?`,
        `${selectedAction.label}\n\nCommand:\n${selectedAction.command}`,
      ),
    );
    if (!ok) return;

    chosen = selectedAction;
  }

  if (!chosen) return;

  const label = phase[0].toUpperCase() + phase.slice(1);
  const statusText = formatRunningScriptStatusText(phase, chosen.label);

  await withSpinnerStatus(ctx, statusText, async () => {
    const result = await pi.exec("bash", ["-c", chosen.command], { cwd: worktreeRoot });
    if (result.code !== 0) {
      showScriptRerunCommand(pi, ctx, label, result.code, worktreeRoot, chosen.command);
      throw new Error(`${label} failed (exit ${result.code}).`);
    }
  });

  ctx.ui.notify(formatFinishedScriptNotificationText(phase, chosen.label), "info");
}

async function ensureCanPrompt(ctx: ExtensionCommandContext, message: string): Promise<boolean> {
  if (ctx.hasUI) return true;
  // No UI - can't safely proceed with anything requiring confirmation
  // (still return false so callers can abort gracefully)
  console.error(message);
  return false;
}

async function getHeadBranch(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const result = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.code !== 0) return null;
  const name = result.stdout.trim();
  if (!name || name === "HEAD") return null;
  return name;
}

function worktreeForBranch(worktrees: WorktreeInfo[], branch: string): WorktreeInfo | undefined {
  return worktrees.find((w) => w.branchRef === `refs/heads/${branch}`);
}

type ParsedWorktreeTargetArgs = {
  branch: string;
  fromRef?: string;
};

async function parseWorktreeTargetArgs(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  usage: string,
): Promise<ParsedWorktreeTargetArgs | null> {
  const tokens = tokenizeArgs(args);
  let branch = tokens[0];
  if (!branch || branch.startsWith("-")) {
    if (!ctx.hasUI) {
      throw new Error(usage);
    }
    const input = await withPromptSignal(pi, () => ctx.ui.input("Branch name"));
    if (!input) return null;
    branch = input.trim();
  }

  branch = stripRefsHeadsPrefix(branch);
  if (!branch || branch.startsWith("-")) {
    if (ctx.hasUI) ctx.ui.notify("Invalid branch name", "warning");
    else throw new Error("Invalid branch name");
    return null;
  }

  let fromRef: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--from") {
      const next = tokens[i + 1];
      if (!next) {
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        else throw new Error(usage);
        return null;
      }
      fromRef = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--from=")) {
      const value = token.slice("--from=".length).trim();
      if (!value) {
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        else throw new Error(usage);
        return null;
      }
      fromRef = value;
      continue;
    }

    if (ctx.hasUI) ctx.ui.notify(usage, "warning");
    else throw new Error(usage);
    return null;
  }

  return { branch, fromRef };
}

async function maybeSwitchMainToDefaultBranch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: RepoInfo,
  defaultBranch: string,
  reason: string,
): Promise<SwitchMainResult> {
  const current = await getHeadBranch(pi, repo.mainRoot);
  if (!current || current === defaultBranch) {
    return { proceed: true, switched: false };
  }

  if (!ctx.hasUI) {
    throw new Error(
      `Cannot proceed without UI: need to checkout ${defaultBranch} in main worktree to ${reason}.`,
    );
  }

  const ok = await withPromptSignal(pi, () =>
    ctx.ui.confirm(
      "Switch main worktree?",
      `Main worktree is on ${current}. Checkout ${defaultBranch} to ${reason}?`,
    ),
  );
  if (!ok) return { proceed: false, switched: false };

  let stashSpec: string | undefined;
  if (await isDirty(pi, repo.mainRoot)) {
    const choice = await withPromptSignal(pi, () =>
      ctx.ui.select("Main worktree has uncommitted changes", [
        "Stash changes (including untracked) and continue",
        "Cancel",
      ]),
    );
    if (!choice || choice.startsWith("Cancel")) {
      return { proceed: false, switched: false };
    }

    await stashAll(
      pi,
      repo.mainRoot,
      `worktree: stash before switching main worktree to ${defaultBranch}`,
    );
    stashSpec = (await getLatestStashRevision(pi, repo.mainRoot)) ?? "stash@{0}";
  }

  const checkout = await git(pi, repo.mainRoot, ["checkout", defaultBranch]);
  if (checkout.code !== 0) {
    const details = [checkout.stdout.trim(), checkout.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `Failed to checkout ${defaultBranch} in main worktree${details ? `\n${details}` : ""}`,
    );
  }

  return {
    proceed: true,
    switched: true,
    stashSpec,
  };
}

async function createWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: RepoInfo,
  worktrees: WorktreeInfo[],
  branch: string,
  fromRef?: string,
): Promise<string | null> {
  const targetPath = await resolveWorktreePath(pi, ctx, repo, worktrees, branch);
  if (!targetPath) return null;

  const branchExists = await localBranchExists(pi, repo.mainRoot, branch);
  if (branchExists && fromRef) {
    if (ctx.hasUI) {
      const ok = await withPromptSignal(pi, () =>
        ctx.ui.confirm(
          "Branch exists",
          `Branch ${branch} already exists.\n\nContinuing will use the existing branch at its current state; --from (${fromRef}) will have no effect.\n\nContinue?`,
        ),
      );
      if (!ok) return null;
    } else {
      console.error(`Branch ${branch} already exists. Ignoring --from ${fromRef}.`);
    }
  }

  let addArgs: string[];
  if (branchExists) {
    addArgs = ["worktree", "add", targetPath, branch];
  } else {
    const baseCommit = (
      await mustGitStdout(
        pi,
        repo.currentRoot,
        ["rev-parse", fromRef ?? "HEAD"],
        `Failed to resolve base ref: ${fromRef ?? "HEAD"}`,
      )
    ).trim();
    addArgs = ["worktree", "add", "-b", branch, targetPath, baseCommit];
  }

  const add = await git(pi, repo.mainRoot, addArgs);
  if (add.code !== 0) {
    const details = [add.stdout.trim(), add.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`Failed to create worktree${details ? `\n${details}` : ""}`);
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Worktree created: ${targetPath}`, "info");
  }

  const currentWorktrees = await listWorktrees(pi, repo.mainRoot);
  await applyWorktreeInclude(pi, ctx, repo.mainRoot, targetPath, currentWorktrees);
  await runProjectScripts(pi, ctx, targetPath, "setup", inferSetupActions(targetPath));

  return targetPath;
}

function hasValidSessionFile(sessionFile: string): boolean {
  if (!fs.existsSync(sessionFile)) return false;

  try {
    const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0]?.trim();
    if (!firstLine) return false;

    const header = JSON.parse(firstLine) as Partial<SessionHeader>;
    return header.type === "session" && typeof header.id === "string";
  } catch {
    return false;
  }
}

function createFreshSessionFile(targetCwd: string, sessionDir: string): string {
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: targetCwd,
  };

  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  return sessionFile;
}

async function switchToWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetPath: string,
  currentWorktreeRoot?: string,
): Promise<void> {
  const pathState = getWorktreePathState(targetPath);
  if (pathState !== "ok") {
    const message = `Cannot switch to worktree at ${targetPath}: ${pathState}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else throw new Error(message);
    return;
  }

  const currentRoot = currentWorktreeRoot ?? ctx.cwd;
  if (realpathOrResolve(targetPath) === realpathOrResolve(currentRoot)) {
    if (ctx.hasUI) ctx.ui.notify("Already in this worktree", "info");
    return;
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (!currentSessionFile) {
    const manualCommand = buildManualOpenCommand(targetPath);
    const message = "Current session is ephemeral; cannot switch worktrees in-place.";
    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
      showManualOpenCommand(pi, ctx, manualCommand);
    } else {
      showManualOpenCommand(pi, ctx, manualCommand);
      throw new Error(message);
    }
    return;
  }

  const sessionDir = ctx.sessionManager.getSessionDir();
  const hasAssistantReply = ctx.sessionManager
    .getEntries()
    .some((entry) => entry.type === "message" && entry.message.role === "assistant");

  let sessionFile: string;
  if (hasValidSessionFile(currentSessionFile)) {
    const nextSession = SessionManager.forkFrom(currentSessionFile, targetPath, sessionDir);
    const forkedSessionFile = nextSession.getSessionFile();
    if (!forkedSessionFile) {
      throw new Error(`Failed to create a session for worktree: ${targetPath}`);
    }
    sessionFile = forkedSessionFile;
  } else {
    if (hasAssistantReply) {
      throw new Error(`Current session file is missing or invalid: ${currentSessionFile}`);
    }

    const message = "Current session has no persisted history yet. Switching with a fresh session.";
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.log(message);

    sessionFile = createFreshSessionFile(targetPath, sessionDir);
  }

  const result = await ctx.switchSession(sessionFile);
  if (result.cancelled) {
    try {
      fs.rmSync(sessionFile, { force: true });
    } catch {
      // Best effort: avoid leaving behind an unused forked session file.
    }

    if (ctx.hasUI) {
      ctx.ui.notify("Cancelled", "warning");
      return;
    }

    throw new Error("Switch cancelled");
  }
}

async function handleNew(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const parsed = await parseWorktreeTargetArgs(
    pi,
    ctx,
    args,
    "Usage: /worktree new <branch> [--from <ref>]",
  );
  if (!parsed) return;

  const result = await withSpinnerStatus(ctx, `creating worktree: ${parsed.branch}`, async () => {
    const repo = await getRepoInfo(pi, ctx.cwd);
    const defaultMain = await getDefaultMainBranch(pi, repo.mainRoot);
    await pruneWorktrees(pi, repo.mainRoot);
    const worktrees = await listWorktrees(pi, repo.mainRoot);
    const existing = worktreeForBranch(worktrees, parsed.branch);
    if (existing && existing.path !== repo.mainRoot) {
      const alreadyHere = realpathOrResolve(existing.path) === realpathOrResolve(repo.currentRoot);
      const message = alreadyHere
        ? `Already in the worktree for branch ${parsed.branch}: ${existing.path}`
        : `Worktree already exists for branch ${parsed.branch}: ${existing.path}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, alreadyHere ? "info" : "warning");
        if (!alreadyHere) {
          ctx.ui.notify(`Use /worktree switch ${parsed.branch} to move into it.`, "info");
        }
        return null;
      }
      throw new Error(alreadyHere ? message : `${message}. Use /worktree switch ${parsed.branch}.`);
    }

    let stashSpec: string | undefined;
    if (existing?.path === repo.mainRoot) {
      if (parsed.branch === defaultMain) {
        const message = `Branch ${parsed.branch} is already checked out in the main worktree (${repo.mainRoot}); can't create another worktree for it.`;
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
          return null;
        }
        throw new Error(message);
      }

      const mainSwitchResult = await maybeSwitchMainToDefaultBranch(
        pi,
        ctx,
        repo,
        defaultMain,
        `free branch ${parsed.branch}`,
      );
      if (!mainSwitchResult.proceed) {
        if (ctx.hasUI) ctx.ui.notify("Cancelled", "warning");
        return null;
      }
      stashSpec = mainSwitchResult.stashSpec;
      if (mainSwitchResult.switched && ctx.hasUI) {
        ctx.ui.notify(
          `Switched main worktree (${repo.mainRoot}) from ${parsed.branch} to ${defaultMain} to free the branch.`,
          "info",
        );
        if (stashSpec) {
          ctx.ui.notify(
            `Changes in the main worktree were stashed before switching to ${defaultMain}.`,
            "warning",
          );
        }
      }
    }

    const targetPath = await createWorktree(
      pi,
      ctx,
      repo,
      worktrees,
      parsed.branch,
      parsed.fromRef,
    );
    if (!targetPath) return null;
    return { targetPath, stashSpec } satisfies { targetPath: string; stashSpec?: string };
  });

  if (!result) return;

  if (result.stashSpec) {
    showRestoreStashCommand(pi, ctx, result.targetPath, result.stashSpec);
  }

  showManualOpenCommand(pi, ctx, buildManualOpenCommand(result.targetPath));
}

async function handleSwitch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const parsed = await parseWorktreeTargetArgs(
    pi,
    ctx,
    args,
    "Usage: /worktree switch <branch> [--from <ref>]",
  );
  if (!parsed) return;

  const result = await withSpinnerStatus(ctx, `preparing worktree: ${parsed.branch}`, async () => {
    const repo = await getRepoInfo(pi, ctx.cwd);
    await pruneWorktrees(pi, repo.mainRoot);
    const worktrees = await listWorktrees(pi, repo.mainRoot);
    const existing = worktreeForBranch(worktrees, parsed.branch);
    const targetPath =
      existing?.path ??
      (await createWorktree(pi, ctx, repo, worktrees, parsed.branch, parsed.fromRef));
    if (!targetPath) return null;
    return { targetPath, currentRoot: repo.currentRoot } satisfies {
      targetPath: string;
      currentRoot: string;
    };
  });

  if (!result) return;
  await switchToWorktree(pi, ctx, result.targetPath, result.currentRoot);
}

async function archiveWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repo: RepoInfo,
  branch: string,
  dirtyAction: DirtyAction,
  defaultMain: string,
  worktree?: WorktreeInfo,
): Promise<ArchiveOutcome> {
  const wt = worktree ?? worktreeForBranch(await listWorktrees(pi, repo.mainRoot), branch);
  if (!wt) {
    return {
      branch,
      worktreePath: "",
      removed: false,
      branchDeleted: false,
      skippedReason: "no-worktree",
    };
  }

  if (wt.path === repo.mainRoot) {
    return {
      branch,
      worktreePath: wt.path,
      removed: false,
      branchDeleted: false,
      skippedReason: "main-worktree",
    };
  }

  if (wt.locked) {
    const reason = wt.lockedReason ? `locked: ${wt.lockedReason}` : "locked";
    return {
      branch,
      worktreePath: wt.path,
      removed: false,
      branchDeleted: false,
      skippedReason: reason,
    };
  }

  if (isSameOrInsidePath(ctx.cwd, wt.path)) {
    return {
      branch,
      worktreePath: wt.path,
      removed: false,
      branchDeleted: false,
      skippedReason: "current-cwd",
    };
  }

  const dirty = await isDirty(pi, wt.path);
  let force = false;

  if (dirty) {
    let effectiveAction: DirtyAction = dirtyAction;

    if (dirtyAction === "prompt") {
      if (!ctx.hasUI) {
        throw new Error(`Cannot archive dirty worktree without UI: ${wt.path}`);
      }

      const choice = await withPromptSignal(pi, () =>
        ctx.ui.select(`Worktree has uncommitted changes: ${wt.path}`, [
          "Stash changes (including untracked) and archive",
          "Force remove (lose changes)",
          "Cancel",
        ]),
      );

      if (!choice || choice === "Cancel") {
        return {
          branch,
          worktreePath: wt.path,
          removed: false,
          branchDeleted: false,
          skippedReason: "cancelled",
        };
      }

      effectiveAction = choice.startsWith("Stash") ? "stash" : "force";
    }

    if (effectiveAction === "skip") {
      return {
        branch,
        worktreePath: wt.path,
        removed: false,
        branchDeleted: false,
        skippedReason: "dirty",
      };
    }

    if (effectiveAction === "stash") {
      await stashAll(pi, wt.path, `worktree: stash before archiving ${branch}`);
    }

    if (effectiveAction === "force") {
      force = true;
    }
  }

  await runProjectScripts(pi, ctx, wt.path, "archive", inferArchiveActions(wt.path));

  const removeArgs = force
    ? ["worktree", "remove", "--force", wt.path]
    : ["worktree", "remove", wt.path];
  const remove = await git(pi, repo.mainRoot, removeArgs);
  if (remove.code !== 0) {
    const details = [remove.stdout.trim(), remove.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`Failed to remove worktree ${wt.path}${details ? `\n${details}` : ""}`);
  }

  const upstream = await getUpstream(pi, repo.mainRoot, branch);
  let branchDeleted = false;

  // Never delete the default branch automatically.
  if (branch === defaultMain) {
    return {
      branch,
      worktreePath: wt.path,
      removed: true,
      branchDeleted: false,
    };
  }

  if (upstream) {
    const aheadBehind = await getAheadBehind(pi, repo.mainRoot, branch, upstream);

    if (aheadBehind && aheadBehind.ahead > 0) {
      const ahead = aheadBehind.ahead;

      // Branch has commits not on upstream (not fully pushed)
      if (ctx.hasUI) {
        const ok = await withPromptSignal(pi, () =>
          ctx.ui.confirm(
            "Delete local branch?",
            `Branch ${branch} is ahead of ${upstream} by ${ahead} commit(s). Delete it anyway?`,
          ),
        );
        if (ok) {
          const del = await git(pi, repo.mainRoot, ["branch", "-D", branch]);
          branchDeleted = del.code === 0;
        }
      }
    } else if (!aheadBehind) {
      // Couldn't determine ahead/behind; be conservative.
      if (ctx.hasUI) {
        const ok = await withPromptSignal(pi, () =>
          ctx.ui.confirm(
            "Delete local branch?",
            `Branch ${branch} has an upstream (${upstream}), but I couldn't determine if it's fully pushed. Delete it anyway?`,
          ),
        );
        if (ok) {
          const del = await git(pi, repo.mainRoot, ["branch", "-D", branch]);
          branchDeleted = del.code === 0;
        }
      }
    } else {
      // Fully pushed (or behind) - safe to delete locally.
      // Use -d (not -D) as an extra safety net (refuses if the branch isn't merged into the current HEAD).
      const del = await git(pi, repo.mainRoot, ["branch", "-d", branch]);
      branchDeleted = del.code === 0;

      if (!branchDeleted && ctx.hasUI) {
        const details = [del.stdout.trim(), del.stderr.trim()].filter(Boolean).join("\n");
        const ok = await withPromptSignal(pi, () =>
          ctx.ui.confirm(
            "Force delete local branch?",
            `git branch -d ${branch} failed.${details ? `\n\n${details}` : ""}\n\nThis usually means the branch isn't merged into the main worktree's current branch.\n\nThe branch appears fully pushed to ${upstream}. Force delete it with -D?`,
          ),
        );
        if (ok) {
          const forceDel = await git(pi, repo.mainRoot, ["branch", "-D", branch]);
          branchDeleted = forceDel.code === 0;
          if (!branchDeleted) {
            const forceDetails = [forceDel.stdout.trim(), forceDel.stderr.trim()]
              .filter(Boolean)
              .join("\n");
            const firstLine = (forceDetails || "unknown error").split("\n")[0] || "unknown error";
            ctx.ui.notify(`Failed to delete branch ${branch}: ${firstLine}`, "error");
          }
        }
      }
    }
  } else {
    if (ctx.hasUI) {
      const ok = await withPromptSignal(pi, () =>
        ctx.ui.confirm(
          "Delete local branch?",
          `Branch ${branch} has no upstream. Delete it anyway?`,
        ),
      );
      if (ok) {
        const del = await git(pi, repo.mainRoot, ["branch", "-D", branch]);
        branchDeleted = del.code === 0;
      }
    }
  }

  return {
    branch,
    worktreePath: wt.path,
    removed: true,
    branchDeleted,
  };
}

async function handleArchive(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const tokens = tokenizeArgs(args);
  let branch = tokens[0];
  if (!branch || branch.startsWith("-")) {
    if (!ctx.hasUI) return;
    const input = await withPromptSignal(pi, () => ctx.ui.input("Branch name"));
    if (!input) return;
    branch = input.trim();
  }

  branch = stripRefsHeadsPrefix(branch);
  if (!branch || branch.startsWith("-")) {
    if (ctx.hasUI) ctx.ui.notify("Invalid branch name", "warning");
    return;
  }

  await withSpinnerStatus(ctx, `archiving ${branch}`, async () => {
    const repo = await getRepoInfo(pi, ctx.cwd);
    const defaultMain = await getDefaultMainBranch(pi, repo.mainRoot);

    await pruneWorktrees(pi, repo.mainRoot);
    const outcome = await archiveWorktree(pi, ctx, repo, branch, "prompt", defaultMain);

    if (!ctx.hasUI) return;

    if (outcome.removed) {
      ctx.ui.notify(
        `Archived ${branch} (${outcome.branchDeleted ? "branch deleted" : "branch kept"})`,
        "info",
      );
      return;
    }

    if (outcome.skippedReason === "cancelled") {
      ctx.ui.notify("Cancelled", "warning");
      return;
    }

    if (outcome.skippedReason === "no-worktree") {
      ctx.ui.notify(`No worktree found for branch: ${branch}`, "warning");
      return;
    }

    if (outcome.skippedReason === "main-worktree") {
      ctx.ui.notify(
        `Branch ${branch} is checked out in the main worktree; can't archive it. Use /worktree new ${branch} first.`,
        "warning",
      );
      return;
    }

    if (outcome.skippedReason === "current-cwd") {
      ctx.ui.notify(
        `Can't archive the worktree you're currently in. cd elsewhere and retry: ${outcome.worktreePath}`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(`Skipped ${branch} (${outcome.skippedReason ?? "unknown"})`, "warning");
  });
}

async function handleClean(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!(await ensureCanPrompt(ctx, "Cannot clean without UI"))) return;

  await withSpinnerStatus(ctx, "cleaning pushed worktrees", async (setStatusText) => {
    const repo = await getRepoInfo(pi, ctx.cwd);
    const defaultMain = await getDefaultMainBranch(pi, repo.mainRoot);

    // Ensure upstream info is up to date before deciding what's "pushed".
    const remotes = await git(pi, repo.mainRoot, ["remote"]);
    if (remotes.code === 0 && remotes.stdout.trim().length > 0) {
      setStatusText("fetching remotes...");
      const fetch = await git(pi, repo.mainRoot, ["fetch", "--all", "--prune"], {
        timeout: FETCH_TIMEOUT_MS,
      });
      setStatusText("cleaning pushed worktrees");

      if (fetch.killed || fetch.code !== 0) {
        const details = [fetch.stdout.trim(), fetch.stderr.trim()].filter(Boolean).join("\n");
        throw new Error(
          `git fetch failed${
            fetch.killed ? ` (timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s)` : ""
          }${details ? `\n${details}` : ""}`,
        );
      }
    }

    await pruneWorktrees(pi, repo.mainRoot);
    const worktrees = await listWorktrees(pi, repo.mainRoot);

    const candidates: Array<{ branch: string; worktree: WorktreeInfo; dirty: boolean }> = [];
    const locked: ArchiveOutcome[] = [];

    for (const wt of worktrees) {
      if (!wt.branchRef || wt.detached) continue;
      if (wt.path === repo.mainRoot) continue;
      if (isSameOrInsidePath(ctx.cwd, wt.path)) continue;

      const branch = branchNameFromRef(wt.branchRef);
      const upstream = await getUpstream(pi, repo.mainRoot, branch);
      if (!upstream) continue;

      if (wt.locked) {
        locked.push({
          branch,
          worktreePath: wt.path,
          removed: false,
          branchDeleted: false,
          skippedReason: wt.lockedReason ? `locked: ${wt.lockedReason}` : "locked",
        });
        continue;
      }

      candidates.push({ branch, worktree: wt, dirty: await isDirty(pi, wt.path) });
    }

    if (candidates.length === 0) {
      if (locked.length === 0) {
        ctx.ui.notify("No pushed worktrees to archive", "info");
        return;
      }

      const lockedList = locked
        .map((o) => `${o.branch} (${o.skippedReason ?? "unknown"})`)
        .join(", ");
      ctx.ui.notify(`No removable pushed worktrees. Locked: ${lockedList}`, "warning");
      return;
    }

    let dirtyAction: DirtyAction = "skip";
    const dirtyCount = candidates.filter((c) => c.dirty).length;

    if (dirtyCount > 0) {
      const choice = await withPromptSignal(pi, () =>
        ctx.ui.select(
          `Found ${candidates.length} pushed worktree(s): ${candidates.length - dirtyCount} clean, ${dirtyCount} dirty`,
          [
            "Archive clean only (skip dirty)",
            "Stash dirty (including untracked) and archive all",
            "Force remove dirty and archive all (lose changes)",
            "Cancel",
          ],
        ),
      );

      if (!choice || choice === "Cancel") {
        ctx.ui.notify("Cancelled", "warning");
        return;
      }

      dirtyAction = choice.startsWith("Stash")
        ? "stash"
        : choice.startsWith("Force")
          ? "force"
          : "skip";
    } else {
      const ok = await withPromptSignal(pi, () =>
        ctx.ui.confirm(
          "Archive pushed worktrees?",
          `Archive ${candidates.length} pushed worktree(s)?`,
        ),
      );
      if (!ok) {
        ctx.ui.notify("Cancelled", "warning");
        return;
      }
      dirtyAction = "stash";
    }

    const archived: ArchiveOutcome[] = [];
    const skipped: ArchiveOutcome[] = [...locked];

    for (const c of candidates) {
      const outcome = await archiveWorktree(
        pi,
        ctx,
        repo,
        c.branch,
        dirtyAction,
        defaultMain,
        c.worktree,
      );
      if (outcome.removed) archived.push(outcome);
      else skipped.push(outcome);
    }

    if (ctx.hasUI) {
      const parts = [`Archived ${archived.length} worktree(s)`];
      if (skipped.length > 0) {
        const skippedList = skipped
          .map((o) => `${o.branch} (${o.skippedReason ?? "unknown"})`)
          .join(", ");
        parts.push(`Skipped ${skipped.length}: ${skippedList}`);
      }
      ctx.ui.notify(parts.join(". "), archived.length > 0 ? "info" : "warning");
    }
  });
}

interface WorktreeDisplayItem {
  wt: WorktreeInfo;
  branch: string;
  isCurrent: boolean;
  isMain: boolean;
  status: DirtyState;
  pathState: WorktreePathState;
  tracked: boolean;
}

async function gatherWorktreeDisplayItems(
  pi: ExtensionAPI,
  repo: RepoInfo,
  worktrees: WorktreeInfo[],
): Promise<WorktreeDisplayItem[]> {
  const currentReal = realpathOrResolve(repo.currentRoot);
  const mainReal = realpathOrResolve(repo.mainRoot);
  const items: WorktreeDisplayItem[] = [];

  for (const wt of worktrees) {
    const wtReal = realpathOrResolve(wt.path);
    const isCurrent = wtReal === currentReal;
    const isMain = wtReal === mainReal;

    let branch = "unknown";
    let tracked = false;
    if (wt.branchRef) {
      branch = branchNameFromRef(wt.branchRef);
      tracked = (await getUpstream(pi, repo.mainRoot, branch)) !== null;
    } else if (wt.detached) {
      branch = wt.head ? `detached@${wt.head.slice(0, 7)}` : "detached";
    }

    const pathState = getWorktreePathState(wt.path);
    const status = pathState === "ok" ? await getDirtyState(pi, wt.path) : "unknown";

    items.push({ wt, branch, isCurrent, isMain, status, pathState, tracked });
  }

  return items;
}

function collapsePath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function formatWorktreeLabel(item: WorktreeDisplayItem, theme: Theme): string {
  const parts: string[] = [];

  // Branch name: green + bold for current, plain for others (like git branch).
  // Dirty marker after name (git-style): branch* for dirty, branch for clean.
  const dirty = item.status === "dirty" ? " *" : "";
  const name = `${item.branch}${dirty}`;
  parts.push(item.isCurrent ? theme.fg("success", theme.bold(name)) : name);

  // Tracking.
  if (item.tracked) {
    parts.push(theme.fg("dim", "↑"));
  }

  // Tags.
  if (item.isMain) {
    parts.push(theme.fg("muted", "[primary]"));
  }
  if (item.wt.locked) {
    parts.push(
      theme.fg("error", item.wt.lockedReason ? `locked: ${item.wt.lockedReason}` : "locked"),
    );
  }
  if (item.pathState !== "ok") {
    parts.push(theme.fg("error", item.pathState));
  }

  // Path last — truncates naturally when terminal is narrow.
  parts.push(theme.fg("dim", collapsePath(item.wt.path)));

  return parts.join("  ");
}

async function handleList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const { repo, items } = await withSpinnerStatus(ctx, "listing worktrees", async () => {
    const repo = await getRepoInfo(pi, ctx.cwd);
    const worktrees = await listWorktrees(pi, repo.mainRoot);
    const items = await gatherWorktreeDisplayItems(pi, repo, worktrees);
    return { repo, items };
  });

  if (!ctx.hasUI) {
    for (const item of items) {
      const dirty = item.status === "dirty" ? " *" : "";
      const meta: string[] = [];
      if (item.tracked) meta.push("↑");
      if (item.isMain) meta.push("[primary]");
      if (item.pathState !== "ok") meta.push(item.pathState);
      if (item.wt.locked)
        meta.push(item.wt.lockedReason ? `locked:${item.wt.lockedReason}` : "locked");
      const suffix = meta.length > 0 ? `  ${meta.join("  ")}` : "";
      console.log(`  ${item.branch}${dirty}${suffix}  ${collapsePath(item.wt.path)}`);
    }
    return;
  }

  const theme = ctx.ui.theme;

  const selectItems: SelectItem[] = items.map((item) => ({
    value: item.branch,
    label: formatWorktreeLabel(item, theme),
  }));

  const itemByValue = new Map(items.map((item) => [item.branch, item]));

  type ListResult = { action: "switch" | "archive"; item: WorktreeDisplayItem } | null;

  const result = await withPromptSignal(pi, () =>
    ctx.ui.custom<ListResult>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

      const selectList = new SelectList(selectItems, Math.min(selectItems.length, 15), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => t,
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (si) => {
        const item = itemByValue.get(si.value);
        if (item) done({ action: "switch", item });
        else done(null);
      };
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      container.addChild(
        new Text(theme.fg("dim", " ↑↓ navigate  enter switch  a archive  esc close"), 0, 0),
      );
      container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          if (matchesKey(data, "a")) {
            const si = selectList.getSelectedItem();
            if (si) {
              const item = itemByValue.get(si.value);
              if (item) {
                done({ action: "archive", item });
                return;
              }
            }
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    }),
  );

  if (!result) return;

  if (result.action === "switch") {
    await switchToWorktree(pi, ctx, result.item.wt.path, repo.currentRoot);
    return;
  }

  if (result.action === "archive") {
    await withSpinnerStatus(ctx, `archiving ${result.item.branch}`, async () => {
      const defaultMain = await getDefaultMainBranch(pi, repo.mainRoot);
      await archiveWorktree(
        pi,
        ctx,
        repo,
        result.item.branch,
        "prompt",
        defaultMain,
        result.item.wt,
      );
    });
  }
}

function parseSubcommand(args: string): { subcommand: Subcommand | null; rest: string } {
  const tokens = tokenizeArgs(args);
  const sub = tokens[0] as Subcommand | undefined;
  if (sub === "new" || sub === "switch" || sub === "archive" || sub === "clean" || sub === "list") {
    return { subcommand: sub, rest: tokens.slice(1).join(" ") };
  }
  return { subcommand: null, rest: args };
}

export default function worktreeExtension(pi: ExtensionAPI) {
  for (const customType of [
    MANUAL_OPEN_MESSAGE_TYPE,
    RESTORE_STASH_MESSAGE_TYPE,
    SCRIPT_RERUN_MESSAGE_TYPE,
  ]) {
    pi.registerMessageRenderer(customType, (message, _options, theme) => {
      const details = message.details as CommandMessageDetails | undefined;
      if (!details || typeof details.intro !== "string" || typeof details.command !== "string") {
        return new Text(typeof message.content === "string" ? message.content : "", 0, 0);
      }

      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(
          [
            theme.fg(
              "customMessageText",
              formatCommandMessageIntro(details.intro, details.copiedToClipboard),
            ),
            "",
            highlightCode(details.command, "bash").join("\n"),
          ].join("\n"),
          0,
          0,
        ),
      );
      return box;
    });
  }

  pi.registerCommand("worktree", {
    description: "Create, switch, and manage git worktrees",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix ?? "";
      const tokens = tokenizeArgs(prefix);
      if (tokens.length === 0) {
        return [
          { value: "new ", label: "new" },
          { value: "switch ", label: "switch" },
          { value: "archive ", label: "archive" },
          { value: "clean", label: "clean" },
          { value: "list", label: "list" },
        ];
      }

      if (tokens.length === 1 && !prefix.endsWith(" ")) {
        const subcommands = ["new", "switch", "archive", "clean", "list"];
        return subcommands
          .filter((s) => s.startsWith(tokens[0]))
          .map((s) => ({
            value: s + (s === "new" || s === "switch" || s === "archive" ? " " : ""),
            label: s,
          }));
      }

      // Keep it minimal and fast (no git calls here; completions must be sync)
      return null;
    },
    handler: async (args, ctx) => {
      const { subcommand, rest } = parseSubcommand(args);
      if (!subcommand) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Usage: /worktree new <branch> [--from <ref>] | /worktree switch <branch> [--from <ref>] | /worktree archive <branch> | /worktree clean | /worktree list",
            "info",
          );
        }
        return;
      }

      if (!ctx.isIdle()) {
        if (ctx.hasUI) ctx.ui.notify("Queued /worktree", "info");
        await ctx.waitForIdle();
      }

      try {
        if (subcommand === "new") {
          await handleNew(pi, ctx, rest);
          return;
        }

        if (subcommand === "switch") {
          await handleSwitch(pi, ctx, rest);
          return;
        }

        if (subcommand === "archive") {
          await handleArchive(pi, ctx, rest);
          return;
        }

        if (subcommand === "clean") {
          await handleClean(pi, ctx);
          return;
        }

        if (subcommand === "list") {
          await handleList(pi, ctx);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else throw err;
      }
    },
  });
}
