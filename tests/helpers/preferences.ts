import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";

const fork = childProcess.fork;
type Notice = { message: string; type?: string };
type Message = {
  event: string;
  id?: number;
  status?: string;
  notices?: Notice[];
  payload?: unknown;
  error?: string;
};
type Options = { extension: string; command: string; agentDir: string; model: Model<Api> };

/** Independent Node/Pi sessions, with IPC ownership and joined teardown. No preference behavior is simulated. */
export function preferenceChild(options: Options) {
  const child = fork(fileURLToPath(import.meta.url), [JSON.stringify(options)], {
    cwd: options.agentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
    execArgv: ["--enable-source-maps"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data;
  });
  child.stderr?.on("data", (data) => {
    output += data;
  });
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  let closed = false;
  let killed = false;
  let exitCode: number | null = null;
  let failure: Error | undefined;
  const joined = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      closed = true;
      exitCode = code;
      failure ??= new Error(`Preference child closed (${code}, ${signal}) ${output}`);
      for (const listener of listeners) listener();
      resolve();
    });
  });
  child.on("message", (message: Message) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  let sequence = 0;
  function wait(event: string, id?: number): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Waiting for ${event}: ${output}`)), 15000);
      function finish(error?: Error, message?: Message) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error);
        else resolve(message!);
      }
      function check() {
        const fatal = messages.find((message) => message.event === "fatal");
        if (fatal) return finish(new Error(fatal.error));
        const index = messages.findIndex((message) => message.event === event && message.id === id);
        if (index !== -1) return finish(undefined, messages.splice(index, 1)[0]);
        if (
          event !== "done" &&
          messages.some((message) => message.event === "done" && message.id === id)
        ) {
          return finish(new Error(`Preference operation completed before ${event}`));
        }
        if (closed) finish(failure);
      }
      listeners.add(check);
      check();
    });
  }
  return {
    ready: () => wait("ready"),
    start(action: string, text?: string) {
      const id = ++sequence;
      child.send({ action, text, id });
      return { id, wait: (event = "done") => wait(event, id) };
    },
    async stop() {
      if (!closed && child.connected) {
        // Release any deliberate filesystem pause before asking Pi to shut down.
        child.send({ action: "resume-rename" });
        child.send({ action: "stop" });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await joined;
        if (!killed && exitCode !== 0) throw failure;
      } finally {
        clearTimeout(timer);
      }
    },
    async kill() {
      killed = true;
      if (!closed) child.kill("SIGKILL");
      await joined;
    },
  };
}

/** Run the real extension in a native Pi session. Filesystem wrappers only observe or pause real operations. */
async function runChild(options: Options) {
  const send = (message: Message) => process.send!(message);
  const failures: unknown[] = [];
  const rejectExternalWork = () => {
    const error = new Error("Unexpected external work in preference child");
    failures.push(error);
    throw error;
  };
  globalThis.fetch = rejectExternalWork;
  for (const method of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    Object.assign(childProcess, { [method]: rejectExternalWork });
  }
  let commandId: number | undefined;
  // Observe real failed mkdir attempts before proper-lockfile loads graceful-fs's native method copy.
  const mkdir = fs.mkdir;
  fs.mkdir = ((...args: unknown[]) => {
    const callback = args.pop() as (
      error: NodeJS.ErrnoException | null,
      ...values: unknown[]
    ) => void;
    const target = String(args[0]);
    Reflect.apply(mkdir, fs, [
      ...args,
      (error: NodeJS.ErrnoException | null, ...values: unknown[]) => {
        if (
          error?.code === "EEXIST" &&
          target.endsWith(`${options.command === "fast" ? "fast" : "openai-verbosity"}.json.lock`)
        ) {
          send({ event: "contended", id: commandId });
        }
        callback(error, ...values);
      },
    ]);
  }) as typeof fs.mkdir;
  const rename = fsPromises.rename;
  let pauseRename = false;
  let resumeRename: (() => void) | undefined;
  fsPromises.rename = async (from, to) => {
    if (pauseRename && String(to).endsWith(".json")) {
      pauseRename = false;
      await new Promise<void>((resolve) => {
        resumeRename = resolve;
        send({ event: "rename-ready", id: commandId });
      });
      resumeRename = undefined;
    }
    await rename(from, to);
  };
  syncBuiltinESMExports();
  const { createAgentSession, getAgentDir, initTheme } =
    await import("@earendil-works/pi-coding-agent");
  const { createPiResources, uiBoundary } = await import("./pi.js");
  const { lock } = await import("proper-lockfile");
  const { default: extension } = await import(options.extension);
  const cwd = path.join(getAgentDir(), `child-${process.pid}`);
  await fsPromises.mkdir(cwd, { recursive: true });
  const resources = await createPiResources(cwd, getAgentDir(), [
    extension,
    (pi) => {
      pi.registerProvider(options.model.provider, {
        baseUrl: options.model.baseUrl,
        apiKey: "fixture-only",
        models: [options.model],
      });
    },
  ]);
  const { session } = await createAgentSession({ ...resources, model: options.model, tools: [] });
  let release: (() => Promise<void>) | undefined;
  let operation: Promise<void> = Promise.resolve();
  const statuses = new Map<string, string | undefined>();
  const notices: Notice[] = [];
  try {
    initTheme("dark", false);
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => failures.push(error),
      uiContext: uiBoundary(
        {
          theme: session.extensionRunner.getUIContext().theme,
          setStatus: (key, value) => statuses.set(key, value),
          notify: (message, type) => notices.push({ message, type }),
        },
        failures,
      ),
    });
    await new Promise<void>((resolve, reject) => {
      process.on("message", (message: { action: string; text?: string; id?: number }) => {
        if (message.action === "resume-rename") {
          resumeRename?.();
          return;
        }
        if (message.action === "stop") {
          resumeRename?.();
          resolve();
          return;
        }
        operation = operation.then(async () => {
          commandId = message.id;
          notices.length = 0;
          switch (message.action) {
            case "command":
              await session.prompt(`/${options.command}${message.text ? ` ${message.text}` : ""}`, {
                source: "interactive",
              });
              await session.waitForIdle();
              break;
            case "reload":
              await session.reload();
              break;
            case "pause-rename":
              pauseRename = true;
              break;
            case "lock":
              release = await lock(message.text!, {
                onCompromised: (error) => failures.push(error),
              });
              break;
            default:
              throw new Error(`Unexpected action ${message.action}`);
          }
          const payload = await session.extensionRunner.emitBeforeProviderRequest({
            service_tier: "flex",
            verbosity: "medium",
            text: { verbosity: "medium", note: "café 🐙" },
          });
          if (failures.length) throw new AggregateError(failures, "Child boundary failures");
          const value = statuses.get(options.command === "fast" ? "fast" : "openai-verbosity");
          send({
            event: "done",
            id: message.id,
            notices: [...notices],
            payload,
            status: value === undefined ? undefined : stripVTControlCharacters(value),
          });
        });
        operation.catch(reject);
      });
      send({ event: "ready" });
    });
  } finally {
    resumeRename?.();
    try {
      await operation;
    } finally {
      try {
        await release?.();
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await resources.settingsManager.flush();
      } finally {
        session.dispose();
        process.disconnect();
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Child boundary failures");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runChild(JSON.parse(process.argv[2]) as Options);
  } catch (error) {
    if (process.connected)
      process.send?.({
        event: "fatal",
        error: error instanceof Error ? error.stack : String(error),
      });
    else console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
