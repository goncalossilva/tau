import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import TelegramBot from "node-telegram-bot-api";
import { extractTextFromMessage } from "./message-text.mjs";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const RUN_DIR = path.join(AGENT_DIR, "run");
const SOCKET_PATH = path.join(RUN_DIR, "telegram.sock");
const CONFIG_DIR = path.join(AGENT_DIR, "telegram");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const TELEGRAM_BOT_TOKEN_ENV = "PI_TELEGRAM_BOT_TOKEN";
const TELEGRAM_KEYCHAIN_SERVICE = "pi.telegram";
const TELEGRAM_KEYCHAIN_ACCOUNT = "bot-token";

const TELEGRAM_COMMANDS = [
  { command: "pin", description: "Pair this chat with pi using a 6-digit PIN" },
  { command: "session", description: "List, switch, create, or quit sessions" },
  { command: "esc", description: "Abort current run in active session" },
  { command: "unpair", description: "Unpair Telegram and terminate headless sessions" },
  { command: "help", description: "Show available commands" },
];

const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
const TELEGRAM_HTTP_TIMEOUT_MS = 35_000;
const POLLING_STOP_TIMEOUT_MS = 4_000;
const ACTIVITY_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;
const UNPAIRED_IDLE_SHUTDOWN_MS = 60_000;
const HEADLESS_START_TIMEOUT_MS = 10_000;
const HEADLESS_STOP_TIMEOUT_MS = 5_000;
const HEADLESS_ABORT_TIMEOUT_MS = 60_000;
const POST_COMPACTION_RETRY_GRACE_MS = 500;
const MAX_UNREAD_TURNS_PER_SESSION = 20;
const MAX_QUEUED_HEADLESS_PROMPTS = 20;
const RECENT_UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RECENT_UPDATES = 5_000;
const PI_EXECUTABLE = process.env.PI_TELEGRAM_PI_EXECUTABLE || "pi";
const PI_ENTRYPOINT = process.env.PI_TELEGRAM_PI_ENTRYPOINT?.trim() || undefined;
const RESOLVED_TMPDIR = await fsp.realpath(os.tmpdir()).catch(() => os.tmpdir());
const HEADLESS_SESSION_PATH_ERROR = "Path must start with / or ~ and refer to a directory.";

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function removeDirectoryIfEmpty(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath);
    if (!entries.length) {
      await fsp.rmdir(dirPath);
    }
  } catch {
    // ignore
  }
}

async function saveConfig(cfg) {
  const nextConfig = {};
  const botToken = typeof cfg?.botToken === "string" ? cfg.botToken.trim() : "";
  if (botToken) nextConfig.botToken = botToken;
  if (typeof cfg?.pairedChatId === "number") nextConfig.pairedChatId = cfg.pairedChatId;

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

function canUseTelegramKeychain() {
  return process.platform === "darwin";
}

async function runTelegramKeychainCommand(args) {
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

async function readTelegramBotTokenFromKeychain() {
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

function buildPersistedConfig(config, tokenSource) {
  const nextConfig = {};
  if (tokenSource === "config" && typeof config?.botToken === "string" && config.botToken.trim()) {
    nextConfig.botToken = config.botToken.trim();
  }
  if (typeof config?.pairedChatId === "number") nextConfig.pairedChatId = config.pairedChatId;
  return nextConfig;
}

async function resolveTelegramBotToken(config = undefined) {
  const envToken = process.env[TELEGRAM_BOT_TOKEN_ENV]?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const keychainToken = await readTelegramBotTokenFromKeychain();
  if (keychainToken) return { token: keychainToken, source: "keychain" };

  const loadedConfig = config ?? (await loadConfig());
  const configuredToken =
    typeof loadedConfig?.botToken === "string" ? loadedConfig.botToken.trim() : "";
  if (configuredToken) return { token: configuredToken, source: "config" };

  return { token: null, source: "missing" };
}

function describeTelegramBotTokenSetup() {
  if (canUseTelegramKeychain()) {
    return `Set ${TELEGRAM_BOT_TOKEN_ENV}, store it in macOS Keychain, or create ${CONFIG_PATH} with {"botToken": "..."}.`;
  }

  return `Set ${TELEGRAM_BOT_TOKEN_ENV} or create ${CONFIG_PATH} with {"botToken": "..."}.`;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function makeJsonlWriter(socket) {
  return (obj) => {
    try {
      socket.write(JSON.stringify(obj) + "\n");
    } catch {
      // ignore
    }
  };
}

function attachJsonlReader(stream, onMessage) {
  stream.setEncoding("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      onMessage(line);
    }
  });
}

function chunkText(text, max = 3500) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + max));
    i += max;
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isLikelyNetworkPollingError(error) {
  const message = errorMessage(error).toUpperCase();
  const networkCodes = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ESOCKETTIMEDOUT",
  ];

  return networkCodes.some((code) => message.includes(code));
}

function getCommandError(response, fallback) {
  if (response && typeof response.error === "string" && response.error.trim())
    return response.error.trim();
  return fallback;
}

function autoCancelExtensionUiRequest(request, write) {
  if (!request || request.type !== "extension_ui_request" || typeof request.id !== "string")
    return false;

  write({ type: "extension_ui_response", id: request.id, cancelled: true });
  return true;
}

