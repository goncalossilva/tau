import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  BorderedLoader,
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { Type } from "typebox";
import {
  formatTelegramAssistantResultFromMessages,
  type TelegramAssistantResultTone,
} from "./assistant-result.mjs";

const AGENT_DIR = getAgentDir();
const RUN_DIR = path.join(AGENT_DIR, "run");
const SOCKET_PATH = path.join(RUN_DIR, "telegram.sock");
const CONFIG_DIR = path.join(AGENT_DIR, "telegram");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const TELEGRAM_BOT_TOKEN_ENV = "PI_TELEGRAM_BOT_TOKEN";
const TELEGRAM_KEYCHAIN_SERVICE = "pi.telegram";
const TELEGRAM_KEYCHAIN_ACCOUNT = "bot-token";
const AUTO_CONNECT_INTERVAL_MS = 3_000;
const COMPACTION_RELEASE_DELAY_MS = 500;
const COMPACTION_STALE_RESET_MS = 120_000;
const TELEGRAM_FILE_SEND_TIMEOUT_MS = 5 * 60_000 + 5_000;
const TELEGRAM_SEND_FILE_CAPABILITY = "send_file";
const TELEGRAM_SEND_FILE_TOOL_NAME = "telegram_send_file";

type TelegramFileRequestMode = "auto" | "document";
type TelegramFileSendResult = { mode: string; size?: number };

type WindowSessionRef = {
  sessionId: string;
  sessionFile?: string;
};

type PendingInject = WindowSessionRef & {
  id: string;
  text: string;
};

type DaemonToClientMessage =
  | {
      type: "registered";
      sessionNo: number;
      paired?: boolean;
      capabilities?: string[];
    }
  | { type: "pin"; code: string; expiresAt: number }
  | { type: "paired"; chatId: number }
  | { type: "error"; error: string }
  | ({ type: "inject"; id: string; text: string } & WindowSessionRef)
  | { type: "abort" }
  | {
      type: "send_file_result";
      id: string;
      ok: boolean;
      error?: string;
      mode?: string;
      size?: number;
    };

type ClientToDaemonMessage =
  | ({
      type: "register";
      windowId: string;
      cwd: string;
      sessionName?: string;
      busy: boolean;
      compacting: boolean;
    } & WindowSessionRef)
  | ({
      type: "meta";
      cwd: string;
      sessionName?: string;
      busy: boolean;
      compacting: boolean;
    } & WindowSessionRef)
  | { type: "inject_result"; id: string; status: "accepted" | "rejected"; reason?: string }
  | { type: "request_pin" }
  | { type: "shutdown" }
  | { type: "assistant_result"; text: string; tone: TelegramAssistantResultTone }
  | {
      type: "send_file";
      id: string;
      path: string;
      mode: TelegramFileRequestMode;
      caption?: string;
      filename?: string;
    }
  | { type: "cancel_send_file"; id: string };

type Config = {
  botToken?: string;
  pairedChatId?: number;
};

type PromptStatus = "completed" | "error";
type TelegramBotTokenSource = "env" | "keychain" | "config" | "missing";

async function withPromptSignal<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
  pi.events.emit("ui:prompt_start", { source: "telegram" });

  let status: PromptStatus = "completed";
  try {
    return await run();
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    pi.events.emit("ui:prompt_end", { source: "telegram", status });
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Cancelled"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Cancelled");
  }
}

