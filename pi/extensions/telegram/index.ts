import { BorderedLoader, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { extractTextFromMessage } from "./message-text.mjs";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const RUN_DIR = path.join(AGENT_DIR, "run");
const SOCKET_PATH = path.join(RUN_DIR, "telegram.sock");
const CONFIG_DIR = path.join(AGENT_DIR, "telegram");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const AUTO_CONNECT_INTERVAL_MS = 3_000;
const COMPACTION_RELEASE_DELAY_MS = 500;
const COMPACTION_STALE_RESET_MS = 120_000;

type DaemonToClientMessage =
  | { type: "registered"; sessionNo: number }
  | { type: "pin"; code: string; expiresAt: number }
  | { type: "paired"; chatId: number }
  | { type: "error"; error: string }
  | { type: "inject"; text: string }
  | { type: "abort" };

type ClientToDaemonMessage =
  | { type: "register"; windowId: string; cwd: string; sessionName?: string; busy: boolean; compacting: boolean }
  | { type: "meta"; cwd: string; sessionName?: string; busy: boolean; compacting: boolean }
  | { type: "request_pin" }
  | { type: "shutdown" }
  | { type: "turn_end"; text: string };

type Config = {
  botToken?: string;
  pairedChatId?: number;
};

type PromptStatus = "completed" | "error";

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
  if (!ctx.hasUI) {
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

  const result = await ctx.ui.custom<{ cancelled: boolean; value?: T; error?: string }>((tui, theme, _kb, done) => {
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
  });

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

async function saveConfig(cfg: Config): Promise<void> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_PATH);
}

function parseArgs(args: string | undefined): string[] {
  if (!args) return [];
  const trimmed = args.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/g);
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
    pendingInjectedTexts: [] as string[],
    flushInjectedTextsPromise: null as Promise<void> | null,
    pendingInjectedFlushTimer: null as ReturnType<typeof setTimeout> | null,
    compactionResetTimer: null as ReturnType<typeof setTimeout> | null,
    lastCtx: null as ExtensionContext | null,
    connectPromise: null as Promise<void> | null,
    autoConnectTimer: null as ReturnType<typeof setInterval> | null,
  };

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
        const text = state.pendingInjectedTexts[0];
        if (!ctx || !text) return;
        if (state.compacting) return;
        if (ctx.isIdle() && ctx.hasPendingMessages()) {
          schedulePendingInjectedFlush(500);
          return;
        }

        try {
          if (ctx.isIdle()) {
            pi.sendUserMessage(text);
            state.pendingInjectedTexts.shift();
            if (state.pendingInjectedTexts.length > 0) {
              schedulePendingInjectedFlush(500);
            }
            return;
          }

          pi.sendUserMessage(text, { deliverAs: "followUp" });
          state.pendingInjectedTexts.shift();
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

  function updateMeta(ctx: ExtensionContext) {
    const sessionName = pi.getSessionName() ?? undefined;
    send({
      type: "meta",
      cwd: ctx.cwd,
      sessionName,
      busy: state.busy,
      compacting: state.compacting,
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
    if (!cfg.botToken || cfg.pairedChatId === undefined) return;

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

  async function requestPin(signal?: AbortSignal): Promise<{ code: string; expiresAt: number } | null> {
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

  function handleDaemonMessage(msg: DaemonToClientMessage) {
    for (const h of [...daemonMessageHandlers]) {
      try {
        h(msg);
      } catch {
        // ignore
      }
    }

    if (msg.type === "registered") {
      state.sessionNo = msg.sessionNo;
      stopAutoConnectLoop();
      if (state.lastCtx?.hasUI) {
        state.lastCtx.ui.setStatus("telegram", connectedStatusText(state.lastCtx, msg.sessionNo));
      }
      return;
    }

    if (msg.type === "paired") {
      if (state.lastCtx?.hasUI) {
        state.lastCtx.ui.setWidget("telegram", undefined);
      }
      return;
    }

    if (msg.type === "inject") {
      const text = msg.text;
      if (!text) return;
      state.pendingInjectedTexts.push(text);
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
      void flushPendingInjectedTexts();
      return;
    }
    void tryAutoConnect();
    void flushPendingInjectedTexts();
  });

  pi.on("agent_end", async (_event, ctx) => {
    state.busy = false;
    if (isSocketConnected()) {
      updateMeta(ctx);
      void flushPendingInjectedTexts();
      return;
    }
    void tryAutoConnect();
    void flushPendingInjectedTexts();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    applyCompactingState(true, ctx);
    event.signal.addEventListener("abort", () => applyCompactingState(false, state.lastCtx ?? ctx), { once: true });
  });

  pi.on("session_compact", async (_event, ctx) => {
    clearCompactionResetTimer();
    state.compactionResetTimer = setTimeout(() => {
      state.compactionResetTimer = null;
      applyCompactingState(false, state.lastCtx ?? ctx);
    }, COMPACTION_RELEASE_DELAY_MS);
    state.compactionResetTimer.unref?.();
  });

  pi.on("turn_end", async (event: any) => {
    if (!isSocketConnected()) return;
    const text = extractTextFromMessage(event.message);
    if (!text) return;
    send({ type: "turn_end", text });
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopAutoConnectLoop();
    clearPendingInjectedFlushTimer();
    clearCompactionResetTimer();
    state.busy = false;
    state.compacting = false;
    state.pendingInjectedTexts = [];
    disconnect(false);
    state.lastCtx = null;
  });

  pi.registerCommand("telegram", {
    description: "Telegram bridge: /telegram pair | status | unpair",
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
        const tokenState = cfg.botToken ? "configured" : "missing";
        const paired = cfg.pairedChatId ? `paired (${cfg.pairedChatId})` : "unpaired";
        const daemonUp = await canConnectSocket();

        const lines = [
          `Config: token ${tokenState}, ${paired}`,
          `Daemon: ${daemonUp ? "running" : "not running"}`,
          `This window: ${isSocketConnected() && state.sessionNo !== null ? `connected (session ${state.sessionNo})` : "not connected"}`,
        ];
        notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "unpair") {
        const cfg = await loadConfig();
        if (cfg.pairedChatId !== undefined) {
          delete cfg.pairedChatId;
          await saveConfig(cfg);
        }

        if (await canConnectSocket()) {
          try {
            await sendEphemeral({ type: "shutdown" });
          } catch {
            // ignore
          }
        }

        disconnect();

        notify("Unpaired Telegram and disconnected all sessions. Run /telegram pair to pair again.", "info");
        return;
      }

      if (sub === "pair") {
        const cfg = await loadConfig();
        if (!cfg.botToken) {
          if (!ctx.hasUI) {
            throw new Error(`Missing botToken. Create ${CONFIG_PATH} with {"botToken": "..."}.`);
          }
          const token = await withPromptSignal(pi, () =>
            ctx.ui.input("Telegram bot token", "Paste the bot token (saved to ~/.pi/agent/telegram/config.json)"),
          );
          if (!token) {
            notify("Cancelled.", "info");
            return;
          }
          await saveConfig({ ...cfg, botToken: token.trim() });
        }

        const connectResult = await runWithLoader(ctx, "Connecting to Telegram daemon...", (signal) =>
          connectPersistent(ctx, { signal, ensureDaemon: true }),
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
          const pinResult = await runWithLoader(ctx, "Requesting Telegram pairing PIN...", (signal) =>
            requestPin(signal),
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