function createHeadlessRpcClient(cwd) {
  const childArgs = PI_ENTRYPOINT ? [PI_ENTRYPOINT, "--mode", "rpc"] : ["--mode", "rpc"];
  const child = spawn(PI_EXECUTABLE, childArgs, {
    cwd,
    env: { ...process.env, PI_TELEGRAM_DISABLE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const write = child.stdin
    ? makeJsonlWriter(child.stdin)
    : () => {
        throw new Error("Headless pi session transport is unavailable.");
      };
  const eventHandlers = new Set();
  const responseHandlers = new Set();
  const closeHandlers = new Set();
  const pending = new Map();
  const closed = Promise.withResolvers();
  let nextRequestId = 1;
  let stopPromise = null;
  let transportClosed = false;

  function createExitError(code, signal) {
    return new Error(
      `Headless pi session exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}`,
    );
  }

  function finishTransportClose(error, meta = { code: null, signal: null }) {
    if (transportClosed) return;
    transportClosed = true;

    const message = errorMessage(error);
    for (const { resolve, timeout } of pending.values()) {
      clearTimeout(timeout);
      resolve({ type: "response", success: false, error: message });
    }
    pending.clear();

    closed.resolve(meta);

    for (const handler of Array.from(closeHandlers)) {
      try {
        handler({ ...meta, error: message });
      } catch {
        // ignore
      }
    }
  }

  child.stdin?.on("error", () => {
    // handled by transport close
  });
  child.on("error", (error) => {
    finishTransportClose(error, { code: null, signal: null });
  });

  if (child.stdout) {
    attachJsonlReader(child.stdout, (line) => {
      const msg = safeJsonParse(line);
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "response") {
        for (const handler of Array.from(responseHandlers)) {
          try {
            handler(msg);
          } catch {
            // ignore
          }
        }

        const id = typeof msg.id === "string" ? msg.id : undefined;
        if (!id) return;
        const pendingRequest = pending.get(id);
        if (!pendingRequest) return;
        pending.delete(id);
        clearTimeout(pendingRequest.timeout);
        pendingRequest.resolve(msg);
        return;
      }

      if (msg.type === "extension_ui_request") {
        autoCancelExtensionUiRequest(msg, write);
        return;
      }

      for (const handler of Array.from(eventHandlers)) {
        try {
          handler(msg);
        } catch {
          // ignore
        }
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (!text) return;
      console.error(`[telegram/headless ${path.basename(cwd) || cwd}] ${text}`);
    });
  }

  child.once("close", (code, signal) => {
    finishTransportClose(createExitError(code, signal), { code, signal });
  });

  async function call(command, { timeoutMs = HEADLESS_START_TIMEOUT_MS } = {}) {
    if (child.exitCode !== null) {
      return {
        type: "response",
        success: false,
        error: `Headless pi session already exited with code ${child.exitCode}`,
      };
    }

    const id = `telegram-rpc-${nextRequestId++}`;
    const payload = { ...command, id };

    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve({
          type: "response",
          success: false,
          error: `Timed out waiting for ${command.type} response`,
        });
      }, timeoutMs);

      pending.set(id, { resolve, timeout });

      try {
        write(payload);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timeout);
        resolve({ type: "response", success: false, error: errorMessage(error) });
      }
    });
  }

  async function prompt(
    message,
    {
      streamingBehavior = "followUp",
      waitForStart = false,
      timeoutMs = HEADLESS_START_TIMEOUT_MS,
      onAccepted,
      onStarted,
      onFailed,
    } = {},
  ) {
    if (child.exitCode !== null) {
      throw new Error(`Headless pi session already exited with code ${child.exitCode}`);
    }

    const id = `telegram-rpc-${nextRequestId++}`;
    const payload = { type: "prompt", message, streamingBehavior, id };

    return await new Promise((resolve, reject) => {
      let accepted = false;
      let resolved = false;
      let trackingActive = true;
      const timeout = setTimeout(() => {
        cleanup();
        onFailed?.({
          type: "response",
          id,
          success: false,
          error: "Timed out waiting for prompt response",
        });
        reject(
          new Error(
            waitForStart
              ? "Timed out waiting for prompt to start"
              : "Timed out waiting for prompt response",
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        if (!trackingActive) return;
        trackingActive = false;
        clearTimeout(timeout);
        responseHandlers.delete(handleResponse);
        eventHandlers.delete(handleEvent);
        closeHandlers.delete(handleClose);
      };

      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        resolve({ id, success: true });
      };

      const rejectOnce = (error) => {
        if (resolved) return;
        resolved = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const handleResponse = (response) => {
        if (response.id !== id) return;

        if (response.success === false) {
          cleanup();
          onFailed?.(response);
          rejectOnce(
            new Error(getCommandError(response, "Failed to send prompt to headless session")),
          );
          return;
        }

        if (accepted) return;
        accepted = true;
        onAccepted?.(id);

        if (!waitForStart) {
          cleanup();
          resolveOnce();
        }
      };

      const handleEvent = (event) => {
        if (!accepted || event.type !== "agent_start") return;
        onStarted?.(id);
        cleanup();
        resolveOnce();
      };

      const handleClose = ({ error }) => {
        cleanup();
        onFailed?.({ type: "response", id, success: false, error });
        rejectOnce(new Error(error));
      };

      responseHandlers.add(handleResponse);
      eventHandlers.add(handleEvent);
      closeHandlers.add(handleClose);

      try {
        write(payload);
      } catch (error) {
        cleanup();
        onFailed?.({ type: "response", id, success: false, error: errorMessage(error) });
        rejectOnce(error);
      }
    });
  }

  async function stop() {
    if (stopPromise) return await stopPromise;

    stopPromise = (async () => {
      if (child.exitCode !== null) return;

      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }

      const result = await Promise.race([
        closed.promise,
        sleep(HEADLESS_STOP_TIMEOUT_MS).then(() => null),
      ]);

      if (result !== null) return;
      if (child.exitCode !== null) return;

      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }

      await Promise.race([closed.promise, sleep(1_000)]);
    })();

    return await stopPromise;
  }

  return {
    child,
    call,
    prompt,
    stop,
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onResponse(handler) {
      responseHandlers.add(handler);
      return () => responseHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
}

function normalizeHeadlessSessionPath(rawPath) {
  const trimmed = rawPath.trim();
  let expanded = trimmed;

  if (!expanded) {
    expanded = os.tmpdir();
  } else if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  } else if (!expanded.startsWith("/")) {
    throw new Error(HEADLESS_SESSION_PATH_ERROR);
  }

  return path.resolve(expanded);
}

async function inspectHeadlessSessionPath(rawPath) {
  const resolved = normalizeHeadlessSessionPath(rawPath);

  try {
    const stats = await fsp.stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error(HEADLESS_SESSION_PATH_ERROR);
    }

    const realPath = await fsp.realpath(resolved).catch(() => resolved);
    return { cwd: realPath, exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { cwd: resolved, exists: false };
    }
    if (error?.code === "ENOTDIR") {
      throw new Error(HEADLESS_SESSION_PATH_ERROR);
    }
    throw error;
  }
}