async function runWithLoader<T>(
  ctx: ExtensionContext,
  message: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<{ cancelled: boolean; value?: T; error?: string }> {
  if (ctx.mode !== "tui") {
    const controller = new AbortController();
    try {
      const value = await task(controller.signal);
      return { cancelled: false, value };
    } catch (error) {
      return {
        cancelled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const result = await ctx.ui.custom<{ cancelled: boolean; value?: T; error?: string }>(
    (tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, message);
      let settled = false;
      const finish = (value: { cancelled: boolean; value?: T; error?: string }) => {
        if (settled) return;
        settled = true;
        done(value);
      };

      loader.onAbort = () => finish({ cancelled: true });

      task(loader.signal)
        .then((value) => finish({ cancelled: false, value }))
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          finish({ cancelled: false, error: errorMessage });
        });

      return loader;
    },
  );

  return result;
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

async function removeDirectoryIfEmpty(dirPath: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dirPath);
    if (!entries.length) {
      await fsp.rmdir(dirPath);
    }
  } catch {
    // ignore
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  const nextConfig: Config = {};
  const botToken = cfg.botToken?.trim();
  if (botToken) nextConfig.botToken = botToken;
  if (cfg.pairedChatId !== undefined) nextConfig.pairedChatId = cfg.pairedChatId;

  if (nextConfig.botToken === undefined && nextConfig.pairedChatId === undefined) {
    await fsp.unlink(CONFIG_PATH).catch(() => undefined);
    await removeDirectoryIfEmpty(CONFIG_DIR);
    return;
  }

  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(nextConfig, null, 2) + "\n", { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_PATH);
}

function canUseTelegramKeychain(): boolean {
  return process.platform === "darwin";
}

async function runTelegramKeychainCommand(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("security", args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function readTelegramBotTokenFromKeychain(): Promise<string | null> {
  if (!canUseTelegramKeychain()) return null;

  try {
    return (
      (await runTelegramKeychainCommand([
        "find-generic-password",
        "-w",
        "-a",
        TELEGRAM_KEYCHAIN_ACCOUNT,
        "-s",
        TELEGRAM_KEYCHAIN_SERVICE,
      ])) || null
    );
  } catch {
    return null;
  }
}

async function saveTelegramBotTokenToKeychain(token: string): Promise<void> {
  if (!canUseTelegramKeychain()) {
    throw new Error("macOS Keychain is not available for Telegram bot token storage.");
  }

  try {
    await runTelegramKeychainCommand([
      "add-generic-password",
      "-U",
      "-w",
      token,
      "-a",
      TELEGRAM_KEYCHAIN_ACCOUNT,
      "-s",
      TELEGRAM_KEYCHAIN_SERVICE,
    ]);
  } catch {
    throw new Error("Failed to save Telegram bot token to macOS Keychain.");
  }
}

function buildPersistedConfig(config: Config, tokenSource: TelegramBotTokenSource): Config {
  const nextConfig: Config = {};
  if (tokenSource === "config" && config.botToken?.trim())
    nextConfig.botToken = config.botToken.trim();
  if (config.pairedChatId !== undefined) nextConfig.pairedChatId = config.pairedChatId;
  return nextConfig;
}

async function clearTelegramConfigBotToken(): Promise<void> {
  const config = await loadConfig();
  if (!config.botToken?.trim()) return;
  delete config.botToken;
  await saveConfig(config);
}

async function resolveTelegramBotToken(): Promise<{
  token: string | null;
  source: TelegramBotTokenSource;
}> {
  const envToken = process.env[TELEGRAM_BOT_TOKEN_ENV]?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const keychainToken = await readTelegramBotTokenFromKeychain();
  if (keychainToken) return { token: keychainToken, source: "keychain" };

  const config = await loadConfig();
  const configuredToken = config.botToken?.trim();
  if (configuredToken) return { token: configuredToken, source: "config" };

  return { token: null, source: "missing" };
}

function describeTelegramBotTokenSetup(): string {
  if (canUseTelegramKeychain()) {
    return `Set ${TELEGRAM_BOT_TOKEN_ENV}, store it in macOS Keychain via /telegram pair, or create ${CONFIG_PATH} with {"botToken": "..."}.`;
  }

  return `Set ${TELEGRAM_BOT_TOKEN_ENV} or create ${CONFIG_PATH} with {"botToken": "..."}.`;
}

function parseArgs(args: string | undefined): string[] {
  if (!args) return [];
  const trimmed = args.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/g);
}

function getTelegramArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const trimmed = prefix.trim().toLowerCase();
  if (trimmed.includes(" ")) return null;

  const options = ["pair", "status", "unpair", "help"];
  const matches = options.filter((option) => option.startsWith(trimmed));
  if (!matches.length) return null;

  return matches.map((option) => ({ value: option, label: option }));
}

function getCurrentSessionRef(ctx: ExtensionContext): WindowSessionRef {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
  };
}

