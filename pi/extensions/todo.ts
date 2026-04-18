/**
 * Todoist-backed todo tool + /todo command.
 *
 * - Source of truth: Todoist (API v1)
 * - Offline writes: append-only outbox at .pi/todoist/outbox.jsonl
 * - Outbox file exists only while there are pending operations
 * - Task ids are prefixed:
 *   - local:<uuid>   -> pending local task (not synced yet)
 *   - todoist:<id>   -> remote Todoist task id
 */
import {
  defineTool,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Constants ---

const TODOIST_API_BASE_URL = "https://api.todoist.com";
const TODOIST_API_V1_PREFIX = "/api/v1";
const TODOIST_TOKEN_ENV = "TODOIST_API_TOKEN";
const TODOIST_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "todoist");
const TODOIST_CONFIG_PATH = path.join(TODOIST_CONFIG_DIR, "config.json");

const TODOIST_OUTBOX_DIR = ".pi/todoist";
const TODOIST_OUTBOX_FILE = "outbox.jsonl";

const PI_PROJECT_NAME = "Pi 🤖";
const PI_ACTIVE_LABEL = "pi:active";
const WORKSPACE_CACHE_TTL_MS = 5 * 60 * 1000;
const SYNC_INTERVAL_MS = 20 * 1000;
const API_TIMEOUT_MS = 10 * 1000;
const COMPLETED_LOOKBACK_DAYS = 89;

const LOCAL_TASK_PREFIX = "local:";
const TODOIST_TASK_PREFIX = "todoist:";
const TODO_TOOL_NAME = "todo";

const STATUS_KEY = "0-todo";
const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TODO_ACTIONS = [
  "list_active",
  "list_completed",
  "list_all",
  "get",
  "create",
  "comment",
  "start",
  "stop",
  "complete",
  "uncomplete",
  "delete",
] as const;

const TodoParams = Type.Object({
  action: Type.Unsafe<TodoAction>({
    type: "string",
    enum: [...TODO_ACTIONS],
    description: "Todo action",
  }),
  id: Type.Optional(
    Type.String({ description: "Task id (local:<uuid>, todoist:<id>, or plain Todoist id)" }),
  ),
  content: Type.Optional(Type.String({ description: "Task content (create/comment)" })),
  description: Type.Optional(Type.String({ description: "Task description (create)" })),
  labels: Type.Optional(Type.Array(Type.String({ description: "Task label" }))),
});

// --- Types ---

type PromptStatus = "completed" | "error";
type TodoAction = (typeof TODO_ACTIONS)[number];
type ListAction = "list_active" | "list_completed" | "list_all";
type WriteAction = "create" | "comment" | "start" | "stop" | "complete" | "uncomplete" | "delete";
type TaskStatus = "active" | "completed";
type TaskSource = "todoist" | "local";

interface TodoTask {
  id: string;
  content: string;
  description: string;
  labels: string[];
  status: TaskStatus;
  project_id?: string;
  section_id?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  source: TaskSource;
  pending: boolean;
  aliases?: string[];
}

interface TodoComment {
  id: string;
  content: string;
  posted_at?: string;
  source: TaskSource;
  pending: boolean;
}

interface TodoToolDetails {
  action: TodoAction;
  tasks?: TodoTask[];
  task?: TodoTask;
  comments?: TodoComment[];
  queued?: boolean;
  pending_outbox?: number;
  offline?: boolean;
  warnings?: string[];
  error?: string;
}

interface TodoistConfig {
  apiToken?: string;
}

interface WorkspaceContext {
  projectId: string;
  sectionId: string;
  sectionName: string;
  activeLabel: string;
  fetchedAt: number;
}

interface SyncReport {
  applied: number;
  dropped: number;
  pending: number;
  warnings: string[];
  skipped?: "no-outbox" | "missing-token" | "bootstrap-failed" | "auth-blocked";
}

interface BaseOutboxOperation {
  version: 1;
  op_id: string;
  created_at: string;
  type: WriteAction;
}

interface CreateOperation extends BaseOutboxOperation {
  type: "create";
  task_id: string;
  content: string;
  description: string;
  labels: string[];
}

interface CommentOperation extends BaseOutboxOperation {
  type: "comment";
  task_id: string;
  content: string;
}

interface MutateOperation extends BaseOutboxOperation {
  type: "start" | "stop" | "complete" | "uncomplete" | "delete";
  task_id: string;
}

type OutboxOperation = CreateOperation | CommentOperation | MutateOperation;

interface TodoistTaskRecord {
  id: string | number;
  content?: string;
  description?: string;
  labels?: string[];
  project_id?: string | number;
  section_id?: string | number | null;
  checked?: boolean;
  completed_at?: string | null;
  added_at?: string;
  updated_at?: string;
  url?: string;
}

interface TodoistCommentRecord {
  id: string | number;
  content?: string;
  posted_at?: string;
  is_deleted?: boolean;
}

interface PaginatedResults<T> {
  results: T[];
  next_cursor?: string | null;
}

interface CompletedTasksResponse {
  items: TodoistTaskRecord[];
  next_cursor?: string | null;
}

class TodoistApiError extends Error {
  constructor(
    public status: number,
    public responseText: string,
    message: string,
  ) {
    super(message);
    this.name = "TodoistApiError";
  }
}

class UnresolvedLocalTaskError extends Error {
  constructor(public taskId: string) {
    super(`Local task ${taskId} has not been synced yet`);
    this.name = "UnresolvedLocalTaskError";
  }
}

// --- Helpers ---

const runtimeState = {
  localToRemote: new Map<string, string>(),
  syncPromise: null as Promise<SyncReport> | null,
  syncTimer: null as ReturnType<typeof setInterval> | null,
  lastContext: null as ExtensionContext | null,
  suppressTokenPrompt: false,
  workspaceCache: new Map<string, WorkspaceContext>(),
  lastSyncReport: null as SyncReport | null,
  lastSyncAt: null as string | null,
  lastSyncError: null as string | null,
  outboxLocks: new Map<string, Promise<void>>(),
  authSyncBlocked: false,
};

function setTodoToolActive(pi: ExtensionAPI, active: boolean): void {
  const activeTools = new Set(pi.getActiveTools());

  if (active) {
    if (activeTools.has(TODO_TOOL_NAME)) return;
    activeTools.add(TODO_TOOL_NAME);
  } else {
    if (!activeTools.delete(TODO_TOOL_NAME)) return;
  }

  pi.setActiveTools([...activeTools]);
}

async function refreshTodoToolActivation(pi: ExtensionAPI): Promise<void> {
  const { token } = await resolveApiTokenFromEnvOrConfig();
  setTodoToolActive(pi, Boolean(token) && !runtimeState.authSyncBlocked);
}

async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
  pi.events.emit("ui:prompt_start", { source: "todo" });

  let status: PromptStatus = "completed";
  try {
    return await run();
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    pi.events.emit("ui:prompt_end", { source: "todo", status });
  }
}

function textContent(text: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text }];
}

function createOperationId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function toLocalTaskId(rawId?: string): string {
  return `${LOCAL_TASK_PREFIX}${rawId ?? crypto.randomUUID()}`;
}

function toTodoistTaskId(rawId: string | number): string {
  return `${TODOIST_TASK_PREFIX}${String(rawId)}`;
}