async function ensureHeadlessSessionPathExists(cwd) {
  await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
  return await fsp.realpath(cwd).catch(() => cwd);
}

let config = await loadConfig();
const botTokenInfo = await resolveTelegramBotToken(config);
if (!botTokenInfo.token) {
  console.error(`[telegram] Missing bot token. ${describeTelegramBotTokenSetup()}`);
  process.exit(1);
}
config = buildPersistedConfig(config, botTokenInfo.source);

let bot = null;
const sessions = new Map();
let nextSessionNo = 1;
let pairedChatId = config.pairedChatId;

const chatState = {
  activeSessionKey: undefined,
  lastSeenSeqBySessionKey: {},
  lastActivityNotice: undefined,
};

const pendingPins = new Map();
const recentProcessedUpdates = new Map();
let pendingDirectoryCreation = null;

let shutdownTimer = null;
let typingTimer = null;
let server = null;
let shuttingDown = false;

function isAuthorizedChat(chatId) {
  return pairedChatId !== undefined && chatId === pairedChatId;
}

function getActiveSession() {
  if (!chatState.activeSessionKey) return null;
  return sessions.get(chatState.activeSessionKey) ?? null;
}

function getSessionByNo(sessionNo) {
  return [...sessions.values()].find((session) => session.sessionNo === sessionNo) ?? null;
}

function getSessionCallbackData(session) {
  return `session:${session.key}`;
}

function getSessionKeyFromCallbackData(callbackData) {
  const match = typeof callbackData === "string" ? callbackData.match(/^session:(.+)$/) : null;
  return match?.[1] ?? null;
}

function getDisplaySessionName(session) {
  if (typeof session.sessionName === "string" && session.sessionName.trim())
    return session.sessionName.trim();
  if (session.kind === "headless" && session.cwd === RESOLVED_TMPDIR) return "tmp";
  return path.basename(session.cwd || "") || session.cwd || "(unknown)";
}

function getUpdateDedupeKeyForMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  if (chatId === undefined || !Number.isInteger(messageId)) return null;
  return `message:${chatId}:${messageId}`;
}

function getUpdateDedupeKeyForCallbackQuery(query) {
  if (!query || typeof query !== "object") return null;
  if (typeof query.id !== "string" || !query.id) return null;
  return `callback:${query.id}`;
}

function markUpdateProcessed(updateKey, now = Date.now()) {
  recentProcessedUpdates.set(updateKey, now);

  for (const [key, timestamp] of recentProcessedUpdates) {
    if (
      now - timestamp <= RECENT_UPDATE_TTL_MS &&
      recentProcessedUpdates.size <= MAX_RECENT_UPDATES
    ) {
      break;
    }
    recentProcessedUpdates.delete(key);
  }
}

function wasUpdateProcessed(updateKey, now = Date.now()) {
  if (!updateKey) return false;

  const previous = recentProcessedUpdates.get(updateKey);
  if (previous !== undefined) {
    if (now - previous <= RECENT_UPDATE_TTL_MS) {
      return true;
    }
    recentProcessedUpdates.delete(updateKey);
  }

  markUpdateProcessed(updateKey, now);
  return false;
}

function getWindowSessionRef(update) {
  if (!update || typeof update !== "object") return null;
  if (typeof update.sessionId !== "string" || !update.sessionId) return null;

  return {
    sessionId: update.sessionId,
    sessionFile:
      typeof update.sessionFile === "string" && update.sessionFile.trim()
        ? update.sessionFile.trim()
        : undefined,
  };
}

function resetWindowSessionTurns(session) {
  session.lastTurnText = undefined;
  session.lastTurnSeq = 0;
  session.unreadTurns = [];
  session.droppedUnreadTurns = 0;
  chatState.lastSeenSeqBySessionKey[session.key] = 0;
  clearActivityNotice(session.key);
}

function updateWindowSessionRef(session, update) {
  const nextRef = getWindowSessionRef(update);
  if (!nextRef) return;

  const changed =
    session.piSessionId !== nextRef.sessionId || session.piSessionFile !== nextRef.sessionFile;

  session.piSessionId = nextRef.sessionId;
  session.piSessionFile = nextRef.sessionFile;

  if (changed) {
    resetWindowSessionTurns(session);
  }
}

function getUnreadCount(session) {
  const lastSeen = chatState.lastSeenSeqBySessionKey[session.key] ?? 0;
  return Math.max(0, session.lastTurnSeq - lastSeen);
}

function shouldSendActivityNotice(sessionKey, now = Date.now()) {
  const lastNotice = chatState.lastActivityNotice;
  if (!lastNotice) return true;
  if (lastNotice.sessionKey !== sessionKey) return true;
  return now - lastNotice.sentAt >= ACTIVITY_NOTICE_COOLDOWN_MS;
}

function recordActivityNotice(sessionKey, now = Date.now()) {
  chatState.lastActivityNotice = { sessionKey, sentAt: now };
}

function clearActivityNotice(sessionKey) {
  if (!sessionKey) return;
  if (chatState.lastActivityNotice?.sessionKey === sessionKey) {
    chatState.lastActivityNotice = undefined;
  }
}

function resolveSessionCompactionWaiters(session) {
  if (!session.compactionWaiters?.size) return;
  for (const waiter of session.compactionWaiters) {
    waiter.resolve();
  }
  session.compactionWaiters.clear();
}

function rejectSessionCompactionWaiters(session, error) {
  if (!session.compactionWaiters?.size) return;
  for (const waiter of session.compactionWaiters) {
    waiter.reject(error);
  }
  session.compactionWaiters.clear();
}

function waitForSessionCompactionToFinish(session) {
  if (!session.compacting) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (!session.compactionWaiters) {
      session.compactionWaiters = new Set();
    }

    session.compactionWaiters.add({ resolve, reject });
  });
}

