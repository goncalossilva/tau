import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  SessionManager,
  type ExtensionFactory,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import caffeinate from "../extensions/caffeinate/index.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

describe("caffeinate", { concurrency: false }, () => {
  let directory: string;
  let failures: unknown[];
  let holders: ReturnType<typeof inhibitBoundary>;
  let apps: Awaited<ReturnType<typeof openCaffeinate>>[];
  let gates: ReturnType<typeof handshake>[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-caffeinate-"));
    failures = [];
    apps = [];
    gates = [];
    holders = inhibitBoundary(failures);
  });

  afterEach(async () => {
    try {
      // Unblock extension/provider/IPC handshakes before joining anything, including on assertion failure.
      for (const gate of gates) gate.resolve();
      for (const app of apps) app.releaseReplies();
      try {
        await holders.dispose();
        await deadline(Promise.all(apps.map((app) => app.dispose())));
      } finally {
        // Also join a child acquired by a previously blocked agent_start while runtime teardown drained.
        await holders.dispose();
      }
      assert.ok(
        holders.children.every((child) => child.closed),
        "every owned child was joined",
      );
      assert.deepEqual(failures, [], "unexpected external work and extension errors are failures");
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: one display-friendly holder covers streaming and the native follow-up queue`, async () => {
      holders.platform(platform);
      const first = reply("The octopus has checked the lifeboats.");
      const second = reply("The espresso machine has a life jacket too.");
      const app = await openCaffeinate(directory, failures, [first, second]);
      apps.push(app);
      assert.equal(holders.children.length, 0, "factory and session startup acquire nothing");
      assert.deepEqual(app.commands(), [], "no commands or configuration surface");
      const prompt = app.prompt("Check the café's lifeboats.");
      await deadline(first.started);
      const holder = await holders.ready(0);
      assertCommand(holder, platform, directory);
      await app.session.followUp("And the espresso machine?");
      assert.equal(app.session.isIdle, false);
      await holder.ping();

      first.finish();
      await deadline(second.started);
      assert.equal(holders.children.length, 1, "queued work does not replace the inhibitor");
      assert.equal(holder.closed, false);
      await holder.ping();
      second.finish();
      await deadline(prompt);
      await deadline(app.session.waitForIdle());
      assert.equal(holder.closed, true, "settlement joins the holder, not merely signals it");
      assert.deepEqual(
        holder.messages.filter((message) => message === "eof" || message === "term"),
        [platform === "linux" ? "eof" : "term"],
      );
      assert.equal(app.session.pendingMessageCount, 0);
      assert.equal(
        app.session.getLastAssistantText(),
        "The espresso machine has a life jacket too.",
      );
      assert.deepEqual(app.notifications, []);
      assert.equal(holders.stdout(), "");
      assert.equal(holders.stderr(), "");
    });
  }

  test("native retry and overflow compaction retain the same holder until the recovered answer settles", async () => {
    const unavailable = reply({
      ...assistantMessage(""),
      stopReason: "error",
      errorMessage: "503 overloaded",
    });
    const retried = reply("The life jackets are ready.");
    const overflow = reply({
      ...assistantMessage(""),
      stopReason: "error",
      errorMessage: "context_length_exceeded",
    });
    const summary = reply("The octopus is inspecting a floating café.");
    const recovered = reply("The café can safely set sail.");
    const app = await openCaffeinate(
      directory,
      failures,
      [unavailable, retried, overflow, summary, recovered],
      {
        settings: {
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
          compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 32 },
        },
        seed: true,
      },
    );
    apps.push(app);
    const prompt = app.prompt("Finish the safety check.");
    await deadline(unavailable.started);
    const holder = await holders.ready(0);
    unavailable.finish();
    await deadline(retried.started);
    assert.ok(app.events.includes("auto_retry_start"), "Pi, not the fixture, schedules the retry");
    assert.equal(app.session.isIdle, false);
    assert.equal(holders.children.length, 1);
    await holder.ping();
    await app.session.followUp("Inspect the espresso machine too.");
    retried.finish();
    await deadline(overflow.started);
    assert.equal(holders.children.length, 1);
    await holder.ping();
    overflow.finish();
    await deadline(summary.started);
    assert.ok(
      app.events.includes("compaction_start"),
      "native overflow recovery invokes summarization",
    );
    assert.equal(app.session.isIdle, false);
    assert.equal(holders.children.length, 1);
    await holder.ping();
    summary.finish();
    await deadline(recovered.started);
    assert.ok(app.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.equal(holders.children.length, 1);
    await holder.ping();
    recovered.finish();
    await deadline(prompt);
    await deadline(app.session.waitForIdle());
    assert.equal(holder.closed, true);
    assert.equal(app.events.filter((event) => event === "agent_settled").length, 1);
    assert.equal(app.session.getLastAssistantText(), "The café can safely set sail.");
  });

  test("cancellation, reload and shutdown join a stubborn holder by killing its process group", async () => {
    holders.platform("darwin");
    holders.behavior = "stubborn";
    for (const transition of ["cancel", "reload", "shutdown"] as const) {
      const response = reply();
      const next = reply("A fresh pot is brewing.");
      const app = await openCaffeinate(directory, failures, [response, next]);
      apps.push(app);
      const index = holders.children.length;
      const prompt = app.prompt(`Close the café via ${transition}.`);
      await deadline(response.started);
      const holder = await holders.ready(index);
      const work =
        transition === "cancel"
          ? app.session.abort()
          : transition === "reload"
            ? app.session.reload()
            : app.runtime.dispose();
      await deadline(work);
      assert.equal(
        holder.closed,
        true,
        `${transition} must await close, even when the child ignores SIGTERM`,
      );
      assert.ok(holder.messages.includes("term"), "graceful termination was attempted first");
      assert.equal(holder.child.signalCode, "SIGKILL");
      assert.ok(
        holders.signals.some(([pid, signal]) => pid === -holder.child.pid! && signal === "SIGKILL"),
      );
      response.finish();
      await deadline(prompt);
      if (transition !== "shutdown") {
        holders.behavior = "normal";
        const resumed = app.prompt("Brew a fresh pot.");
        await deadline(next.started);
        const replacement = await holders.ready(index + 1);
        assert.equal(holder.closed, true, "new acquisition cannot overlap prior release");
        next.finish();
        await deadline(resumed);
        assert.equal(replacement.closed, true);
        holders.behavior = "stubborn";
      }
      await app.dispose();
    }
  });

  test("shutdown invalidates an agent_start still draining through another native extension", async () => {
    const entered = handshake();
    const release = handshake();
    gates.push(release);
    const response = reply();
    const app = await openCaffeinate(directory, failures, [response], {
      before: (pi) =>
        pi.on("agent_start", async () => {
          entered.resolve();
          await release.promise;
        }),
    });
    apps.push(app);
    const prompt = app.prompt("Wait for the drawbridge.");
    await deadline(entered.promise);
    await deadline(app.runtime.dispose());
    assert.equal(holders.children.length, 0);
    release.resolve();
    response.finish();
    await deadline(prompt);
    assert.equal(holders.children.length, 0, "a late start cannot revive a shut-down factory");
  });

  test("missing utility warns once on headless stderr without affecting successful answers or stdout", async () => {
    holders.behavior = "missing";
    const responses = [reply(), reply()];
    const app = await openCaffeinate(directory, failures, responses, { mode: "print" });
    apps.push(app);
    for (const response of responses) {
      const prompt = app.prompt("Serve decaf even without a sleep inhibitor.");
      await deadline(response.started);
      await holders.joinAll();
      response.finish();
      await deadline(prompt);
      assert.equal(app.session.getLastAssistantText(), "The octopus approves the checklist.");
    }
    assert.ok(holders.children.length >= 1);
    assert.equal((holders.children[0].errors[0] as NodeJS.ErrnoException).code, "ENOENT");
    assert.match(holders.stderr(), /caffeinate/i);
    assert.equal(holders.stderr().trim().split("\n").length, 1, "one diagnostic per session");
    assert.equal(holders.stdout(), "", "no diagnostic bytes in headless result/protocol output");
    assert.deepEqual(app.notifications, []);
    assert.ok(
      holders.children.length <= 2,
      "at most one availability attempt per independent prompt",
    );
  });

  test("denied service and later unexpected exit warn once in the UI and never respawn during queued work", async () => {
    const first = reply();
    const continuation = reply();
    const later = reply();
    const app = await openCaffeinate(directory, failures, [first, continuation, later]);
    apps.push(app);
    const prompt = app.prompt("Inspect the café despite denied logind access.");
    await deadline(first.started);
    const denied = await holders.ready(0);
    await denied.send("denied");
    await deadline(denied.close);
    assert.equal(app.notifications.length, 1);
    assert.equal(app.notifications[0].type, "warning");
    assert.match(app.notifications[0].message, /caffeinate/i);
    await app.session.followUp("Inspect the roof too.");
    first.finish();
    await deadline(continuation.started);
    assert.equal(holders.children.length, 1, "no rapid respawn loop within the active workflow");
    continuation.finish();
    await deadline(prompt);
    assert.equal(app.session.getLastAssistantText(), "The octopus approves the checklist.");

    const fresh = app.prompt("An independent checklist may try again.");
    await deadline(later.started);
    if (holders.children.length > 1) {
      const unexpected = await holders.ready(1);
      await unexpected.send("exit");
      await deadline(unexpected.close);
    }
    later.finish();
    await deadline(fresh);
    assert.equal(app.notifications.length, 1, "subsequent failures do not nag again");
    assert.equal(app.session.getLastAssistantText(), "The octopus approves the checklist.");
    assert.equal(holders.stderr(), "");
    assert.equal(holders.stdout(), "");
  });

  test("concurrent native runtimes own independent cwd-bound holders without global process listeners", async () => {
    const listeners = ["exit", "beforeExit", "SIGINT", "SIGTERM", "SIGHUP"].map(
      (event) => [event, process.rawListeners(event)] as const,
    );
    const first = reply();
    const second = reply();
    const otherDirectory = path.join(directory, "neighboring-submarine");
    await mkdir(otherDirectory);
    const one = await openCaffeinate(directory, failures, [first]);
    apps.push(one);
    const two = await openCaffeinate(otherDirectory, failures, [second]);
    apps.push(two);
    const promptOne = one.prompt("Inspect the café.");
    await deadline(first.started);
    const holderOne = await holders.ready(0);
    const promptTwo = two.prompt("Inspect the submarine.");
    await deadline(second.started);
    const holderTwo = await holders.ready(1);
    assert.notEqual(holderOne.child.pid, holderTwo.child.pid);
    assertCommand(holderOne, "linux", directory);
    assertCommand(holderTwo, "linux", otherDirectory);
    for (const [event, original] of listeners)
      assert.deepEqual(process.rawListeners(event), original);

    await deadline(one.runtime.dispose());
    assert.equal(holderOne.closed, true);
    assert.equal(holderTwo.closed, false, "one session's shutdown cannot release another's holder");
    await holderTwo.ping();
    first.finish();
    second.finish();
    await deadline(Promise.all([promptOne, promptTwo]));
    assert.equal(holderTwo.closed, true);
    assert.equal(two.session.getLastAssistantText(), "The octopus approves the checklist.");
  });
});

/** Native Pi runtime, queues, retries and compaction; only provider generation and visible UI output are replaced. */
async function openCaffeinate(
  directory: string,
  failures: unknown[],
  replies: ReturnType<typeof reply>[],
  options: {
    mode?: "tui" | "print";
    settings?: Parameters<typeof SettingsManager.inMemory>[0];
    seed?: boolean;
    before?: ExtensionFactory;
  } = {},
) {
  let requests = 0;
  let commands!: () => unknown[];
  const notifications: { message: string; type: string | undefined }[] = [];
  const events: string[] = [];
  const history = SessionManager.inMemory(directory);
  if (options.seed) {
    history.appendMessage({
      role: "user",
      content: "Inspect a floating café. ".repeat(100),
      timestamp: 0,
    });
    history.appendMessage(assistantMessage("The octopus has packed life jackets. ".repeat(100)));
  }
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [
        ...(options.before ? [options.before] : []),
        caffeinate,
        (pi) => {
          commands = () => pi.getCommands();
          pi.registerProvider(fixtureModel.provider, {
            api: fixtureModel.api,
            baseUrl: fixtureModel.baseUrl,
            apiKey: "fixture-only",
            models: [fixtureModel],
            streamSimple: (_model, _context, streamOptions) => {
              const response = replies[requests++];
              if (!response) {
                const error = new Error("Unexpected model request in caffeinate workflow");
                failures.push(error);
                throw error;
              }
              return response.start(streamOptions?.signal);
            },
          });
        },
      ]);
      resources.settingsManager.applyOverrides(options.settings ?? {});
      return {
        ...(await createAgentSession({
          ...resources,
          sessionManager,
          sessionStartEvent,
          model: fixtureModel,
          tools: [],
        })),
        services: { ...resources, diagnostics: [] },
        diagnostics: [],
      };
    },
    { cwd: directory, agentDir: path.join(directory, "agent"), sessionManager: history },
  );
  const session = runtime.session;
  const unsubscribe = session.subscribe((event) => events.push(event.type));
  const pending: Promise<void>[] = [];
  const releaseReplies = () => {
    for (const response of replies)
      response.finish({ ...assistantMessage(""), stopReason: "aborted" });
  };
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    releaseReplies();
    session.clearQueue();
    try {
      await session.abort();
      await Promise.all(pending);
      await runtime.services.settingsManager.flush();
    } finally {
      await runtime.dispose();
      unsubscribe();
    }
  };
  try {
    await session.bindExtensions({
      mode: options.mode ?? "tui",
      ...(options.mode === "print"
        ? {}
        : {
            uiContext: uiBoundary(
              { notify: (message, type) => notifications.push({ message, type }) },
              failures,
            ),
          }),
      onError: (error) => failures.push(error),
    });
    return {
      runtime,
      session,
      events,
      notifications,
      commands,
      releaseReplies,
      dispose,
      prompt(text: string) {
        const work = session.prompt(text);
        // Observe early rejection while a test is waiting on a provider/child handshake; joins still rethrow it.
        void work.catch((error) => failures.push(error));
        pending.push(work);
        return work;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Route only unsafe inhibition executables to real Node children; retain real pipes, process groups, errors and close events. */
function inhibitBoundary(failures: unknown[]) {
  const spawn = childProcess.spawn.bind(childProcess);
  const kill = process.kill.bind(process);
  const children: ReturnType<typeof trackChild>[] = [];
  const signals: [number, NodeJS.Signals | number | undefined][] = [];
  let platform: "linux" | "darwin" = "linux";
  const reject = () => {
    const error = new Error("Unexpected subprocess or network request in caffeinate workflow");
    failures.push(error);
    throw error;
  };
  const boundary = {
    children,
    signals,
    behavior: "normal" as "normal" | "stubborn" | "missing",
    platform(value: typeof platform) {
      platform = value;
    },
    stdout: captureWrites(process.stdout),
    stderr: captureWrites(process.stderr),
    async ready(index: number) {
      const holder = children[index];
      assert.ok(holder, `holder ${index} was acquired on agent_start`);
      await deadline(holder.ready);
      return holder;
    },
    async joinAll() {
      await deadline(Promise.all(children.map((holder) => holder.close)));
    },
    async dispose() {
      for (const holder of children) {
        if (holder.closed) continue;
        if (holder.child.connected) holder.child.disconnect();
        holder.child.stdin?.destroy();
        if (holder.child.pid) {
          try {
            kill(-holder.child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      await boundary.joinAll();
    },
  };
  mock.method(globalThis, "fetch", reject);
  for (const method of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawnSync",
    "fork",
  ] as const) {
    mock.method(childProcess, method, reject);
  }
  mock.method(os, "platform", () => platform);
  mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push([pid, signal]);
    return kill(pid, signal);
  });
  mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
    if (command !== "/usr/bin/caffeinate" && command !== "systemd-inhibit") return reject();
    const stdio =
      typeof options.stdio === "string"
        ? [options.stdio, options.stdio, options.stdio]
        : (options.stdio ?? ["pipe", "pipe", "pipe"]);
    const child =
      boundary.behavior === "missing"
        ? spawn(path.join(String(options.cwd), "missing-caffeinate-executable"), [], options)
        : spawn(process.execPath, ["-e", holderScript, platform, boundary.behavior], {
            ...options,
            stdio: [...stdio.slice(0, 3), "ipc"],
          });
    children.push(trackChild(child, command, args, options));
    return child;
  });
  syncBuiltinESMExports();
  return boundary;
}

// IPC is a test-only fourth fd: normal Linux ownership still depends on the real stdin pipe reaching EOF.
const holderScript = `
const [platform, behavior] = process.argv.slice(1);
function report(message) { if (process.connected) process.send(message); }
function release(message) {
  report(message);
  if (behavior !== 'stubborn') process.disconnect();
}
process.on('SIGTERM', () => release('term'));
process.on('message', (message) => {
  if (message === 'ping') report('pong');
  if (message === 'exit' || message === 'denied') {
    if (message === 'denied') process.stderr.write('Failed to inhibit: Access denied\\n');
    process.exit(message === 'denied' ? 1 : 0);
  }
});
if (platform === 'linux') {
  process.stdin.resume();
  process.stdin.on('end', () => release('eof'));
}
report('ready');
`;

function trackChild(child: ChildProcess, command: string, args: string[], options: SpawnOptions) {
  const ready = handshake();
  const closed = handshake();
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let pong = handshake();
  const holder = {
    child,
    command,
    args,
    options,
    messages,
    errors,
    closed: false,
    ready: ready.promise,
    close: closed.promise,
    send(message: string) {
      return new Promise<void>((resolve, reject) =>
        child.send(message, (error) => (error ? reject(error) : resolve())),
      );
    },
    async ping() {
      pong = handshake();
      await holder.send("ping");
      await deadline(pong.promise);
      assert.equal(holder.closed, false, "the same inhibitor is still alive");
    },
  };
  child.on("error", (error) => errors.push(error));
  child.on("message", (message) => {
    messages.push(message);
    if (message === "ready") ready.resolve();
    if (message === "pong") pong.resolve();
  });
  child.once("close", () => {
    holder.closed = true;
    closed.resolve();
  });
  return holder;
}

function assertCommand(
  holder: ReturnType<typeof trackChild>,
  platform: "darwin" | "linux",
  cwd: string,
) {
  assert.equal(holder.command, platform === "darwin" ? "/usr/bin/caffeinate" : "systemd-inhibit");
  assert.deepEqual(
    holder.args,
    platform === "darwin"
      ? ["-i", "-w", String(process.pid)]
      : ["--what=sleep", "--mode=block", "--who=Pi", "--why=Pi agent is running", "--", "cat"],
  );
  assert.equal(holder.options.cwd, cwd);
  assert.equal(holder.options.detached, true);
  assert.ok(!holder.options.shell, "no shell or terminal wrapper");
  const stdio =
    typeof holder.options.stdio === "string"
      ? Array(3).fill(holder.options.stdio)
      : holder.options.stdio;
  assert.ok(Array.isArray(stdio));
  if (platform === "linux") assert.equal(stdio[0], "pipe");
  else assert.ok(stdio[0] === "ignore" || stdio[0] === "pipe");
  assert.equal(stdio[1], "ignore");
  assert.ok(stdio[2] === "ignore" || stdio[2] === "pipe", "stderr cannot reach the terminal");
}

/** Capture diagnostic bytes while preserving node:test's binary IPC output. */
function captureWrites(stream: NodeJS.WriteStream) {
  const chunks: string[] = [];
  const write = stream.write.bind(stream);
  mock.method(stream, "write", (...args: Parameters<typeof write>) => {
    if (typeof args[0] !== "string") return write(...args);
    chunks.push(args[0]);
    const callback = typeof args[1] === "function" ? args[1] : args[2];
    callback?.();
    return true;
  });
  return () => chunks.join("");
}

/** A cancellable native provider stream, explicitly released by the workflow or failure-safe teardown. */
function reply(message: string | AssistantMessage = "The octopus approves the checklist.") {
  const started = handshake();
  const stream = createAssistantMessageEventStream();
  let signal: AbortSignal | undefined;
  let finished = false;
  const finish = (result = typeof message === "string" ? assistantMessage(message) : message) => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      stream.push({ type: "error", reason: result.stopReason, error: result });
    } else {
      assert.ok(
        result.stopReason === "stop" ||
          result.stopReason === "length" ||
          result.stopReason === "toolUse",
      );
      stream.push({ type: "done", reason: result.stopReason, message: result });
    }
    stream.end();
  };
  const abort = () => finish({ ...assistantMessage(""), stopReason: "aborted" });
  return {
    started: started.promise,
    finish,
    start(abortSignal?: AbortSignal) {
      signal = abortSignal;
      if (!finished) {
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }
      started.resolve();
      return stream;
    },
  };
}

function handshake() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Deadlines detect missing handshakes, never assert elapsed time or replace lifecycle synchronization. */
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Caffeinate workflow did not reach completion")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