function normalizeTaskId(
  input: string,
): { id: string; source: "local" | "todoist" } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Task id is required." };

  if (trimmed.startsWith(LOCAL_TASK_PREFIX)) {
    const value = trimmed.slice(LOCAL_TASK_PREFIX.length).trim();
    if (!value) return { error: `Invalid task id: ${trimmed}` };
    return { id: `${LOCAL_TASK_PREFIX}${value}`, source: "local" };
  }

  if (trimmed.startsWith(TODOIST_TASK_PREFIX)) {
    const value = trimmed.slice(TODOIST_TASK_PREFIX.length).trim();
    if (!value) return { error: `Invalid task id: ${trimmed}` };
    return { id: `${TODOIST_TASK_PREFIX}${value}`, source: "todoist" };
  }

  if (/\s/.test(trimmed)) {
    return { error: `Invalid task id: ${trimmed}. Expected local:<uuid> or todoist:<id>.` };
  }

  return { id: toTodoistTaskId(trimmed), source: "todoist" };
}

function normalizeKnownTaskId(input: string): string {
  const parsed = normalizeTaskId(input);
  if ("error" in parsed) return input;
  return parsed.id;
}

function getTodoistRawId(taskId: string): string | null {
  if (taskId.startsWith(TODOIST_TASK_PREFIX)) return taskId.slice(TODOIST_TASK_PREFIX.length);
  return null;
}

function resolveTaskIdAlias(taskId: string): string {
  const normalized = normalizeKnownTaskId(taskId);
  if (normalized.startsWith(LOCAL_TASK_PREFIX)) {
    return runtimeState.localToRemote.get(normalized) ?? normalized;
  }
  return normalized;
}

function getOutboxDir(cwd: string): string {
  return path.resolve(cwd, TODOIST_OUTBOX_DIR);
}

function getOutboxPath(cwd: string): string {
  return path.join(getOutboxDir(cwd), TODOIST_OUTBOX_FILE);
}

function formatOutboxPath(): string {
  return path.join(TODOIST_OUTBOX_DIR, TODOIST_OUTBOX_FILE);
}

async function withOutboxLock<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const key = getOutboxPath(cwd);
  const previous = runtimeState.outboxLocks.get(key) ?? Promise.resolve();
  let releaseLock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const queueEntry = previous.then(() => gate);
  runtimeState.outboxLocks.set(key, queueEntry);

  await previous;
  try {
    return await task();
  } finally {
    releaseLock?.();
    if (runtimeState.outboxLocks.get(key) === queueEntry) {
      runtimeState.outboxLocks.delete(key);
    }
  }
}

async function removeDirectoryIfEmpty(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath);
    if (!entries.length) {
      await fs.rmdir(dirPath);
    }
  } catch {
    // ignore
  }
}

function isOutboxOperation(value: unknown): value is OutboxOperation {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (data.version !== 1) return false;
  if (typeof data.op_id !== "string") return false;
  if (typeof data.created_at !== "string") return false;
  if (typeof data.type !== "string") return false;
  if (!TODO_ACTIONS.includes(data.type as TodoAction)) return false;

  if (data.type === "create") {
    return (
      typeof data.task_id === "string" &&
      typeof data.content === "string" &&
      typeof data.description === "string" &&
      Array.isArray(data.labels) &&
      data.labels.every((label) => typeof label === "string")
    );
  }

  if (data.type === "comment") {
    return typeof data.task_id === "string" && typeof data.content === "string";
  }

  if (["start", "stop", "complete", "uncomplete", "delete"].includes(data.type)) {
    return typeof data.task_id === "string";
  }

  return false;
}

async function readOutbox(cwd: string): Promise<OutboxOperation[]> {
  const outboxPath = getOutboxPath(cwd);
  let raw: string;
  try {
    raw = await fs.readFile(outboxPath, "utf8");
  } catch {
    return [];
  }

  const operations: OutboxOperation[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isOutboxOperation(parsed)) operations.push(parsed);
    } catch {
      // ignore malformed line
    }
  }
  return operations;
}

async function writeOutbox(cwd: string, operations: OutboxOperation[]): Promise<void> {
  const outboxPath = getOutboxPath(cwd);
  const outboxDir = path.dirname(outboxPath);

  if (!operations.length) {
    await fs.unlink(outboxPath).catch(() => undefined);
    await removeDirectoryIfEmpty(outboxDir);
    return;
  }

  await fs.mkdir(outboxDir, { recursive: true });
  const payload = `${operations.map((op) => JSON.stringify(op)).join("\n")}\n`;
  const tempPath = `${outboxPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, outboxPath);
}

async function appendOutboxOperation(cwd: string, operation: OutboxOperation): Promise<number> {
  return withOutboxLock(cwd, async () => {
    const operations = await readOutbox(cwd);
    operations.push(operation);
    await writeOutbox(cwd, operations);
    return operations.length;
  });
}

function rewriteTaskReference(taskId: string, localId: string, remoteId: string): string {
  return taskId === localId ? remoteId : taskId;
}

function rewriteOperationTaskReference(
  operation: OutboxOperation,
  localId: string,
  remoteId: string,
): OutboxOperation {
  if (operation.type === "create") {
    return operation;
  }
  return {
    ...operation,
    task_id: rewriteTaskReference(operation.task_id, localId, remoteId),
  };
}

async function loadTodoistConfig(): Promise<TodoistConfig> {
  try {
    const raw = await fs.readFile(TODOIST_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as TodoistConfig;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function saveTodoistConfig(config: TodoistConfig): Promise<void> {
  await fs.mkdir(TODOIST_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tempPath = `${TODOIST_CONFIG_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, TODOIST_CONFIG_PATH);
}

async function resolveApiTokenFromEnvOrConfig(): Promise<{
  token: string | null;
  source: "env" | "config" | "missing";
}> {
  const envToken = process.env[TODOIST_TOKEN_ENV]?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const config = await loadTodoistConfig();
  const configuredToken = config.apiToken?.trim();
  if (configuredToken) return { token: configuredToken, source: "config" };

  return { token: null, source: "missing" };
}