function setSessionCompacting(session, compacting) {
  const next = Boolean(compacting);
  const previous = Boolean(session.compacting);
  if (previous === next) return;

  session.compacting = next;

  if (next) {
    if (pairedChatId) {
      botSendSystem(pairedChatId, `[session ${session.sessionNo}] compacting`).catch(() => {});
    }
    return;
  }

  resolveSessionCompactionWaiters(session);
}

async function waitForHeadlessSessionPromptWindow(session) {
  while (sessions.has(session.key)) {
    await refreshHeadlessSessionState(session).catch(() => {});

    const pendingMessageCount =
      typeof session.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
    const waitingForRetryStart = !session.busy && session.retryAfterCompactionUntil > Date.now();
    if (
      !session.compacting &&
      !waitingForRetryStart &&
      (session.busy || pendingMessageCount === 0)
    ) {
      return;
    }

    await sleep(100);
  }

  throw new Error("Session is no longer available.");
}

function markSessionSeen(session) {
  chatState.lastSeenSeqBySessionKey[session.key] = session.lastTurnSeq;
  session.unreadTurns = [];
  session.droppedUnreadTurns = 0;
}

function removeSession(sessionKey) {
  const session = sessions.get(sessionKey);
  if (!session) return null;

  sessions.delete(sessionKey);
  delete chatState.lastSeenSeqBySessionKey[sessionKey];

  if (chatState.activeSessionKey === sessionKey) {
    chatState.activeSessionKey = undefined;
  }

  clearActivityNotice(sessionKey);
  updateTypingIndicator();
  void maybeShutdownSoon();
  return session;
}

function stopTypingIndicator() {
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
}

function startTypingIndicator() {
  if (typingTimer) return;

  const tick = async () => {
    if (!bot || !pairedChatId) return;
    try {
      await bot.sendChatAction(pairedChatId, "typing");
    } catch {
      // ignore
    }
  };

  void tick();
  typingTimer = setInterval(() => {
    void tick();
  }, 4_000);
}

function updateTypingIndicator() {
  const session = getActiveSession();
  if (!pairedChatId || !session || !session.busy) {
    stopTypingIndicator();
    return;
  }
  startTypingIndicator();
}

async function setPairedChatId(chatId) {
  pairedChatId = chatId;
  config = buildPersistedConfig({ ...config, pairedChatId: chatId }, botTokenInfo.source);
  await saveConfig(config);
  updateTypingIndicator();
}

async function clearPairing() {
  pairedChatId = undefined;
  const nextConfig = { ...config };
  delete nextConfig.pairedChatId;
  config = buildPersistedConfig(nextConfig, botTokenInfo.source);
  await saveConfig(config);
  chatState.activeSessionKey = undefined;
  chatState.lastSeenSeqBySessionKey = {};
  chatState.lastActivityNotice = undefined;
  updateTypingIndicator();
}

function disconnectAllWindowSessions() {
  for (const session of sessions.values()) {
    if (session.kind !== "window") continue;
    void session.quit();
  }
}

async function stopAllHeadlessSessions() {
  const headlessSessions = [...sessions.values()].filter((session) => session.kind === "headless");
  await Promise.all(
    headlessSessions.map(async (session) => {
      try {
        await session.quit();
      } catch {
        // ignore
      }
    }),
  );
}

async function stopPollingWithTimeout(reason) {
  if (!bot) return;

  const stopPromise = bot.stopPolling({ cancel: true, reason }).catch(() => {});
  await Promise.race([stopPromise, sleep(POLLING_STOP_TIMEOUT_MS)]);
}

async function shutdownDaemon({ clearPairingState = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelShutdown();

  if (clearPairingState) {
    try {
      await clearPairing();
    } catch {
      // ignore
    }
  }

  stopTypingIndicator();

  try {
    await stopAllHeadlessSessions();
  } catch {
    // ignore
  }

  disconnectAllWindowSessions();
  sessions.clear();
  chatState.activeSessionKey = undefined;
  chatState.lastSeenSeqBySessionKey = {};
  chatState.lastActivityNotice = undefined;

  try {
    await stopPollingWithTimeout("Telegram daemon shutdown");
  } catch {
    // ignore
  }

  if (server) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      try {
        server.close(() => finish());
      } catch {
        finish();
      }

      setTimeout(finish, 200);
    });
  }

  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }

  process.exit(0);
}

function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function botSend(chatId, text, opts = {}) {
  if (!bot) return;
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, opts);
  }
}

async function botSendAssistant(chatId, text) {
  if (!bot) return;

  if (text.length <= 3500) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return;
    } catch {
      // fall back to plain text
    }
  }

  await botSend(chatId, text);
}

async function botSendSystem(chatId, text) {
  if (!bot) return;
  const safe = escapeHtml(text);
  await bot.sendMessage(chatId, `<i>${safe}</i>`, { parse_mode: "HTML" });
}

async function syncBotCommands() {
  if (!bot) return;
  try {
    await bot.setMyCommands(TELEGRAM_COMMANDS);
  } catch (error) {
    console.error(`[telegram] Failed to sync bot commands: ${errorMessage(error)}`);
  }
}

async function sendSessionList(chatId) {
  await refreshHeadlessSessionStates([...sessions.values()]);

  const list = [...sessions.values()].sort((a, b) => a.sessionNo - b.sessionNo);
  if (list.length === 0) {
    await botSend(chatId, "No sessions. Use /session new [path] to start one.");
    return;
  }

  const lines = [];
  for (const session of list) {
    const active = chatState.activeSessionKey === session.key ? " *" : "";
    const unread = getUnreadCount(session);
    const unreadStr = unread > 0 ? ` [${unread} unread]` : "";
    lines.push(
      `${session.sessionNo}) ${getDisplaySessionName(session)} [${session.kind}]${active}${unreadStr}`,
    );
  }

  const buttons = list.map((session) => {
    const name = getDisplaySessionName(session);
    const label =
      name.length > 15
        ? `${session.sessionNo}: ${name.slice(0, 13)}…`
        : `${session.sessionNo}: ${name}`;
    return { text: label, callback_data: getSessionCallbackData(session) };
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  await botSend(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: rows },
  });
}