function isPendingInjectForCurrentSession(
  inject: WindowSessionRef,
  ctx: ExtensionContext,
): boolean {
  const current = getCurrentSessionRef(ctx);
  if (inject.sessionId !== current.sessionId) return false;
  return inject.sessionFile === current.sessionFile;
}

function describeInjectSessionMismatch(inject: WindowSessionRef, ctx: ExtensionContext): string {
  const current = getCurrentSessionRef(ctx);
  if (inject.sessionId === current.sessionId) {
    return "Window session file changed before the Telegram message could be delivered.";
  }
  return "Window switched to a different Pi session before the Telegram message could be delivered.";
}

function jsonlWrite(socket: net.Socket, msg: ClientToDaemonMessage) {
  socket.write(JSON.stringify(msg) + "\n");
}

function createJsonlReader(socket: net.Socket, onMessage: (msg: DaemonToClientMessage) => void) {
  socket.setEncoding("utf8");
  let buf = "";
  socket.on("data", (data: string) => {
    buf += data;
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg.type === "string") onMessage(msg as DaemonToClientMessage);
      } catch {
        // ignore
      }
    }
  });
}

async function canConnectSocket(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.connect(SOCKET_PATH);
    s.once("connect", () => {
      s.end();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

async function ensureDaemonRunning(daemonPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });

  throwIfAborted(signal);
  if (await canConnectSocket()) return;

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PI_TELEGRAM_AGENT_DIR: AGENT_DIR,
      PI_TELEGRAM_PI_EXECUTABLE: process.execPath,
      PI_TELEGRAM_PI_ENTRYPOINT: process.argv[1] ?? "",
    },
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    throwIfAborted(signal);
    if (await canConnectSocket()) return;
    await sleep(100, signal);
  }

  throw new Error("Failed to start telegram daemon (socket not available)");
}