function maskToken(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

async function resolveApiToken(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { allowPrompt: boolean; forcePrompt?: boolean },
): Promise<string | null> {
  const resolved = await resolveApiTokenFromEnvOrConfig();
  if (resolved.token && !options.forcePrompt) return resolved.token;

  if (!options.allowPrompt || !ctx.hasUI) return resolved.token ?? null;
  if (runtimeState.suppressTokenPrompt && !options.forcePrompt) return resolved.token ?? null;

  if (resolved.source === "env" && resolved.token && options.forcePrompt) {
    ctx.ui.notify(
      `${TODOIST_TOKEN_ENV} is set in your environment. Update the env var to change the Todoist token.`,
      "warning",
    );
    return resolved.token;
  }

  const enteredToken = await withPromptSignal(pi, () =>
    ctx.ui.input(
      "Todoist API token",
      resolved.token
        ? `Enter a replacement Todoist API token (stored in ${TODOIST_CONFIG_PATH})`
        : `Paste your Todoist API token (stored in ${TODOIST_CONFIG_PATH})`,
    ),
  );

  if (!enteredToken?.trim()) {
    if (resolved.token) return resolved.token;
    runtimeState.suppressTokenPrompt = true;
    return null;
  }

  const token = enteredToken.trim();
  const config = await loadTodoistConfig();
  await saveTodoistConfig({ ...config, apiToken: token });
  runtimeState.suppressTokenPrompt = false;
  ctx.ui.notify("Saved Todoist token.", "info");
  return token;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof TodoistApiError) {
    const detail = error.responseText?.trim();
    if (!detail) return `${error.message}`;
    const short = detail.length > 240 ? `${detail.slice(0, 240)}…` : detail;
    return `${error.message}: ${short}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function shouldDropOperation(error: unknown): boolean {
  if (error instanceof UnresolvedLocalTaskError) return true;
  if (!(error instanceof TodoistApiError)) return false;

  if (error.status === 404 || error.status === 409 || error.status === 410) return true;
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof UnresolvedLocalTaskError) return false;
  if (!(error instanceof TodoistApiError)) return true;
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  return false;
}

function isAuthError(error: unknown): boolean {
  return error instanceof TodoistApiError && (error.status === 401 || error.status === 403);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && (error.name === "AbortError" || error.message === "Cancelled"))
  );
}

function toAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Cancelled");
}

async function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw toAbortError(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(toAbortError(signal));
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function todoistRequest<T>(
  token: string,
  method: "GET" | "POST" | "DELETE",
  apiPath: string,
  options: {
    query?: Record<string, string | number | boolean | string[] | undefined | null>;
    body?: unknown;
    timeoutMs?: number;
    requestId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const url = new URL(`${TODOIST_API_BASE_URL}${apiPath}`);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      url.searchParams.set(key, value.join(","));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS);
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.requestId ? { "X-Request-Id": options.requestId } : {}),
      },
      ...(method === "GET"
        ? {}
        : { body: options.body ? JSON.stringify(options.body) : undefined }),
      signal: requestSignal,
    });

    const bodyText = await response.text();

    if (!response.ok) {
      throw new TodoistApiError(
        response.status,
        bodyText,
        `Todoist ${method} ${apiPath} failed (${response.status})`,
      );
    }

    if (!bodyText.trim()) return {} as T;
    return JSON.parse(bodyText) as T;
  } catch (error: any) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Cancelled");
    }
    if (timeoutSignal.aborted || error?.name === "AbortError") {
      throw new Error(`Todoist request timed out (${method} ${apiPath})`);
    }
    throw error;
  }
}

async function fetchPaginatedResults<T>(
  token: string,
  apiPath: string,
  query: Record<string, string | number | boolean | string[] | undefined | null> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null | undefined = undefined;

  for (let page = 0; page < 100; page += 1) {
    const response: PaginatedResults<T> = await todoistRequest<PaginatedResults<T>>(
      token,
      "GET",
      apiPath,
      {
        query: {
          ...query,
          limit: 200,
          cursor,
        },
        signal,
      },
    );
    items.push(...(response.results ?? []));
    cursor = response.next_cursor;
    if (!cursor) break;
  }

  return items;
}

async function fetchCompletedTasks(
  token: string,
  projectId: string,
  sectionId: string,
  signal?: AbortSignal,
): Promise<TodoistTaskRecord[]> {
  const items: TodoistTaskRecord[] = [];
  let cursor: string | null | undefined = undefined;
  const since = new Date(Date.now() - COMPLETED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  for (let page = 0; page < 100; page += 1) {
    const response: CompletedTasksResponse = await todoistRequest<CompletedTasksResponse>(
      token,
      "GET",
      `${TODOIST_API_V1_PREFIX}/tasks/completed/by_completion_date`,
      {
        query: {
          since,
          until,
          project_id: projectId,
          section_id: sectionId,
          limit: 200,
          cursor,
        },
        signal,
      },
    );
    items.push(...(response.items ?? []));
    cursor = response.next_cursor;
    if (!cursor) break;
  }

  return items;
}

function toIdString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readProjectId(project: any): string | null {
  return toIdString(project?.id) ?? toIdString(project?.project_id) ?? toIdString(project?._v1_id);
}

function computeWorkspaceRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function buildSectionName(cwd: string): string {
  const root = computeWorkspaceRoot(cwd);
  const repoName = path.basename(root) || "workspace";
  const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${repoName} · ${hash}`;
}

async function ensureWorkspace(
  token: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkspaceContext> {
  const cacheKey = computeWorkspaceRoot(cwd);
  const cached = runtimeState.workspaceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached;
  }

  const projects = await fetchPaginatedResults<any>(
    token,
    `${TODOIST_API_V1_PREFIX}/projects`,
    {},
    signal,
  );
  let project = projects.find(
    (candidate) => candidate?.name === PI_PROJECT_NAME && !candidate?.is_archived,
  );
  if (!project) {
    project = await todoistRequest<any>(token, "POST", `${TODOIST_API_V1_PREFIX}/projects`, {
      body: { name: PI_PROJECT_NAME },
      signal,
    });
  }
  const projectId = readProjectId(project);
  if (!projectId) {
    throw new Error("Failed to resolve Todoist project id for Pi project.");
  }

  const sectionName = buildSectionName(cwd);
  const sections = await fetchPaginatedResults<any>(
    token,
    `${TODOIST_API_V1_PREFIX}/sections`,
    {
      project_id: projectId,
    },
    signal,
  );
  let section = sections.find(
    (candidate) => candidate?.name === sectionName && !candidate?.is_archived,
  );
  if (!section) {
    section = await todoistRequest<any>(token, "POST", `${TODOIST_API_V1_PREFIX}/sections`, {
      body: {
        project_id: projectId,
        name: sectionName,
      },
      signal,
    });
  }
  const sectionId = toIdString(section?.id);
  if (!sectionId) {
    throw new Error("Failed to resolve Todoist section id for workspace.");
  }

  const labels = await fetchPaginatedResults<any>(
    token,
    `${TODOIST_API_V1_PREFIX}/labels`,
    {},
    signal,
  );
  let activeLabel = labels.find((label) => label?.name === PI_ACTIVE_LABEL);
  if (!activeLabel) {
    activeLabel = await todoistRequest<any>(token, "POST", `${TODOIST_API_V1_PREFIX}/labels`, {
      body: { name: PI_ACTIVE_LABEL },
      signal,
    });
  }
  const activeLabelName =
    typeof activeLabel?.name === "string" ? activeLabel.name : PI_ACTIVE_LABEL;

  const workspace: WorkspaceContext = {
    projectId,
    sectionId,
    sectionName,
    activeLabel: activeLabelName,
    fetchedAt: Date.now(),
  };

  runtimeState.workspaceCache.set(cacheKey, workspace);
  return workspace;
}

function normalizeTask(task: TodoistTaskRecord, source: TaskSource, pending: boolean): TodoTask {
  const checked = Boolean(task.checked) || Boolean(task.completed_at);
  return {
    id: source === "todoist" ? toTodoistTaskId(task.id) : String(task.id),
    content: task.content ?? "",
    description: task.description ?? "",
    labels: Array.isArray(task.labels)
      ? task.labels.filter((label): label is string => typeof label === "string")
      : [],
    status: checked ? "completed" : "active",
    project_id: toIdString(task.project_id) ?? undefined,
    section_id: toIdString(task.section_id) ?? undefined,
    url: typeof task.url === "string" ? task.url : undefined,
    created_at: typeof task.added_at === "string" ? task.added_at : undefined,
    updated_at: typeof task.updated_at === "string" ? task.updated_at : undefined,
    source,
    pending,
  };
}

function createLocalTask(op: CreateOperation): TodoTask {
  return {
    id: op.task_id,
    content: op.content,
    description: op.description,
    labels: [...op.labels],
    status: "active",
    source: "local",
    pending: true,
    created_at: op.created_at,
    updated_at: op.created_at,
  };
}

function dedupeLabels(labels: string[]): string[] {
  const set = new Set<string>();
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    set.add(trimmed);
  }
  return [...set];
}

function applyOperationToTask(
  task: TodoTask,
  operation: OutboxOperation,
  activeLabel: string,
): TodoTask | null {
  const next: TodoTask = {
    ...task,
    labels: [...task.labels],
    pending: true,
    updated_at: operation.created_at,
  };

  switch (operation.type) {
    case "comment":
      return next;
    case "start": {
      next.labels = dedupeLabels([...next.labels, activeLabel]);
      return next;
    }
    case "stop": {
      next.labels = next.labels.filter((label) => label !== activeLabel);
      return next;
    }
    case "complete": {
      next.status = "completed";
      return next;
    }
    case "uncomplete": {
      next.status = "active";
      return next;
    }
    case "delete":
      return null;
    case "create":
      return next;
  }
}