async function replayUnreadOrLatest(session, chatId) {
  if (session.droppedUnreadTurns > 0) {
    await botSendSystem(chatId, "Some older unread replies were omitted.");
  }

  if (session.unreadTurns.length > 0) {
    for (const turn of session.unreadTurns) {
      await botSendAssistant(chatId, turn.text);
    }
    markSessionSeen(session);
    return;
  }

  if (session.lastTurnText) {
    markSessionSeen(session);
    await botSendAssistant(chatId, session.lastTurnText);
    return;
  }

  markSessionSeen(session);
  await botSendSystem(chatId, "(No completed turns yet in this session.)");
}

async function activateSession(chatId, session) {
  await refreshHeadlessSessionState(session);

  chatState.activeSessionKey = session.key;
  chatState.lastActivityNotice = undefined;
  updateTypingIndicator();

  await botSendSystem(
    chatId,
    `Switched to session ${session.sessionNo}: ${getDisplaySessionName(session)} [${session.kind}]`,
  );
  await replayUnreadOrLatest(session, chatId);
}

async function switchSession(chatId, sessionNo) {
  const target = getSessionByNo(sessionNo);
  if (!target) {
    await botSend(chatId, `No such session: ${sessionNo}. Use /session to list.`);
    return;
  }

  await activateSession(chatId, target);
}

async function refreshHeadlessSessionState(session) {
  if (!session || session.kind !== "headless") return;
  const response = await session.rpc.call(
    { type: "get_state" },
    { timeoutMs: HEADLESS_START_TIMEOUT_MS },
  );
  if (!response.success) return;

  const data = response.data ?? {};
  if (typeof data.sessionName === "string" && data.sessionName.trim()) {
    session.sessionName = data.sessionName.trim();
  } else if (session.sessionName) {
    session.sessionName = undefined;
  }

  if (typeof data.isStreaming === "boolean") {
    session.busy = data.isStreaming;
    updateTypingIndicator();
  }

  if (typeof data.pendingMessageCount === "number") {
    session.pendingMessageCount = data.pendingMessageCount;
  }

  if (typeof data.isCompacting === "boolean") {
    setSessionCompacting(session, data.isCompacting);
  }
}

async function refreshHeadlessSessionStates(targets) {
  await Promise.all(
    targets
      .filter((session) => session.kind === "headless")
      .map((session) => refreshHeadlessSessionState(session).catch(() => {})),
  );
}