async function sendEphemeral(msg: ClientToDaemonMessage): Promise<void> {
  const socket = net.connect(SOCKET_PATH);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };

    socket.once("error", onError);
    socket.once("connect", onConnect);
  });

  const payload = JSON.stringify(msg) + "\n";

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("error", onError);
      reject(error);
    };

    socket.once("error", onError);
    socket.end(payload, () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

function normalizeLocalFilePath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("Missing file path.");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(cwd, trimmed);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_TELEGRAM_DISABLE === "1") return;

  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const daemonPath = path.join(extensionDir, "daemon.mjs");

  const state = {
    socket: null as net.Socket | null,
    windowId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionNo: null as number | null,
    busy: false,
    compacting: false,
    awaitingRetry: false,
    pendingInjectedTexts: [] as PendingInject[],
    flushInjectedTextsPromise: null as Promise<void> | null,
    pendingInjectedFlushTimer: null as ReturnType<typeof setTimeout> | null,
    compactionResetTimer: null as ReturnType<typeof setTimeout> | null,
    lastCtx: null as ExtensionContext | null,
    connectPromise: null as Promise<void> | null,
    autoConnectTimer: null as ReturnType<typeof setInterval> | null,
    paired: false,
    daemonCapabilities: new Set<string>(),
    sendFileToolRegistered: false,
    staleDaemonNoticeShown: false,
  };

  let lastAgentEndMessages: AgentMessage[] | undefined;
  const daemonMessageHandlers = new Set<(msg: DaemonToClientMessage) => void>();

  function clearPendingInjectedFlushTimer() {
    if (!state.pendingInjectedFlushTimer) return;
    clearTimeout(state.pendingInjectedFlushTimer);
    state.pendingInjectedFlushTimer = null;
  }

  function schedulePendingInjectedFlush(delayMs = 0) {
    if (state.pendingInjectedFlushTimer) return;
    state.pendingInjectedFlushTimer = setTimeout(() => {
      state.pendingInjectedFlushTimer = null;
      void flushPendingInjectedTexts();
    }, delayMs);
    state.pendingInjectedFlushTimer.unref?.();
  }

  function clearCompactionResetTimer() {
    if (!state.compactionResetTimer) return;
    clearTimeout(state.compactionResetTimer);
    state.compactionResetTimer = null;
  }

  function applyCompactingState(compacting: boolean, ctx?: ExtensionContext | null) {
    state.compacting = compacting;

    if (compacting) {
      clearCompactionResetTimer();
      state.compactionResetTimer = setTimeout(() => {
        state.compactionResetTimer = null;
        applyCompactingState(false, state.lastCtx);
      }, COMPACTION_STALE_RESET_MS);
      state.compactionResetTimer.unref?.();
    } else {
      clearCompactionResetTimer();
    }

    const currentCtx = ctx ?? state.lastCtx;
    if (currentCtx) {
      if (isSocketConnected()) {
        updateMeta(currentCtx);
      } else {
        void tryAutoConnect();
      }
    }

    if (!compacting) {
      void flushPendingInjectedTexts();
    }
  }

  async function flushPendingInjectedTexts(): Promise<void> {
    if (state.flushInjectedTextsPromise) {
      await state.flushInjectedTextsPromise;
      return;
    }

    const flushPromise = (async () => {
      while (true) {
        const ctx = state.lastCtx;
        const inject = state.pendingInjectedTexts[0];
        if (!ctx || !inject) return;
        if (state.compacting || state.awaitingRetry) return;

        if (!isPendingInjectForCurrentSession(inject, ctx)) {
          state.pendingInjectedTexts.shift();
          sendInjectResult(inject.id, "rejected", describeInjectSessionMismatch(inject, ctx));
          continue;
        }

        if (ctx.isIdle() && ctx.hasPendingMessages()) {
          schedulePendingInjectedFlush(500);
          return;
        }

        try {
          if (ctx.isIdle()) {
            pi.sendUserMessage(inject.text);
            state.pendingInjectedTexts.shift();
            sendInjectResult(inject.id, "accepted");
            if (state.pendingInjectedTexts.length > 0) {
              schedulePendingInjectedFlush(500);
            }
            return;
          }

          pi.sendUserMessage(inject.text, { deliverAs: "followUp" });
          state.pendingInjectedTexts.shift();
          sendInjectResult(inject.id, "accepted");
        } catch {
          schedulePendingInjectedFlush(500);
          return;
        }
      }
    })();

    state.flushInjectedTextsPromise = flushPromise;
    try {
      await flushPromise;
    } finally {
      if (state.flushInjectedTextsPromise === flushPromise) {
        state.flushInjectedTextsPromise = null;
      }
    }
  }

  function isSocketConnected() {
    return !!(state.socket && !state.socket.destroyed);
  }

  function clearUI(ctx?: ExtensionContext | null) {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("telegram", undefined);
    ctx.ui.setWidget("telegram", undefined);
  }

  function connectedStatusText(ctx: ExtensionContext, sessionNo: number): string {
    const text = `telegram (session ${sessionNo})`;
    return ctx.hasUI ? ctx.ui.theme.fg("dim", text) : text;
  }

  function disconnect(restartAutoConnect = true) {
    const socket = state.socket;
    state.socket = null;
    state.sessionNo = null;
    state.paired = false;
    state.daemonCapabilities.clear();
    updateTelegramSendFileToolAvailability();
    clearUI(state.lastCtx);

    if (restartAutoConnect) {
      startAutoConnectLoop();
    }

    if (!socket || socket.destroyed) return;
    try {
      socket.end();
    } catch {}
    try {
      socket.destroy();
    } catch {}
  }

  function send(msg: ClientToDaemonMessage) {
    if (!state.socket || state.socket.destroyed) return;
    try {
      jsonlWrite(state.socket, msg);
    } catch {
      // ignore
    }
  }

  function sendInjectResult(id: string, status: "accepted" | "rejected", reason?: string) {
    send({ type: "inject_result", id, status, reason });
  }

  function updateMeta(ctx: ExtensionContext) {
    const sessionName = pi.getSessionName() ?? undefined;
    send({
      type: "meta",
      cwd: ctx.cwd,
      sessionName,
      busy: state.busy,
      compacting: state.compacting,
      ...getCurrentSessionRef(ctx),
    });
  }

  async function connectPersistent(
    ctx: ExtensionContext,
    options: { signal?: AbortSignal; ensureDaemon?: boolean } = {},
  ): Promise<void> {
    if (isSocketConnected()) return;

    if (state.connectPromise) {
      try {
        await state.connectPromise;
      } catch {
        // ignore; we may retry below
      }
      if (isSocketConnected()) return;
    }

    const { signal, ensureDaemon = true } = options;

    const connectPromise = (async () => {
      if (ensureDaemon) {
        await ensureDaemonRunning(daemonPath, signal);
        throwIfAborted(signal);
      }

      const socket = net.connect(SOCKET_PATH);

      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          cleanup();
          try {
            socket.destroy();
          } catch {}
          reject(new Error("Cancelled"));
        };
        const cleanup = () => {
          socket.off("connect", onConnect);
          socket.off("error", onError);
          signal?.removeEventListener("abort", onAbort);
        };

        socket.once("connect", onConnect);
        socket.once("error", onError);

        if (!signal) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });

      state.socket = socket;
      createJsonlReader(socket, handleDaemonMessage);

      const onSocketGone = () => {
        if (state.socket === socket) {
          state.socket = null;
          state.sessionNo = null;
          state.paired = false;
          state.daemonCapabilities.clear();
          updateTelegramSendFileToolAvailability();
          clearUI(state.lastCtx);
          startAutoConnectLoop();
          void tryAutoConnect();
        }
      };

      socket.once("close", onSocketGone);
      socket.once("error", onSocketGone);

      jsonlWrite(socket, {
        type: "register",
        windowId: state.windowId,
        cwd: ctx.cwd,
        sessionName: pi.getSessionName() ?? undefined,
        busy: state.busy,
        compacting: state.compacting,
        ...getCurrentSessionRef(ctx),
      });
    })();

    state.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (state.connectPromise === connectPromise) {
        state.connectPromise = null;
      }
    }
  }

  async function tryAutoConnect(): Promise<void> {
    const ctx = state.lastCtx;
    if (!ctx) return;
    if (isSocketConnected()) return;
    if (state.connectPromise) return;

    const cfg = await loadConfig();
    const tokenInfo = await resolveTelegramBotToken();
    if (!tokenInfo.token || cfg.pairedChatId === undefined) return;

    const daemonUp = await canConnectSocket();

    try {
      await connectPersistent(ctx, { ensureDaemon: !daemonUp });
      updateMeta(ctx);
    } catch {
      // ignore; next loop tick will retry
    }
  }

  function startAutoConnectLoop() {
    if (state.autoConnectTimer) return;
    state.autoConnectTimer = setInterval(() => {
      void tryAutoConnect();
    }, AUTO_CONNECT_INTERVAL_MS);
  }

  function stopAutoConnectLoop() {
    if (!state.autoConnectTimer) return;
    clearInterval(state.autoConnectTimer);
    state.autoConnectTimer = null;
  }

  async function requestPin(
    signal?: AbortSignal,
  ): Promise<{ code: string; expiresAt: number } | null> {
    if (!state.socket || state.socket.destroyed) return null;

    return await new Promise((resolve) => {
      let done = false;
      const timeout = setTimeout(() => {
        finish(null);
      }, 10_000);

      const finish = (value: { code: string; expiresAt: number } | null) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        daemonMessageHandlers.delete(handler);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };

      const handler = (msg: DaemonToClientMessage) => {
        if (msg.type === "pin") {
          finish({ code: msg.code, expiresAt: msg.expiresAt });
          return;
        }
        if (msg.type === "error") {
          finish(null);
        }
      };

      const onAbort = () => {
        finish(null);
      };

      if (signal) {
        if (signal.aborted) {
          finish(null);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      daemonMessageHandlers.add(handler);
      send({ type: "request_pin" });
    });
  }

  async function sendTelegramFileRequest(
    request: {
      filePath: string;
      mode: TelegramFileRequestMode;
      caption?: string;
      filename?: string;
    },
    signal?: AbortSignal,
  ): Promise<TelegramFileSendResult> {
    if (
      !isSocketConnected() ||
      !state.paired ||
      !state.daemonCapabilities.has(TELEGRAM_SEND_FILE_CAPABILITY)
    ) {
      throw new Error("Telegram file sending is not available. Run /telegram pair first.");
    }

    const socket = state.socket;
    if (!socket) throw new Error("Telegram daemon is not connected.");

    const id = `send-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return await new Promise<TelegramFileSendResult>((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => {
        cancel();
        finish(new Error("Timed out waiting for Telegram to send the file."));
      }, TELEGRAM_FILE_SEND_TIMEOUT_MS);

      const finish = (error?: Error, result?: TelegramFileSendResult) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        daemonMessageHandlers.delete(handler);
        signal?.removeEventListener("abort", onAbort);
        socket.off("close", onSocketGone);
        socket.off("error", onSocketGone);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error("Telegram daemon returned an invalid file send result."));
      };

      const cancel = () => {
        if (socket.destroyed) return;
        try {
          jsonlWrite(socket, { type: "cancel_send_file", id });
        } catch {
          // ignore
        }
      };

      const handler = (msg: DaemonToClientMessage) => {
        if (msg.type !== "send_file_result" || msg.id !== id) return;
        if (!msg.ok) {
          finish(new Error(msg.error || "Telegram daemon failed to send the file."));
          return;
        }

        const mode = typeof msg.mode === "string" && msg.mode ? msg.mode : "file";
        const size =
          typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size >= 0
            ? msg.size
            : undefined;
        finish(undefined, { mode, size });
      };

      const onAbort = () => {
        cancel();
        finish(new Error("Cancelled"));
      };
      const onSocketGone = () => finish(new Error("Telegram daemon disconnected."));

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      socket.once("close", onSocketGone);
      socket.once("error", onSocketGone);
      daemonMessageHandlers.add(handler);
      try {
        jsonlWrite(socket, {
          type: "send_file",
          id,
          path: request.filePath,
          mode: request.mode,
          caption: request.caption,
          filename: request.filename,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function updateTelegramSendFileToolAvailability() {
    const available =
      isSocketConnected() &&
      state.sessionNo !== null &&
      state.paired &&
      state.daemonCapabilities.has(TELEGRAM_SEND_FILE_CAPABILITY);

    if (available && !state.sendFileToolRegistered) {
      state.sendFileToolRegistered = true;
      registerTelegramSendFileTool();
    }

    if (!state.sendFileToolRegistered) return;

    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(TELEGRAM_SEND_FILE_TOOL_NAME);
    if (available === isActive) return;

    pi.setActiveTools(
      available
        ? [...activeTools, TELEGRAM_SEND_FILE_TOOL_NAME]
        : activeTools.filter((name) => name !== TELEGRAM_SEND_FILE_TOOL_NAME),
    );
  }

  function registerTelegramSendFileTool() {
    pi.registerTool(
      defineTool({
        name: TELEGRAM_SEND_FILE_TOOL_NAME,
        label: "Telegram Send File",
        description: "Send a local image or file to the paired Telegram chat.",
        promptSnippet: "Send local screenshots, images, or files to the paired Telegram chat",
        promptGuidelines: [
          "Use telegram_send_file only when the user explicitly asks to send a specific local file to Telegram.",
          "Use telegram_send_file with asDocument=true when the exact file should be preserved instead of Telegram photo display/compression.",
        ],
        parameters: Type.Object({
          path: Type.String({ description: "Local path to the image or file to send" }),
          caption: Type.Optional(Type.String({ description: "Optional Telegram caption" })),
          asDocument: Type.Optional(
            Type.Boolean({
              description:
                "Send as a Telegram document instead of a photo. Use this when exact image bytes matter.",
            }),
          ),
          filename: Type.Optional(
            Type.String({ description: "Optional bare filename override for the upload" }),
          ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const filePath = normalizeLocalFilePath(params.path, ctx.cwd);
          const requestedMode: TelegramFileRequestMode = params.asDocument ? "document" : "auto";
          const result = await sendTelegramFileRequest(
            {
              filePath,
              mode: requestedMode,
              caption: params.caption,
              filename: params.filename,
            },
            signal,
          );

          const size = result.size === undefined ? "" : ` (${formatBytes(result.size)})`;
          return {
            content: [
              {
                type: "text",
                text: `Sent ${path.basename(filePath)} to Telegram as a ${result.mode}${size}.`,
              },
            ],
            details: { path: filePath, ...result },
          };
        },
      }),
    );
  }

  function handleDaemonMessage(msg: DaemonToClientMessage) {
    for (const h of daemonMessageHandlers) {
      try {
        h(msg);
      } catch {
        // ignore
      }
    }

    if (msg.type === "registered") {
      state.sessionNo = msg.sessionNo;
      state.paired = msg.paired === true;
      state.daemonCapabilities = new Set(msg.capabilities ?? []);
      updateTelegramSendFileToolAvailability();
      stopAutoConnectLoop();
      if (state.lastCtx?.hasUI) {
        state.lastCtx.ui.setStatus("telegram", connectedStatusText(state.lastCtx, msg.sessionNo));
        if (
          !state.daemonCapabilities.has(TELEGRAM_SEND_FILE_CAPABILITY) &&
          !state.staleDaemonNoticeShown
        ) {
          state.staleDaemonNoticeShown = true;
          state.lastCtx.ui.notify(
            "The running Telegram daemon predates file sending. The tool will become available after the daemon next starts.",
            "warning",
          );
        }
      }
      return;
    }

    if (msg.type === "paired") {
      state.paired = true;
      updateTelegramSendFileToolAvailability();
      if (state.lastCtx?.hasUI) {
        state.lastCtx.ui.setWidget("telegram", undefined);
      }
      return;
    }

    if (msg.type === "inject") {
      const text = msg.text;
      if (!text) return;
      state.pendingInjectedTexts.push({
        id: msg.id,
        text,
        sessionId: msg.sessionId,
        sessionFile: msg.sessionFile,
      });
      void flushPendingInjectedTexts();
      return;
    }

    if (msg.type === "abort") {
      const ctx = state.lastCtx;
      if (!ctx) return;
      ctx.abort();
      return;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    state.lastCtx = ctx;
    startAutoConnectLoop();
    if (isSocketConnected()) {
      updateMeta(ctx);
    } else {
      void tryAutoConnect();
    }
    void flushPendingInjectedTexts();
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension" && state.pendingInjectedTexts.length > 0) {
      state.pendingInjectedTexts = [];
      clearPendingInjectedFlushTimer();
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (state.compacting) {
      applyCompactingState(false, ctx);
    }

    state.busy = true;
    if (isSocketConnected()) {
      updateMeta(ctx);
      if (!state.awaitingRetry) {
        void flushPendingInjectedTexts();
      }
      return;
    }
    void tryAutoConnect();
    if (!state.awaitingRetry) {
      void flushPendingInjectedTexts();
    }
  });

  pi.on("agent_end", async (event) => {
    lastAgentEndMessages = event.messages;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const result = formatTelegramAssistantResultFromMessages(lastAgentEndMessages);
    lastAgentEndMessages = undefined;
    state.awaitingRetry = false;
    state.busy = false;
    if (isSocketConnected()) {
      updateMeta(ctx);
      if (result) {
        send({ type: "assistant_result", ...result });
      }
      void flushPendingInjectedTexts();
      return;
    }
    void tryAutoConnect();
    void flushPendingInjectedTexts();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    applyCompactingState(true, ctx);
    event.signal.addEventListener(
      "abort",
      () => applyCompactingState(false, state.lastCtx ?? ctx),
      { once: true },
    );
  });

  pi.on("session_compact", async (event, ctx) => {
    state.awaitingRetry = event.willRetry;
    if (event.willRetry) state.busy = true;
    clearCompactionResetTimer();
    state.compactionResetTimer = setTimeout(() => {
      state.compactionResetTimer = null;
      applyCompactingState(false, state.lastCtx ?? ctx);
    }, COMPACTION_RELEASE_DELAY_MS);
    state.compactionResetTimer.unref?.();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopAutoConnectLoop();
    clearPendingInjectedFlushTimer();
    clearCompactionResetTimer();
    state.busy = false;
    state.compacting = false;
    state.awaitingRetry = false;
    lastAgentEndMessages = undefined;
    state.pendingInjectedTexts = [];
    disconnect(false);
    state.lastCtx = null;
  });

  pi.registerCommand("telegram", {
    description: "Telegram bridge: /telegram pair | status | unpair",
    getArgumentCompletions: getTelegramArgumentCompletions,
    handler: async (args, ctx: ExtensionCommandContext) => {
      const [sub] = parseArgs(args);

      const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
      };

      if (!sub || sub === "help") {
        notify("Usage: /telegram pair | status | unpair", "info");
        return;
      }

      if (sub === "status") {
        const cfg = await loadConfig();
        const tokenInfo = await resolveTelegramBotToken();
        const tokenState = tokenInfo.token ? tokenInfo.source : "missing";
        const paired = cfg.pairedChatId !== undefined ? `paired (${cfg.pairedChatId})` : "unpaired";
        const daemonUp = await canConnectSocket();

        const lines = [
          `Token: ${tokenState}`,
          `Pairing: ${paired}`,
          `Daemon: ${daemonUp ? "running" : "not running"}`,
          `This window: ${isSocketConnected() && state.sessionNo !== null ? `connected (session ${state.sessionNo})` : "not connected"}`,
        ];
        notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "unpair") {
        const cfg = await loadConfig();
        const tokenInfo = await resolveTelegramBotToken();
        if (cfg.pairedChatId !== undefined) {
          delete cfg.pairedChatId;
          await saveConfig(buildPersistedConfig(cfg, tokenInfo.source));
        }

        if (await canConnectSocket()) {
          try {
            await sendEphemeral({ type: "shutdown" });
          } catch {
            // ignore
          }
        }

        disconnect();

        notify(
          "Unpaired Telegram and disconnected all sessions. Run /telegram pair to pair again.",
          "info",
        );
        return;
      }

      if (sub === "pair") {
        const cfg = await loadConfig();
        const tokenInfo = await resolveTelegramBotToken();
        if (!tokenInfo.token) {
          if (!ctx.hasUI) {
            throw new Error(`Missing bot token. ${describeTelegramBotTokenSetup()}`);
          }
          const promptLocation = canUseTelegramKeychain()
            ? "saved to macOS Keychain"
            : `stored in ${CONFIG_PATH}`;
          const token = await withPromptSignal(pi, () =>
            ctx.ui.input("Telegram bot token", `Paste the bot token (${promptLocation})`),
          );
          if (!token) {
            notify("Cancelled.", "info");
            return;
          }
          if (canUseTelegramKeychain()) {
            await saveTelegramBotTokenToKeychain(token.trim());
            await clearTelegramConfigBotToken();
          } else {
            await saveConfig({ ...cfg, botToken: token.trim() });
          }
        }

        const connectResult = await runWithLoader(
          ctx,
          "Connecting to Telegram daemon...",
          (signal) => connectPersistent(ctx, { signal, ensureDaemon: true }),
        );
        if (connectResult.cancelled) {
          notify("Cancelled.", "info");
          return;
        }
        if (connectResult.error) {
          notify(`Failed to connect: ${connectResult.error}`, "error");
          return;
        }

        updateMeta(ctx);
        if (ctx.hasUI && state.sessionNo !== null) {
          ctx.ui.setStatus("telegram", connectedStatusText(ctx, state.sessionNo));
        }

        const freshCfg = await loadConfig();
        if (!freshCfg.pairedChatId) {
          const pinResult = await runWithLoader(
            ctx,
            "Requesting Telegram pairing PIN...",
            (signal) => requestPin(signal),
          );
          if (pinResult.cancelled) {
            notify("Cancelled.", "info");
            return;
          }
          if (pinResult.error) {
            notify(`Failed to request PIN: ${pinResult.error}`, "error");
            return;
          }

          const pin = pinResult.value;
          if (!pin) {
            notify("Failed to request PIN from daemon.", "error");
            return;
          }

          if (ctx.hasUI) {
            ctx.ui.notify(`Send this in Telegram: /pin ${pin.code} (valid 60s)`, "info");
            ctx.ui.setWidget("telegram", [
              `Telegram pairing: send /pin ${pin.code} (valid 60s)`,
              "All open pi windows will appear in Telegram /sessions as [window].",
              "Use /session N in Telegram to switch sessions.",
            ]);
          }
          return;
        }

        if (ctx.hasUI) {
          ctx.ui.setWidget("telegram", undefined);
        }
        notify("Paired. Use Telegram /sessions to access all sessions.", "info");
        return;
      }

      notify(`Unknown subcommand: ${sub}. Use /telegram help`, "error");
    },
  });
}