function buildPendingLocalTasks(
  operations: OutboxOperation[],
  activeLabel: string,
): Map<string, TodoTask> {
  const tasks = new Map<string, TodoTask>();

  for (const operation of operations) {
    if (operation.type === "create") {
      tasks.set(operation.task_id, createLocalTask(operation));
      continue;
    }

    const target = resolveTaskIdAlias(operation.task_id);
    if (!target.startsWith(LOCAL_TASK_PREFIX)) continue;
    const existing = tasks.get(target);
    if (!existing) continue;
    const updated = applyOperationToTask(existing, operation, activeLabel);
    if (!updated) {
      tasks.delete(target);
    } else {
      tasks.set(target, updated);
    }
  }

  return tasks;
}

function attachAliases(tasks: TodoTask[]): TodoTask[] {
  if (!runtimeState.localToRemote.size) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const [localId, remoteId] of runtimeState.localToRemote.entries()) {
    const target = byId.get(remoteId);
    if (!target) continue;
    const aliases = new Set(target.aliases ?? []);
    aliases.add(localId);
    target.aliases = [...aliases];
  }
  return tasks;
}

function applyPendingOperationsToRemoteTasks(
  taskMap: Map<string, TodoTask>,
  operations: OutboxOperation[],
  activeLabel: string,
): void {
  for (const operation of operations) {
    if (operation.type === "create") continue;
    const target = resolveTaskIdAlias(operation.task_id);
    if (!target.startsWith(TODOIST_TASK_PREFIX)) continue;

    const existing = taskMap.get(target);
    if (!existing) continue;
    const updated = applyOperationToTask(existing, operation, activeLabel);
    if (!updated) {
      taskMap.delete(target);
    } else {
      taskMap.set(target, updated);
    }
  }
}

function collectPendingComments(operations: OutboxOperation[], taskId: string): TodoComment[] {
  const normalizedTarget = normalizeKnownTaskId(taskId);
  const comments: TodoComment[] = [];

  for (const operation of operations) {
    if (operation.type !== "comment") continue;
    const resolvedTarget = resolveTaskIdAlias(operation.task_id);
    if (resolvedTarget !== normalizedTarget && operation.task_id !== normalizedTarget) continue;
    comments.push({
      id: `local-comment:${operation.op_id}`,
      content: operation.content,
      posted_at: operation.created_at,
      source: "local",
      pending: true,
    });
  }

  return comments;
}

function isTaskStarted(task: TodoTask): boolean {
  return task.status === "active" && task.labels.includes(PI_ACTIVE_LABEL);
}

function taskSortGroup(task: TodoTask): number {
  if (task.status === "completed") return 2;
  return isTaskStarted(task) ? 0 : 1;
}

function sortTasks(tasks: TodoTask[]): TodoTask[] {
  return [...tasks].sort((a, b) => {
    const aGroup = taskSortGroup(a);
    const bGroup = taskSortGroup(b);
    if (aGroup !== bGroup) return aGroup - bGroup;
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    const aTime = a.created_at ?? a.updated_at ?? "";
    const bTime = b.created_at ?? b.updated_at ?? "";
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    return a.content.localeCompare(b.content);
  });
}

async function fetchRemoteActiveTasks(
  token: string,
  workspace: WorkspaceContext,
  signal?: AbortSignal,
): Promise<TodoTask[]> {
  const records = await fetchPaginatedResults<TodoistTaskRecord>(
    token,
    `${TODOIST_API_V1_PREFIX}/tasks`,
    {
      project_id: workspace.projectId,
      section_id: workspace.sectionId,
    },
    signal,
  );
  return records.map((record) => normalizeTask(record, "todoist", false));
}

async function fetchRemoteCompletedTasks(
  token: string,
  workspace: WorkspaceContext,
  signal?: AbortSignal,
): Promise<TodoTask[]> {
  const records = await fetchCompletedTasks(
    token,
    workspace.projectId,
    workspace.sectionId,
    signal,
  );
  return records.map((record) => normalizeTask({ ...record, checked: true }, "todoist", false));
}

async function fetchRemoteComments(
  token: string,
  todoistId: string,
  signal?: AbortSignal,
): Promise<TodoComment[]> {
  const records = await fetchPaginatedResults<TodoistCommentRecord>(
    token,
    `${TODOIST_API_V1_PREFIX}/comments`,
    {
      task_id: todoistId,
    },
    signal,
  );
  return records
    .filter((record) => !record.is_deleted)
    .map((record) => ({
      id: `todoist-comment:${String(record.id)}`,
      content: record.content ?? "",
      posted_at: record.posted_at,
      source: "todoist",
      pending: false,
    }));
}

async function gatherTasks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: ListAction,
  options: { allowPrompt: boolean; operations?: OutboxOperation[]; signal?: AbortSignal } = {
    allowPrompt: true,
  },
): Promise<{ tasks: TodoTask[]; pendingOutbox: number; offline: boolean; warnings: string[] }> {
  const operations = options.operations ?? (await readOutbox(ctx.cwd));
  const pendingOutbox = operations.length;
  const warnings: string[] = [];
  const wantCompleted = action === "list_all" || action === "list_completed";
  const token = await resolveApiToken(pi, ctx, { allowPrompt: options.allowPrompt });

  let remoteActive: TodoTask[] = [];
  let remoteCompleted: TodoTask[] = [];
  let workspace: WorkspaceContext | null = null;
  let offline = false;

  if (!token) {
    offline = true;
    await refreshTodoToolActivation(pi);
    warnings.push("Todoist API token not configured. Showing local pending operations only.");
  } else {
    try {
      workspace = await ensureWorkspace(token, ctx.cwd, options.signal);
      remoteActive = await fetchRemoteActiveTasks(token, workspace, options.signal);
      if (wantCompleted) {
        remoteCompleted = await fetchRemoteCompletedTasks(token, workspace, options.signal);
      }
      runtimeState.authSyncBlocked = false;
      await refreshTodoToolActivation(pi);
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      offline = true;
      if (isAuthError(error)) {
        runtimeState.authSyncBlocked = true;
        await refreshTodoToolActivation(pi);
      }
      warnings.push(`Failed to read Todoist tasks: ${readErrorMessage(error)}`);
    }
  }

  const taskMap = new Map<string, TodoTask>();
  for (const task of [...remoteActive, ...remoteCompleted]) {
    taskMap.set(task.id, task);
  }

  const activeLabel = workspace?.activeLabel ?? PI_ACTIVE_LABEL;
  applyPendingOperationsToRemoteTasks(taskMap, operations, activeLabel);

  const localTasks = [...buildPendingLocalTasks(operations, activeLabel).values()];
  for (const localTask of localTasks) {
    taskMap.set(localTask.id, localTask);
  }

  let tasks = attachAliases([...taskMap.values()]);
  if (action === "list_active") tasks = tasks.filter((task) => task.status === "active");
  if (action === "list_completed") tasks = tasks.filter((task) => task.status === "completed");

  return {
    tasks: sortTasks(tasks),
    pendingOutbox,
    offline,
    warnings,
  };
}

function findTaskInList(tasks: TodoTask[], taskId: string): TodoTask | undefined {
  const normalized = normalizeKnownTaskId(taskId);
  return tasks.find((task) => task.id === normalized || task.aliases?.includes(normalized));
}