async function recordCompletedTurn(session, text) {
  if (!text.trim()) return;

  session.lastTurnText = text;
  session.lastTurnSeq += 1;

  if (!pairedChatId) return;

  if (chatState.activeSessionKey === session.key) {
    markSessionSeen(session);
    updateTypingIndicator();
    await botSendAssistant(pairedChatId, text);
    return;
  }

  session.unreadTurns.push({ seq: session.lastTurnSeq, text });
  while (session.unreadTurns.length > MAX_UNREAD_TURNS_PER_SESSION) {
    session.unreadTurns.shift();
    session.droppedUnreadTurns += 1;
  }

  const now = Date.now();
  if (shouldSendActivityNotice(session.key, now)) {
    const notice = escapeHtml(`[session ${session.sessionNo}] new reply available`);
    await botSend(pairedChatId, `<i>${notice}</i>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `Switch to session ${session.sessionNo}`,
              callback_data: getSessionCallbackData(session),
            },
          ],
        ],
      },
    });
    recordActivityNotice(session.key, now);
  }
}

async function createHeadlessSession(cwd) {
  const rpc = createHeadlessRpcClient(cwd);

  let stateResponse;
  try {
    const newSessionResponse = await rpc.call(
      { type: "new_session" },
      { timeoutMs: HEADLESS_START_TIMEOUT_MS },
    );
    if (!newSessionResponse.success) {
      throw new Error(getCommandError(newSessionResponse, "Failed to create headless session"));
    }
    if (newSessionResponse.data?.cancelled) {
      throw new Error("Headless session creation was cancelled.");
    }

    stateResponse = await rpc.call({ type: "get_state" }, { timeoutMs: HEADLESS_START_TIMEOUT_MS });
    if (!stateResponse.success) {
      throw new Error(getCommandError(stateResponse, "Failed to inspect headless session state"));
    }
  } catch (error) {
    await rpc.stop().catch(() => {});
    throw error;
  }

  const session = {
    key: `headless:${randomUUID()}`,
    sessionNo: nextSessionNo++,
    kind: "headless",
    cwd,
    sessionName:
      typeof stateResponse.data?.sessionName === "string" && stateResponse.data.sessionName.trim()
        ? stateResponse.data.sessionName.trim()
        : undefined,
    busy: Boolean(stateResponse.data?.isStreaming),
    compacting: Boolean(stateResponse.data?.isCompacting),
    pendingMessageCount: Number.isFinite(stateResponse.data?.pendingMessageCount)
      ? stateResponse.data.pendingMessageCount
      : 0,
    retryAfterCompactionUntil: 0,
    lastTurnText: undefined,
    lastTurnSeq: 0,
    unreadTurns: [],
    droppedUnreadTurns: 0,
    child: rpc.child,
    rpc,
    closing: false,
    queuedPromptCount: 0,
    pendingSendCount: 0,
    compactionWaiters: new Set(),
    sendQueue: Promise.resolve(),
    async sendText(text) {
      const backlogSize = session.pendingSendCount + session.queuedPromptCount;
      if (backlogSize >= MAX_QUEUED_HEADLESS_PROMPTS) {
        throw new Error("Session is busy. Too many queued prompts. Wait for it to catch up.");
      }

      session.pendingSendCount += 1;
      const sendOperation = session.sendQueue
        .then(async () => {
          await waitForHeadlessSessionPromptWindow(session);

          const waitForStart = !session.busy;
          session.queuedPromptCount += 1;

          await rpc.prompt(text, {
            streamingBehavior: "followUp",
            waitForStart,
            timeoutMs: HEADLESS_START_TIMEOUT_MS,
            onFailed: () => {
              session.queuedPromptCount = Math.max(0, session.queuedPromptCount - 1);
            },
          });
        })
        .finally(() => {
          session.pendingSendCount = Math.max(0, session.pendingSendCount - 1);
        });

      session.sendQueue = sendOperation.catch(() => {});
      await sendOperation;
    },
    async abort() {
      const response = await rpc.call({ type: "abort" }, { timeoutMs: HEADLESS_ABORT_TIMEOUT_MS });
      if (!response.success) {
        throw new Error(getCommandError(response, "Failed to abort headless session"));
      }
    },
    async quit() {
      if (session.closing) return;
      session.closing = true;
      try {
        await session.abort();
      } catch {
        // ignore
      }
      await rpc.stop();
    },
  };

  sessions.set(session.key, session);

  rpc.onEvent((event) => {
    if (!sessions.has(session.key)) return;

    if (event.type === "compaction_start") {
      session.retryAfterCompactionUntil = 0;
      setSessionCompacting(session, true);
      return;
    }

    if (event.type === "compaction_end") {
      session.retryAfterCompactionUntil = event.willRetry
        ? Date.now() + POST_COMPACTION_RETRY_GRACE_MS
        : 0;
      setSessionCompacting(session, false);
      return;
    }

    if (event.type === "agent_start") {
      session.retryAfterCompactionUntil = 0;
      session.queuedPromptCount = Math.max(0, session.queuedPromptCount - 1);
      session.busy = true;
      updateTypingIndicator();
      return;
    }

    if (event.type === "agent_end") {
      session.busy = false;
      updateTypingIndicator();
      return;
    }

    if (event.type === "turn_end") {
      const text = extractTextFromMessage(event.message);
      if (!text) return;
      void recordCompletedTurn(session, text).catch(() => {});
    }
  });

  rpc.onClose(() => {
    rejectSessionCompactionWaiters(session, new Error("Session ended while compacting."));
    const removed = removeSession(session.key);
    if (!removed || shuttingDown || session.closing) return;
    if (!pairedChatId) return;
    botSendSystem(
      pairedChatId,
      `Session ${session.sessionNo} ended: ${getDisplaySessionName(session)}`,
    ).catch(() => {});
  });

  updateTypingIndicator();
  return session;
}

async function createAndActivateHeadlessSession(chatId, cwd) {
  const session = await createHeadlessSession(cwd);
  chatState.activeSessionKey = session.key;
  chatState.lastActivityNotice = undefined;
  markSessionSeen(session);
  updateTypingIndicator();
  await botSendSystem(
    chatId,
    `Switched to session ${session.sessionNo}: ${getDisplaySessionName(session)} [headless]`,
  );
}

async function promptToCreateHeadlessSessionDirectory(chatId, cwd) {
  if (!bot) return;

  const prompt = [
    `Directory does not exist: ${cwd}`,
    "",
    "Reply to this message with Yes to create it.",
    "Any other reply cancels.",
  ].join("\n");

  const message = await bot.sendMessage(chatId, prompt, {
    reply_markup: {
      force_reply: true,
    },
  });

  pendingDirectoryCreation = {
    chatId,
    cwd,
    promptMessageId: message.message_id,
  };
}

function getPendingDirectoryCreationReply(msg) {
  if (!pendingDirectoryCreation) return null;
  if (msg.chat?.id !== pendingDirectoryCreation.chatId) return null;
  if (msg.reply_to_message?.message_id !== pendingDirectoryCreation.promptMessageId) return null;
  return pendingDirectoryCreation;
}

async function handlePendingDirectoryCreationReply(msg) {
  const pending = getPendingDirectoryCreationReply(msg);
  if (!pending) return false;

  pendingDirectoryCreation = null;

  if (!/^yes$/i.test((msg.text ?? "").trim())) {
    await botSendSystem(pending.chatId, `Cancelled directory creation: ${pending.cwd}`);
    return true;
  }

  try {
    const cwd = await ensureHeadlessSessionPathExists(pending.cwd);
    await createAndActivateHeadlessSession(pending.chatId, cwd);
  } catch (error) {
    await botSend(pending.chatId, errorMessage(error));
  }

  return true;
}

function broadcastToWindowSessions(msg) {
  for (const session of sessions.values()) {
    if (session.kind !== "window") continue;
    makeJsonlWriter(session.socket)(msg);
  }
}

async function handleSessionQuit(chatId, sessionNo) {
  const target = sessionNo === undefined ? getActiveSession() : getSessionByNo(sessionNo);
  if (!target) {
    await botSend(
      chatId,
      sessionNo === undefined
        ? "No active session. Use /session."
        : `No such session: ${sessionNo}. Use /session to list.`,
    );
    return;
  }

  if (target.kind === "window") {
    await botSend(chatId, "Cannot quit session attached to a window remotely.");
    return;
  }

  const wasActive = chatState.activeSessionKey === target.key;
  await target.quit();
  removeSession(target.key);

  await botSendSystem(chatId, `Quit session ${target.sessionNo}: ${getDisplaySessionName(target)}`);
  if (wasActive && sessions.size > 0) {
    await botSendSystem(chatId, "Use /session to choose another session.");
  }
}

function sessionHelpText() {
  return [
    "/session - list sessions",
    "/session new [path] - create a headless session in /path, ~/path, or the system temp directory if omitted; reply Yes to create a missing directory",
    "/session N - switch active session",
    "/session quit [N] - quit a headless session",
    "/esc - abort current run in active session",
    "/unpair - unpair Telegram and terminate headless sessions",
  ].join("\n");
}

async function handleTelegramMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  const text = msg.text ?? "";

  const pinMatch = text.match(/^\/pin\s+(\d{6})\s*$/);
  if (pinMatch) {
    const code = pinMatch[1];
    if (pairedChatId && pairedChatId !== chatId) {
      await botSend(chatId, "This bot is already paired with another chat.");
      return;
    }

    const pending = pendingPins.get(code);
    if (!pending) {
      await botSend(
        chatId,
        "Invalid or expired PIN. Run /telegram pair in pi to generate a new one.",
      );
      return;
    }
    if (Date.now() > pending.expiresAt) {
      pendingPins.delete(code);
      await botSend(chatId, "PIN expired. Run /telegram pair in pi to generate a new one.");
      return;
    }

    await setPairedChatId(chatId);
    pendingPins.delete(code);

    for (const session of sessions.values()) {
      markSessionSeen(session);
    }

    if (pending.sessionKey && sessions.has(pending.sessionKey)) {
      chatState.activeSessionKey = pending.sessionKey;
    }

    updateTypingIndicator();
    broadcastToWindowSessions({ type: "paired", chatId });

    await botSend(chatId, "Paired successfully. Use /session to list sessions.");
    return;
  }

  if (!isAuthorizedChat(chatId)) {
    await botSend(
      chatId,
      "Not paired. Run /telegram pair in pi to generate a PIN, then send /pin <PIN> here.",
    );
    return;
  }

  if (await handlePendingDirectoryCreationReply(msg)) {
    return;
  }

  if (!text) return;

  if (text === "/help") {
    await botSend(
      chatId,
      [
        "The following commands are available:",
        "",
        sessionHelpText(),
        "",
        "(plain text) - send to active session",
      ].join("\n"),
    );
    return;
  }

  if (text === "/session") {
    await sendSessionList(chatId);
    return;
  }

  if (text === "/sessions") {
    await botSend(chatId, "Unknown command. Use /session.");
    return;
  }

  const newMatch = text.match(/^\/session\s+new(?:\s+(.+))?\s*$/);
  if (newMatch) {
    if (pendingDirectoryCreation?.chatId === chatId) {
      await botSend(chatId, "Reply Yes or No to the pending folder-creation prompt first.");
      return;
    }

    try {
      const pathInfo = await inspectHeadlessSessionPath(newMatch[1] ?? "");
      if (!pathInfo.exists) {
        await promptToCreateHeadlessSessionDirectory(chatId, pathInfo.cwd);
        return;
      }

      await createAndActivateHeadlessSession(chatId, pathInfo.cwd);
    } catch (error) {
      await botSend(chatId, errorMessage(error));
    }
    return;
  }

  const quitMatch = text.match(/^\/session\s+quit(?:\s+(\d+))?\s*$/);
  if (quitMatch) {
    const sessionNo = quitMatch[1] ? Number(quitMatch[1]) : undefined;
    await handleSessionQuit(chatId, sessionNo);
    return;
  }

  const switchMatch = text.match(/^\/session\s+(\d+)\s*$/);
  if (switchMatch) {
    await switchSession(chatId, Number(switchMatch[1]));
    return;
  }

  if (/^\/session(?:\s|$)/.test(text)) {
    await botSend(chatId, sessionHelpText());
    return;
  }

  if (text === "/unpair") {
    try {
      await botSendSystem(
        chatId,
        "Unpaired Telegram. All sessions disconnected. Run /telegram pair in pi to pair again.",
      );
    } catch {
      // ignore
    }
    await shutdownDaemon({ clearPairingState: true });
    return;
  }

  if (text === "/esc") {
    const session = getActiveSession();
    if (!session) {
      await botSend(chatId, "No active session. Use /session.");
      return;
    }

    try {
      await session.abort();
    } catch (error) {
      await botSend(chatId, `Failed to abort session ${session.sessionNo}: ${errorMessage(error)}`);
    }
    return;
  }

  const session = getActiveSession();
  if (!session) {
    await botSend(chatId, "No active session. Use /session.");
    return;
  }

  try {
    await session.sendText(text);
  } catch (error) {
    await botSend(chatId, `Failed to send to session ${session.sessionNo}: ${errorMessage(error)}`);
  }
}

async function maybeShutdownSoon() {
  if (pairedChatId !== undefined) return;
  if (sessions.size > 0) return;
  if (shutdownTimer || shuttingDown) return;

  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (pairedChatId !== undefined || sessions.size > 0 || shuttingDown) return;
    console.error("[telegram] No sessions connected and daemon is unpaired, shutting down.");
    shutdownDaemon().catch(() => {});
  }, UNPAIRED_IDLE_SHUTDOWN_MS);
}

function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

async function startServer() {
  await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(SOCKET_PATH)) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(SOCKET_PATH);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) {
      console.error("[telegram] Daemon already running.");
      process.exit(0);
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
  }

  const srv = net.createServer((socket) => {
    cancelShutdown();

    const send = makeJsonlWriter(socket);
    let sessionKey;

    attachJsonlReader(socket, (line) => {
      const msg = safeJsonParse(line);
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "register": {
          const windowId = msg.windowId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          sessionKey = `window:${windowId}`;
          const existing = sessions.get(sessionKey);
          const sessionNo = existing?.sessionNo ?? nextSessionNo++;

          if (existing?.kind === "window" && existing.socket !== socket) {
            void existing.quit();
          }

          const session = {
            key: sessionKey,
            sessionNo,
            kind: "window",
            windowId,
            socket,
            cwd: msg.cwd,
            sessionName: msg.sessionName,
            busy: !!msg.busy,
            compacting: !!existing?.compacting,
            piSessionId: existing?.piSessionId,
            piSessionFile: existing?.piSessionFile,
            lastTurnText: existing?.lastTurnText,
            lastTurnSeq: existing?.lastTurnSeq ?? 0,
            unreadTurns: existing?.unreadTurns ?? [],
            droppedUnreadTurns: existing?.droppedUnreadTurns ?? 0,
            compactionWaiters: existing?.compactionWaiters ?? new Set(),
            sendQueue: existing?.sendQueue ?? Promise.resolve(),
            async sendText(text) {
              if (typeof session.piSessionId !== "string" || !session.piSessionId) {
                throw new Error("Window Pi session identity is not available yet.");
              }

              const injectId = randomUUID();
              const targetSessionId = session.piSessionId;
              const targetSessionFile = session.piSessionFile;
              const sendOperation = session.sendQueue.then(async () => {
                await waitForSessionCompactionToFinish(session);
                if (socket.destroyed) throw new Error("Session is no longer connected.");
                send({
                  type: "inject",
                  id: injectId,
                  text,
                  sessionId: targetSessionId,
                  sessionFile: targetSessionFile,
                });
              });

              session.sendQueue = sendOperation.catch(() => {});
              await sendOperation;
            },
            async abort() {
              if (socket.destroyed) throw new Error("Session is no longer connected.");
              send({ type: "abort" });
            },
            async quit() {
              try {
                socket.end();
              } catch {
                // ignore
              }
              try {
                socket.destroy();
              } catch {
                // ignore
              }
            },
          };

          sessions.set(sessionKey, session);
          updateWindowSessionRef(session, msg);
          setSessionCompacting(session, !!msg.compacting);
          send({ type: "registered", sessionNo });
          updateTypingIndicator();
          break;
        }

        case "meta": {
          if (!sessionKey) break;
          const session = sessions.get(sessionKey);
          if (!session) break;
          session.cwd = msg.cwd ?? session.cwd;
          session.sessionName = msg.sessionName ?? session.sessionName;
          session.busy = !!msg.busy;
          updateWindowSessionRef(session, msg);
          if (typeof msg.compacting === "boolean") {
            setSessionCompacting(session, msg.compacting);
          }
          if (chatState.activeSessionKey === sessionKey) updateTypingIndicator();
          break;
        }

        case "inject_result": {
          if (!sessionKey) break;
          const session = sessions.get(sessionKey);
          if (!session || session.kind !== "window") break;
          if (msg.status !== "rejected" || !pairedChatId) break;

          const reason =
            typeof msg.reason === "string" && msg.reason.trim()
              ? msg.reason.trim()
              : "Telegram message was not delivered.";
          botSendSystem(pairedChatId, `[session ${session.sessionNo}] ${reason}`).catch(() => {});
          break;
        }

        case "request_pin": {
          if (!sessionKey) {
            send({ type: "error", error: "not_registered" });
            break;
          }

          let code;
          for (let i = 0; i < 10; i++) {
            code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
            if (!pendingPins.has(code)) break;
          }

          const expiresAt = Date.now() + 60_000;
          pendingPins.set(code, { sessionKey, expiresAt });

          const cleanupTimer = setTimeout(() => {
            const pending = pendingPins.get(code);
            if (pending && pending.expiresAt <= Date.now()) {
              pendingPins.delete(code);
            }
          }, 60_000);
          cleanupTimer.unref?.();

          send({ type: "pin", code, expiresAt });
          break;
        }

        case "shutdown": {
          shutdownDaemon({ clearPairingState: true }).catch(() => {});
          break;
        }

        case "turn_end": {
          if (!sessionKey) break;
          const session = sessions.get(sessionKey);
          if (!session) break;
          const text = typeof msg.text === "string" ? msg.text : "";
          if (!text.trim()) break;
          void recordCompletedTurn(session, text).catch(() => {});
          break;
        }

        default:
          break;
      }
    });

    socket.on("close", () => {
      if (!sessionKey) {
        void maybeShutdownSoon();
        return;
      }

      const current = sessions.get(sessionKey);
      if (current && current.kind === "window" && current.socket === socket) {
        rejectSessionCompactionWaiters(current, new Error("Session ended while compacting."));
        removeSession(sessionKey);
      }

      void maybeShutdownSoon();
    });

    socket.on("error", () => {
      // handled by close
    });
  });

  await new Promise((resolve, reject) => {
    const onErr = (error) => {
      srv.off("listening", onListen);
      reject(error);
    };
    const onListen = () => {
      srv.off("error", onErr);
      resolve();
    };
    srv.once("error", onErr);
    srv.once("listening", onListen);
    srv.listen(SOCKET_PATH);
  });

  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {
    // ignore
  }

  return srv;
}

server = await startServer();

bot = new TelegramBot(botTokenInfo.token, {
  polling: {
    params: {
      timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
    },
  },
  request: {
    timeout: TELEGRAM_HTTP_TIMEOUT_MS,
  },
});

void syncBotCommands();
// node-telegram-bot-api already retries failed polls. Avoid stop/start
// recovery here: cancelling an in-flight poll can spin up overlapping
// pollers and replay the same Telegram update multiple times.
bot.on("polling_error", (error) => {
  const message = errorMessage(error);
  const kind = isLikelyNetworkPollingError(error) ? "polling_error (network)" : "polling_error";
  console.error(`[telegram] ${kind}: ${message}`);
});

bot.on("message", (msg) => {
  const updateKey = getUpdateDedupeKeyForMessage(msg);
  if (wasUpdateProcessed(updateKey)) {
    return;
  }

  handleTelegramMessage(msg).catch((error) =>
    console.error("[telegram] telegram handler error", error),
  );
});

bot.on("callback_query", (query) => {
  const updateKey = getUpdateDedupeKeyForCallbackQuery(query);
  if (wasUpdateProcessed(updateKey)) {
    return;
  }

  (async () => {
    const chatId = query.message?.chat?.id;
    if (!chatId || !isAuthorizedChat(chatId)) {
      try {
        await bot.answerCallbackQuery(query.id, { text: "Not authorized" });
      } catch {}
      return;
    }

    const sessionKey = getSessionKeyFromCallbackData(query.data);
    if (!sessionKey) {
      try {
        await bot.answerCallbackQuery(query.id);
      } catch {}
      return;
    }

    const session = sessions.get(sessionKey);
    if (!session) {
      try {
        await bot.answerCallbackQuery(query.id, {
          text: "That session is no longer available. Use /session.",
        });
      } catch {}
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
    } catch {}
    await activateSession(chatId, session);
  })().catch((error) => console.error("[telegram] callback query error", error));
});

updateTypingIndicator();

process.on("SIGINT", () => {
  shutdownDaemon().catch(() => {});
});

process.on("SIGTERM", () => {
  shutdownDaemon().catch(() => {});
});

console.error(`[telegram] Daemon running. Socket: ${SOCKET_PATH}`);