async function setTaskActiveLabel(
  token: string,
  todoistId: string,
  activeLabel: string,
  enabled: boolean,
  requestId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const task = await todoistRequest<TodoistTaskRecord>(
    token,
    "GET",
    `${TODOIST_API_V1_PREFIX}/tasks/${todoistId}`,
    { signal },
  );
  const labels = new Set(Array.isArray(task.labels) ? task.labels : []);
  const hasActiveLabel = labels.has(activeLabel);
  if ((enabled && hasActiveLabel) || (!enabled && !hasActiveLabel)) {
    return;
  }
  if (enabled) labels.add(activeLabel);
  else labels.delete(activeLabel);
  await todoistRequest(token, "POST", `${TODOIST_API_V1_PREFIX}/tasks/${todoistId}`, {
    body: { labels: [...labels] },
    requestId,
    signal,
  });
}

function requireRemoteTaskId(taskId: string): string {
  const resolved = resolveTaskIdAlias(taskId);
  const rawId = getTodoistRawId(resolved);
  if (!rawId) throw new UnresolvedLocalTaskError(taskId);
  return rawId;
}

async function hasActiveTasksInWorkspaceSection(
  token: string,
  workspace: WorkspaceContext,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await todoistRequest<PaginatedResults<TodoistTaskRecord>>(
    token,
    "GET",
    `${TODOIST_API_V1_PREFIX}/tasks`,
    {
      query: {
        project_id: workspace.projectId,
        section_id: workspace.sectionId,
        limit: 1,
      },
      signal,
    },
  );
  return (response.results?.length ?? 0) > 0;
}

async function maybeArchiveWorkspaceSectionIfEmpty(
  token: string,
  workspace: WorkspaceContext,
  cwd: string,
  requestId?: string,
  signal?: AbortSignal,
): Promise<{ archived: boolean }> {
  const hasActiveTasks = await hasActiveTasksInWorkspaceSection(token, workspace, signal);
  if (hasActiveTasks) {
    return { archived: false };
  }

  await todoistRequest(
    token,
    "POST",
    `${TODOIST_API_V1_PREFIX}/sections/${workspace.sectionId}/archive`,
    {
      requestId,
      signal,
    },
  );
  runtimeState.workspaceCache.delete(computeWorkspaceRoot(cwd));
  return { archived: true };
}

async function applyOutboxOperation(
  token: string,
  workspace: WorkspaceContext,
  operation: OutboxOperation,
  signal?: AbortSignal,
): Promise<{ mapped?: { localId: string; remoteId: string } }> {
  switch (operation.type) {
    case "create": {
      const created = await todoistRequest<TodoistTaskRecord>(
        token,
        "POST",
        `${TODOIST_API_V1_PREFIX}/tasks`,
        {
          body: {
            content: operation.content,
            description: operation.description || undefined,
            labels: dedupeLabels(operation.labels),
            project_id: workspace.projectId,
            section_id: workspace.sectionId,
          },
          requestId: operation.op_id,
          signal,
        },
      );
      const remoteId = toTodoistTaskId(created.id);
      return {
        mapped: {
          localId: operation.task_id,
          remoteId,
        },
      };
    }

    case "comment": {
      const todoistId = requireRemoteTaskId(operation.task_id);
      await todoistRequest(token, "POST", `${TODOIST_API_V1_PREFIX}/comments`, {
        body: {
          task_id: todoistId,
          content: operation.content,
        },
        requestId: operation.op_id,
        signal,
      });
      return {};
    }

    case "start": {
      const todoistId = requireRemoteTaskId(operation.task_id);
      await setTaskActiveLabel(
        token,
        todoistId,
        workspace.activeLabel,
        true,
        operation.op_id,
        signal,
      );
      return {};
    }

    case "stop": {
      const todoistId = requireRemoteTaskId(operation.task_id);
      await setTaskActiveLabel(
        token,
        todoistId,
        workspace.activeLabel,
        false,
        operation.op_id,
        signal,
      );
      return {};
    }

    case "complete": {
      const todoistId = requireRemoteTaskId(operation.task_id);
      await todoistRequest(token, "POST", `${TODOIST_API_V1_PREFIX}/tasks/${todoistId}/close`, {
        requestId: operation.op_id,
        signal,
      });
      return {};
    }

    case "uncomplete": {
      const todoistId = requireRemoteTaskId(operation.task_id);
      await todoistRequest(token, "POST", `${TODOIST_API_V1_PREFIX}/tasks/${todoistId}/reopen`, {
        requestId: operation.op_id,
        signal,
      });
      return {};
    }

    case "delete": {
      const todoistId = requireRemoteTaskId(operation.task_id);
      await todoistRequest(token, "DELETE", `${TODOIST_API_V1_PREFIX}/tasks/${todoistId}`, {
        requestId: operation.op_id,
        signal,
      });
      return {};
    }
  }
}

async function syncOutbox(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { allowPrompt: boolean; notify: boolean; signal?: AbortSignal },
): Promise<SyncReport> {
  if (runtimeState.syncPromise) {
    return waitForPromiseWithSignal(runtimeState.syncPromise, options.signal);
  }

  const runnerOptions = {
    allowPrompt: options.allowPrompt,
    notify: options.notify,
  };

  let runner: Promise<SyncReport>;
  runner = (async (): Promise<SyncReport> => {
    try {
      const result = await withOutboxLock(ctx.cwd, async (): Promise<SyncReport> => {
        const report: SyncReport = {
          applied: 0,
          dropped: 0,
          pending: 0,
          warnings: [],
        };

        let operations = await readOutbox(ctx.cwd);
        if (!operations.length) {
          report.skipped = "no-outbox";
          await refreshTodoToolActivation(pi);
          return report;
        }

        if (runtimeState.authSyncBlocked && !runnerOptions.allowPrompt) {
          report.pending = operations.length;
          report.skipped = "auth-blocked";
          await refreshTodoToolActivation(pi);
          return report;
        }
        if (runtimeState.authSyncBlocked && runnerOptions.allowPrompt) {
          runtimeState.authSyncBlocked = false;
        }

        const token = await resolveApiToken(pi, ctx, { allowPrompt: runnerOptions.allowPrompt });
        if (!token) {
          report.pending = operations.length;
          report.skipped = "missing-token";
          await refreshTodoToolActivation(pi);
          if (runnerOptions.notify && ctx.hasUI) {
            ctx.ui.notify("Todoist token missing; operations remain queued locally.", "warning");
          }
          return report;
        }

        let workspace: WorkspaceContext;
        try {
          workspace = await ensureWorkspace(token, ctx.cwd);
        } catch (error) {
          report.pending = operations.length;
          report.skipped = "bootstrap-failed";
          if (isAuthError(error)) {
            runtimeState.authSyncBlocked = true;
          }
          await refreshTodoToolActivation(pi);
          report.warnings.push(`Failed to bootstrap Todoist workspace: ${readErrorMessage(error)}`);
          if (runnerOptions.notify && ctx.hasUI) {
            ctx.ui.notify(report.warnings[0]!, "warning");
          }
          return report;
        }

        let sectionArchived = false;
        let index = 0;
        while (index < operations.length) {
          const operation = operations[index]!;

          try {
            const result = await applyOutboxOperation(token, workspace, operation);
            report.applied += 1;

            if (result.mapped) {
              runtimeState.localToRemote.set(result.mapped.localId, result.mapped.remoteId);
              operations.splice(index, 1);
              operations = operations.map((op) =>
                rewriteOperationTaskReference(op, result.mapped!.localId, result.mapped!.remoteId),
              );
              continue;
            }

            operations.splice(index, 1);
            continue;
          } catch (error) {
            if (isAuthError(error)) {
              runtimeState.authSyncBlocked = true;
              report.warnings.push(
                `Todoist authentication failed while syncing ${operation.type}. Run /todo setup to refresh credentials.`,
              );
              break;
            }

            if (shouldDropOperation(error)) {
              report.dropped += 1;
              report.warnings.push(
                `Dropped ${operation.type} for ${operation.task_id}: ${readErrorMessage(error)}`,
              );
              operations.splice(index, 1);
              continue;
            }

            if (isTransientError(error)) {
              report.warnings.push(
                `Sync paused at ${operation.type} for ${operation.task_id}: ${readErrorMessage(error)}`,
              );
              break;
            }

            report.warnings.push(
              `Failed ${operation.type} for ${operation.task_id}: ${readErrorMessage(error)}`,
            );
            break;
          }
        }

        report.pending = operations.length;
        await writeOutbox(ctx.cwd, operations);

        if (report.pending === 0 && report.applied > 0) {
          const archive = await maybeArchiveWorkspaceSectionIfEmpty(
            token,
            workspace,
            ctx.cwd,
            createOperationId(),
          );
          sectionArchived = archive.archived;
        }

        if (!report.warnings.length) {
          runtimeState.authSyncBlocked = false;
        }

        if (runnerOptions.notify && ctx.hasUI) {
          if (report.applied > 0) {
            const pendingText = report.pending ? `, ${report.pending} pending` : "";
            ctx.ui.notify(`Todoist sync: ${report.applied} applied${pendingText}.`, "info");
          }
          if (sectionArchived) {
            ctx.ui.notify(`Archived empty Todoist section ${workspace.sectionName}.`, "info");
          }
          if (report.warnings.length) {
            ctx.ui.notify(report.warnings[0]!, "warning");
          }
        }

        await refreshTodoToolActivation(pi);
        return report;
      });

      runtimeState.lastSyncReport = result;
      runtimeState.lastSyncAt = nowIso();
      runtimeState.lastSyncError = null;
      return result;
    } catch (error) {
      runtimeState.lastSyncReport = null;
      runtimeState.lastSyncAt = nowIso();
      runtimeState.lastSyncError = readErrorMessage(error);
      throw error;
    } finally {
      runtimeState.syncPromise = null;
    }
  })();

  runtimeState.syncPromise = runner;
  return waitForPromiseWithSignal(runner, options.signal);
}

function startBackgroundSync(pi: ExtensionAPI, ctx: ExtensionContext): void {
  runtimeState.lastContext = ctx;
  if (!ctx.hasUI) return;
  if (runtimeState.syncTimer) return;

  runtimeState.syncTimer = setInterval(() => {
    const activeCtx = runtimeState.lastContext;
    if (!activeCtx) return;
    if (!activeCtx.hasUI) return;
    if (!existsSync(getOutboxPath(activeCtx.cwd))) return;
    void syncOutbox(pi, activeCtx, { allowPrompt: false, notify: false }).catch(() => undefined);
  }, SYNC_INTERVAL_MS);
}

function stopBackgroundSync(): void {
  if (!runtimeState.syncTimer) return;
  clearInterval(runtimeState.syncTimer);
  runtimeState.syncTimer = null;
}

function queueBackgroundSync(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  void syncOutbox(pi, ctx, { allowPrompt: false, notify: false }).catch(() => undefined);
}

function buildPendingWarning(): string {
  return `Operation queued in ${formatOutboxPath()} and will sync automatically.`;
}

function serializeTaskForAgent(task: TodoTask): string {
  return JSON.stringify(task, null, 2);
}

function serializeTaskListForAgent(tasks: TodoTask[]): string {
  return JSON.stringify(tasks, null, 2);
}

function serializeTaskWithCommentsForAgent(task: TodoTask, comments: TodoComment[]): string {
  return JSON.stringify(
    {
      task,
      comments,
    },
    null,
    2,
  );
}

function formatTaskLine(task: TodoTask): string {
  const tags = task.labels.length ? ` [${task.labels.join(", ")}]` : "";
  const pending = task.pending ? " (pending)" : "";
  return `${task.id} ${task.content}${tags} (${task.status})${pending}`;
}

function formatTaskList(tasks: TodoTask[]): string {
  if (!tasks.length) return "No tasks.";
  return tasks.map((task) => `- ${formatTaskLine(task)}`).join("\n");
}

function renderTaskLine(theme: any, task: TodoTask): string {
  const statusColor = task.status === "completed" ? "dim" : "success";
  const pendingText = task.pending ? theme.fg("warning", " (pending)") : "";
  const tagText = task.labels.length ? theme.fg("dim", ` [${task.labels.join(", ")}]`) : "";
  return (
    theme.fg("accent", task.id) +
    " " +
    theme.fg("text", task.content || "(empty)") +
    tagText +
    " " +
    theme.fg(statusColor, `(${task.status})`) +
    pendingText
  );
}

function renderTaskList(theme: any, tasks: TodoTask[], expanded: boolean): string {
  if (!tasks.length) return theme.fg("dim", "No tasks");
  const max = expanded ? tasks.length : Math.min(tasks.length, 8);
  const lines = tasks.slice(0, max).map((task) => renderTaskLine(theme, task));
  if (!expanded && tasks.length > max) {
    lines.push(
      theme.fg("dim", `… ${tasks.length - max} more (${keyHint("app.tools.expand", "to expand")})`),
    );
  }
  return lines.join("\n");
}

function renderWarnings(theme: any, warnings?: string[]): string {
  if (!warnings?.length) return "";
  return warnings.map((warning) => theme.fg("warning", `! ${warning}`)).join("\n");
}

async function withSpinnerStatus<T>(
  ctx: ExtensionCommandContext,
  text: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ctx.hasUI) return fn();

  let frame = 0;
  const render = () => {
    ctx.ui.setStatus(STATUS_KEY, `${STATUS_SPINNER_FRAMES[frame]} ${text}`);
  };

  render();
  const timer = setInterval(() => {
    frame = (frame + 1) % STATUS_SPINNER_FRAMES.length;
    render();
  }, STATUS_SPINNER_INTERVAL_MS);

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function parseCommandArgs(args?: string): string[] {
  if (!args?.trim()) return [];
  return args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

async function runSetup(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const token = await resolveApiToken(pi, ctx, {
    allowPrompt: true,
    forcePrompt: runtimeState.authSyncBlocked,
  });
  if (!token) {
    if (ctx.hasUI) ctx.ui.notify("Todoist token is required.", "warning");
    return;
  }

  runtimeState.authSyncBlocked = false;
  const syncResult = await withSpinnerStatus(ctx, "setting up workspace...", async () => {
    await ensureWorkspace(token, ctx.cwd);
    return syncOutbox(pi, ctx, { allowPrompt: false, notify: false });
  });
  await refreshTodoToolActivation(pi);
  const syncSummary = syncResult.pending
    ? `${syncResult.applied} applied, ${syncResult.pending} pending`
    : `${syncResult.applied} applied`;
  if (ctx.hasUI) {
    ctx.ui.notify(`Todoist is ready (${syncSummary}).`, "info");
  } else {
    console.log(`Todoist is ready (${syncSummary}).`);
  }
}

async function runListCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: ListAction,
  filter?: (task: TodoTask) => boolean,
): Promise<void> {
  const result = await withSpinnerStatus(ctx, "loading tasks...", async () => {
    await syncOutbox(pi, ctx, { allowPrompt: false, notify: false });
    return gatherTasks(pi, ctx, action, { allowPrompt: true });
  });
  const tasks = filter ? result.tasks.filter(filter) : result.tasks;
  const output = formatTaskList(tasks);
  console.log(output);
  if (ctx.hasUI) {
    const summary = `${tasks.length} task(s)`;
    ctx.ui.notify(summary, "info");
    for (const warning of result.warnings) {
      ctx.ui.notify(warning, "warning");
    }
  }
}

async function runDoctor(ctx: ExtensionCommandContext): Promise<void> {
  const { output, hasToken } = await withSpinnerStatus(ctx, "running todo doctor...", async () => {
    const lines: string[] = [];
    const tokenInfo = await resolveApiTokenFromEnvOrConfig();
    const hasToken = Boolean(tokenInfo.token);
    const outboxPath = getOutboxPath(ctx.cwd);
    const pendingOperations = await readOutbox(ctx.cwd);
    const workspaceRoot = computeWorkspaceRoot(ctx.cwd);
    const expectedSection = buildSectionName(ctx.cwd);

    lines.push("Todo doctor");
    lines.push(`- CWD: ${ctx.cwd}`);
    lines.push(`- Workspace root: ${workspaceRoot}`);
    lines.push(`- Expected section: ${expectedSection}`);
    lines.push(
      `- Token: ${tokenInfo.source}${tokenInfo.token ? ` (${maskToken(tokenInfo.token)})` : " (missing)"}`,
    );
    lines.push(
      `- Outbox: ${pendingOperations.length} pending (${existsSync(outboxPath) ? "present" : "absent"}) at ${formatOutboxPath()}`,
    );
    lines.push(`- Local id mappings: ${runtimeState.localToRemote.size}`);
    lines.push(`- Sync in progress: ${runtimeState.syncPromise ? "yes" : "no"}`);

    if (runtimeState.lastSyncAt) {
      if (runtimeState.lastSyncError) {
        lines.push(
          `- Last sync: ${runtimeState.lastSyncAt} (error: ${runtimeState.lastSyncError})`,
        );
      } else if (runtimeState.lastSyncReport) {
        const report = runtimeState.lastSyncReport;
        lines.push(
          `- Last sync: ${runtimeState.lastSyncAt} (applied=${report.applied}, dropped=${report.dropped}, pending=${report.pending}${report.skipped ? `, skipped=${report.skipped}` : ""})`,
        );
        if (report.warnings.length) {
          lines.push(`- Last sync warning: ${report.warnings[0]}`);
        }
      }
    }

    if (!hasToken || !tokenInfo.token) {
      lines.push(`- Todoist status: token missing. Set ${TODOIST_TOKEN_ENV} or run /todo setup.`);
    } else {
      try {
        const workspace = await ensureWorkspace(tokenInfo.token, ctx.cwd);
        lines.push(`- Todoist project: ${PI_PROJECT_NAME} (${workspace.projectId})`);
        lines.push(`- Todoist section: ${workspace.sectionName} (${workspace.sectionId})`);
        lines.push(`- Active label: ${workspace.activeLabel}`);

        const activeTasks = await fetchRemoteActiveTasks(tokenInfo.token, workspace);
        const completedTasks = await fetchRemoteCompletedTasks(tokenInfo.token, workspace);
        lines.push(
          `- Remote counts: active=${activeTasks.length}, completed=${completedTasks.length}`,
        );
      } catch (error) {
        lines.push(`- Todoist status: error (${readErrorMessage(error)})`);
      }
    }

    return {
      output: lines.join("\n"),
      hasToken,
    };
  });

  if (ctx.hasUI) {
    ctx.ui.notify(output, hasToken ? "info" : "warning");
  } else {
    console.log(output);
  }
}

export default function todosExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    runtimeState.lastContext = ctx;
    await refreshTodoToolActivation(pi);
    startBackgroundSync(pi, ctx);
    queueBackgroundSync(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    stopBackgroundSync();
    runtimeState.lastContext = null;
  });

  pi.registerTool(
    defineTool({
      name: TODO_TOOL_NAME,
      label: "Todo",
      description:
        "Todoist-backed tasks (create, get, comment, start/stop, complete/uncomplete, list_active/list_completed/list_all, delete). " +
        "Writes are queued to .pi/todoist/outbox.jsonl for offline-first sync. " +
        "Task ids use local:<uuid> (pending) or todoist:<id> (synced).",
      promptSnippet: "List and manage Todoist-backed tasks for this Pi workspace",
      promptGuidelines: [
        "Use this tool when the user asks to track, inspect, or update tasks instead of keeping an ad-hoc task list in chat.",
        "Prefer list_active or list_all before referencing an existing task id unless the id was returned earlier in the conversation.",
        "Use task ids exactly as returned by the tool, including local:<uuid> and todoist:<id> forms.",
      ],
      parameters: TodoParams,
      renderShell: "self",

      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        const action = input.action;

        const fail = (message: string, warnings: string[] = []) => ({
          content: textContent(message),
          details: {
            action,
            error: message,
            warnings,
          } satisfies TodoToolDetails,
        });

        const enqueueAndRespond = async (
          operation: OutboxOperation,
          taskIdForResponse?: string,
        ) => {
          const pendingOutbox = await appendOutboxOperation(ctx.cwd, operation);
          queueBackgroundSync(pi, ctx);

          let task: TodoTask | undefined;
          if (operation.type === "create") {
            task = createLocalTask(operation);
          } else if (taskIdForResponse) {
            const gathered = await gatherTasks(pi, ctx, "list_all", { allowPrompt: false, signal });
            task = findTaskInList(gathered.tasks, taskIdForResponse);
          }

          const warnings: string[] = [buildPendingWarning()];
          const token = await resolveApiToken(pi, ctx, { allowPrompt: false });
          if (!token) {
            warnings.push(
              "Todoist token not configured yet. Sync will start once a token is available.",
            );
          }

          return {
            content: textContent(
              task
                ? serializeTaskForAgent(task)
                : JSON.stringify({ queued: true, task_id: taskIdForResponse }, null, 2),
            ),
            details: {
              action,
              task,
              queued: true,
              pending_outbox: pendingOutbox,
              warnings,
            } satisfies TodoToolDetails,
          };
        };

        switch (action) {
          case "create": {
            if (!input.content?.trim()) {
              return fail("Error: content is required for create");
            }
            const localId = toLocalTaskId();
            const operation: CreateOperation = {
              version: 1,
              op_id: createOperationId(),
              created_at: nowIso(),
              type: "create",
              task_id: localId,
              content: input.content.trim(),
              description: input.description?.trim() ?? "",
              labels: dedupeLabels(input.labels ?? []),
            };
            return enqueueAndRespond(operation, localId);
          }

          case "comment": {
            if (!input.id) return fail("Error: id is required for comment");
            if (!input.content?.trim()) return fail("Error: content is required for comment");
            const parsed = normalizeTaskId(input.id);
            if ("error" in parsed) return fail(parsed.error);
            const operation: CommentOperation = {
              version: 1,
              op_id: createOperationId(),
              created_at: nowIso(),
              type: "comment",
              task_id: resolveTaskIdAlias(parsed.id),
              content: input.content.trim(),
            };
            return enqueueAndRespond(operation, parsed.id);
          }

          case "start":
          case "stop":
          case "complete":
          case "uncomplete":
          case "delete": {
            if (!input.id) return fail(`Error: id is required for ${action}`);
            const parsed = normalizeTaskId(input.id);
            if ("error" in parsed) return fail(parsed.error);
            const operation: MutateOperation = {
              version: 1,
              op_id: createOperationId(),
              created_at: nowIso(),
              type: action,
              task_id: resolveTaskIdAlias(parsed.id),
            };
            return enqueueAndRespond(operation, parsed.id);
          }

          case "list_active":
          case "list_completed":
          case "list_all": {
            await syncOutbox(pi, ctx, { allowPrompt: false, notify: false, signal });
            const gathered = await gatherTasks(pi, ctx, action, { allowPrompt: true, signal });
            return {
              content: textContent(serializeTaskListForAgent(gathered.tasks)),
              details: {
                action,
                tasks: gathered.tasks,
                pending_outbox: gathered.pendingOutbox,
                offline: gathered.offline,
                warnings: gathered.warnings,
              } satisfies TodoToolDetails,
            };
          }

          case "get": {
            if (!input.id) return fail("Error: id is required for get");
            const parsed = normalizeTaskId(input.id);
            if ("error" in parsed) return fail(parsed.error);

            await syncOutbox(pi, ctx, { allowPrompt: false, notify: false, signal });
            const operations = await readOutbox(ctx.cwd);
            const gathered = await gatherTasks(pi, ctx, "list_all", {
              allowPrompt: true,
              operations,
              signal,
            });
            const task = findTaskInList(gathered.tasks, parsed.id);
            if (!task) {
              return fail(`Task ${parsed.id} not found`, gathered.warnings);
            }

            const token = await resolveApiToken(pi, ctx, { allowPrompt: false });
            let comments: TodoComment[] = [];
            if (token) {
              const rawTodoistId = getTodoistRawId(task.id);
              if (rawTodoistId) {
                try {
                  comments = await fetchRemoteComments(token, rawTodoistId, signal);
                } catch (error) {
                  if (isAbortError(error, signal)) throw error;
                  gathered.warnings.push(`Failed to load comments: ${readErrorMessage(error)}`);
                }
              }
            }

            const pendingComments = collectPendingComments(operations, task.id);
            const mergedComments = [...comments, ...pendingComments];

            return {
              content: textContent(serializeTaskWithCommentsForAgent(task, mergedComments)),
              details: {
                action,
                task,
                comments: mergedComments,
                pending_outbox: gathered.pendingOutbox,
                offline: gathered.offline,
                warnings: gathered.warnings,
              } satisfies TodoToolDetails,
            };
          }
        }
      },

      renderCall(input, theme) {
        const action = input.action;
        const id = input.id ?? "";
        const content = input.content ?? "";
        let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
        if (id) text += " " + theme.fg("accent", normalizeKnownTaskId(id));
        if (content) text += " " + theme.fg("dim", `"${content}"`);
        return new Text(text, 0, 0);
      },

      renderResult(result, { expanded, isPartial }, theme) {
        if (isPartial) {
          return new Text(theme.fg("warning", "Processing..."), 0, 0);
        }

        const details = result.details as TodoToolDetails | undefined;
        if (!details) {
          const text = result.content[0];
          return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }

        if (details.error) {
          return new Text(theme.fg("error", details.error), 0, 0);
        }

        const warningBlock = renderWarnings(theme, details.warnings);

        if (details.tasks) {
          let text = renderTaskList(theme, details.tasks, expanded);
          if (details.offline) {
            text += `\n${theme.fg("warning", "Offline mode: showing local + cached state")}`;
          }
          if (typeof details.pending_outbox === "number" && details.pending_outbox > 0) {
            text += `\n${theme.fg("muted", `${details.pending_outbox} pending operation(s) in outbox`)}`;
          }
          if (warningBlock) {
            text += `\n${warningBlock}`;
          }
          return new Text(text, 0, 0);
        }

        if (details.task) {
          const lines: string[] = [];
          if (details.queued) {
            lines.push(theme.fg("success", "✓ queued") + theme.fg("muted", " (offline-first)"));
          }
          lines.push(renderTaskLine(theme, details.task));
          if (details.task.description?.trim()) {
            lines.push("");
            lines.push(theme.fg("muted", "Description:"));
            for (const line of details.task.description.split("\n")) {
              lines.push(`  ${theme.fg("text", line)}`);
            }
          }

          if (details.comments) {
            if (expanded || details.comments.length <= 3) {
              if (details.comments.length) {
                lines.push("");
                lines.push(theme.fg("muted", `Comments (${details.comments.length}):`));
                for (const comment of details.comments) {
                  const pendingTag = comment.pending ? theme.fg("warning", " (pending)") : "";
                  lines.push(`  ${theme.fg("text", comment.content)}${pendingTag}`);
                }
              }
            } else {
              lines.push(
                theme.fg(
                  "dim",
                  `${details.comments.length} comments (${keyHint("app.tools.expand", "to show")})`,
                ),
              );
            }
          }

          if (typeof details.pending_outbox === "number" && details.pending_outbox > 0) {
            lines.push(
              theme.fg("muted", `${details.pending_outbox} pending operation(s) in outbox`),
            );
          }
          if (warningBlock) lines.push(warningBlock);
          return new Text(lines.join("\n"), 0, 0);
        }

        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      },
    }),
  );

  const todoCommandHandler = async (args: string | undefined, ctx: ExtensionCommandContext) => {
    const tokens = parseCommandArgs(args);
    const first = tokens[0]?.toLowerCase();
    const extraArgs = tokens.slice(1);
    const notifyUsageWarning = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(message);
    };
    const ensureNoArgs = (subcommand: string): boolean => {
      if (!extraArgs.length) return true;
      notifyUsageWarning(`/todo ${subcommand} does not accept arguments.`);
      return false;
    };

    if (!first) {
      notifyUsageWarning("Usage: /todo <active|pending|completed|all|sync|setup|doctor>");
      return;
    }

    if (first === "setup") {
      if (!ensureNoArgs("setup")) return;
      await runSetup(pi, ctx);
      return;
    }

    if (first === "sync") {
      if (!ensureNoArgs("sync")) return;
      const report = await withSpinnerStatus(ctx, "syncing outbox...", async () =>
        syncOutbox(pi, ctx, { allowPrompt: true, notify: true }),
      );
      if (!ctx.hasUI) {
        const line = `applied=${report.applied} dropped=${report.dropped} pending=${report.pending}`;
        console.log(line);
      }
      return;
    }

    if (first === "doctor") {
      if (!ensureNoArgs("doctor")) return;
      await runDoctor(ctx);
      return;
    }

    if (first === "active") {
      if (!ensureNoArgs("active")) return;
      await runListCommand(
        pi,
        ctx,
        "list_active",
        (task) => task.status === "active" && task.labels.includes(PI_ACTIVE_LABEL),
      );
      return;
    }

    if (first === "pending") {
      if (!ensureNoArgs("pending")) return;
      await runListCommand(
        pi,
        ctx,
        "list_active",
        (task) => task.status === "active" && !task.labels.includes(PI_ACTIVE_LABEL),
      );
      return;
    }

    if (first === "completed") {
      if (!ensureNoArgs("completed")) return;
      await runListCommand(pi, ctx, "list_completed");
      return;
    }

    if (first === "all") {
      if (!ensureNoArgs("all")) return;
      await runListCommand(pi, ctx, "list_all");
      return;
    }

    const message = `Unknown /todo subcommand: ${first}. Use active, pending, completed, all, sync, setup, or doctor.`;
    notifyUsageWarning(message);
  };

  const commandDescription =
    "Todoist tasks: /todo <active|pending|completed|all|sync|setup|doctor>";

  pi.registerCommand("todo", {
    description: commandDescription,
    getArgumentCompletions: (prefix) => {
      const options = ["active", "pending", "completed", "all", "sync", "setup", "doctor"];
      const trimmed = prefix.trim().toLowerCase();
      const matches = options.filter((option) => option.startsWith(trimmed));
      if (!matches.length) return null;
      return matches.map((option) => ({ value: option, label: option }));
    },
    handler: todoCommandHandler,
  });
}
