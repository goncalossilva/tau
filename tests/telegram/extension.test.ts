import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fsp, { access, mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
  contentText,
  getCurrentTools,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider } from "../helpers/provider.js";
import { deadline } from "../helpers/async.js";
import { Type } from "typebox";
import { formatTelegramAssistantResultFromMessages } from "../../extensions/telegram/assistant-result.mjs";
import type {} from "./fixtures/reconnect-daemon.js";

const reply = "The otter keeps its report in the parent window.";
const spawn = childProcess.spawn;
const daemonFixture = fileURLToPath(new URL("./fixtures/reconnect-daemon.js", import.meta.url));

describe("Telegram extension launch and opt-out", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let telegram: typeof import("../../extensions/telegram/index.js").default;
  let previous: Record<string, string | undefined>;
  let failures: unknown[];
  let resources: Awaited<ReturnType<typeof createPiResources>> | undefined;
  let session: AgentSession | undefined;

  before(async () => {
    home = await isolatePiHome();
    telegram = (await import("../../extensions/telegram/index.js")).default;
  });

  after(async () => {
    await home.dispose();
  });

  beforeEach(() => {
    previous = Object.fromEntries(
      ["TAU_SUBAGENT_CHILD", "TAU_TELEGRAM_DISABLE", "TAU_TELEGRAM_BOT_TOKEN"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    delete process.env.TAU_SUBAGENT_CHILD;
    delete process.env.TAU_TELEGRAM_DISABLE;
    // A synthetic token avoids personal Keychain access even in the enabled parent case.
    process.env.TAU_TELEGRAM_BOT_TOKEN = "fixture-only-not-a-bot-token";
    failures = [];
    rejectExternalWork(failures);
    mock.timers.enable({ apis: ["setInterval"] });
  });

  afterEach(async () => {
    try {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await session.abort();
        await session.waitForIdle();
      }
      await resources?.settingsManager.flush();
      assert.deepEqual(failures, [], "unexpected external work and extension errors must fail");
    } finally {
      session?.dispose();
      session = undefined;
      resources = undefined;
      mock.timers.reset();
      mock.restoreAll();
      syncBuiltinESMExports();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(getAgentDir(), { recursive: true, force: true });
    }
  });

  test("pair forwards the owning runtime, entrypoint and native config directory to the daemon", async () => {
    const agentDir = getAgentDir();
    const cwd = path.join(agentDir, "otter-workshop");
    await mkdir(cwd, { recursive: true });
    const launches: Array<{ command: string; args: string[]; options: childProcess.SpawnOptions }> =
      [];
    stoppedDaemonSocket(agentDir);
    // Refuse the detached subprocess after inspecting the real command's launch boundary.
    mock.method(
      childProcess,
      "spawn",
      (command: string, args: string[], options: childProcess.SpawnOptions) => {
        launches.push({ command, args, options });
        throw new Error("Fixture refuses detached daemon startup");
      },
    );
    syncBuiltinESMExports();
    const session = await bindTelegram(cwd);
    await session.prompt("/telegram pair");

    assert.equal(launches.length, 1);
    const { command, args, options } = launches[0]!;
    assert.equal(command, process.execPath);
    assert.equal(path.basename(args[0]!), "daemon.mjs");
    assert.equal(args.length, 1);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(options.env?.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(options.env?.TAU_TELEGRAM_PI_ENTRYPOINT, process.argv[1] ?? "");
    assert.equal(options.env?.TAU_TELEGRAM_BOT_TOKEN, process.env.TAU_TELEGRAM_BOT_TOKEN);
    assert.deepEqual(
      Object.keys(options.env ?? {})
        .filter((key) => key.startsWith("TAU_TELEGRAM_"))
        .sort(),
      ["TAU_TELEGRAM_BOT_TOKEN", "TAU_TELEGRAM_PI_ENTRYPOINT", "TAU_TELEGRAM_STARTUP"],
    );
  });

  test(
    "background starts without an environment token leave Keychain lookup to the daemon",
    { skip: process.platform !== "darwin" && "macOS Keychain" },
    async () => {
      const { agentDir, cwd } = await pairedFiles();
      delete process.env.TAU_TELEGRAM_BOT_TOKEN;
      stoppedDaemonSocket(agentDir);
      let keychainReads = 0;
      let launches = 0;
      let launched!: () => void;
      const launchRefused = new Promise<void>((resolve) => (launched = resolve));
      // A background reconnect must leave credential lookup to the daemon.
      mock.method(
        childProcess,
        "execFile",
        (command: string, args: string[], _options: unknown, callback: Function) => {
          assert.equal(command, "security");
          assert.equal(args[0], "find-generic-password");
          keychainReads++;
          callback(null, "fixture-only-keychain-token\n");
        },
      );
      mock.method(childProcess, "spawn", () => {
        launches++;
        launched();
        throw new Error("Fixture refuses detached daemon startup");
      });
      syncBuiltinESMExports();
      const session = await bindTelegram(cwd);
      await launchRefused;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

      assert.equal(launches, 1);
      assert.equal(keychainReads, 0);
    },
  );

  test("automatically retries failed startup, preserves cooldown on reload, and recovers by polling", async () => {
    // Native intervals prove SDK liveness. Exact backoff/deadline boundaries use coordinator clocks.
    mock.timers.reset();
    const { agentDir, cwd } = await pairedFiles();
    const retryPath = path.join(agentDir, "run", "telegram-startup.json");
    const retried = completion();
    let available = false;
    let connections = 0;
    let connected = completion();
    substituteDaemonTransport(agentDir, failures, {
      available: () => available,
      // Automatic connection sends meta only after registration and retry-history reset finish.
      onMeta: () => {
        connections++;
        connected.resolve();
      },
    });
    let launches = 0;
    mock.method(childProcess, "spawn", () => {
      if (++launches === 2) retried.resolve();
      throw new Error("Fixture refuses detached daemon startup");
    });
    syncBuiltinESMExports();
    const session = await bindTelegram(cwd);
    await deadline(retried.promise, "second automatic startup without manual intervention");
    assert.equal(launches, 2);
    await session.reload(); // Joins the old failed attempt before replacing its extension instance.
    assert.equal(JSON.parse(await fsp.readFile(retryPath, "utf8")).failures, 2);

    await session.prompt("/telegram pair");
    assert.equal(launches, 3, "manual pairing bypasses the persisted automatic cooldown");
    available = true;
    await deadline(connected.promise, "automatic connection and retry-history reset");
    await assert.rejects(access(retryPath), { code: "ENOENT" });
    connected = completion();
    await session.reload();
    await deadline(connected.promise, "completed connection after reload");
    await assert.rejects(access(retryPath), { code: "ENOENT" });
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(connections, 2);
    assert.equal(launches, 3, "independent daemon recovery and reload need no additional launch");
  });

  for (const action of ["failure", "shutdown", "unpair"] as const) {
    test(`${action} joins owned startup${action === "unpair" ? "" : " and kills TERM-ignoring descendants after leader exit"}, without reviving reconnects`, async () => {
      const { agentDir, cwd, configPath } = await pairedFiles();
      const probes = stoppedDaemonSocket(agentDir);
      const descendant = action === "unpair" ? undefined : await descendantBoundary();
      const booted = completion();
      let child: childProcess.ChildProcess | undefined;
      let closed = false;
      let launches = 0;
      mock.method(
        childProcess,
        "spawn",
        (command: string, args: string[], options: childProcess.SpawnOptions) => {
          assert.equal(path.basename(args[0]!), "daemon.mjs");
          assert.equal(options.detached, true);
          assert.equal(++launches, 1, "Unexpected second owned startup");
          child = spawn(command, [daemonFixture], {
            ...options,
            env: { ...options.env, TELEGRAM_RECONNECT_DESCENDANT_SOCKET: descendant?.socketPath },
          });
          child.once("close", () => {
            closed = true;
          });
          child.on("message", (message) => {
            if ((message as { type: string }).type === "fixture_booted") booted.resolve();
          });
          return child;
        },
      );
      syncBuiltinESMExports();
      try {
        const session = await bindTelegram(cwd);
        await deadline(booted.promise, "owned daemon startup");
        if (descendant) {
          child!.send({ action: "spawn-descendant" });
          await descendant.ready();
        }
        if (action === "failure") {
          const close = once(child!, "close");
          child!.send({ action: "fail" });
          await deadline(close, "failed startup close");
          await descendant!.waitDead();
        }
        if (action === "unpair") await session.prompt("/telegram unpair");
        else await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        if (descendant) await descendant.waitDead();
        assert.equal(closed, true, "lifecycle completion must join the child's close event");
        await assert.rejects(access(path.join(agentDir, "run", "telegram-startup.json.lock")), {
          code: "ENOENT",
        });
        if (action === "unpair") await assert.rejects(access(configPath), { code: "ENOENT" });
        const configRead = action === "unpair" ? completion() : undefined;
        if (configRead) {
          const read = fsp.readFile;
          mock.method(fsp, "readFile", (target: string, ...options: unknown[]) => {
            const result = (read as Function)(target, ...options);
            return target === configPath ? result.finally(configRead.resolve) : result;
          });
        }
        const before = probes.count();
        mock.timers.tick(30_000);
        if (configRead) await deadline(configRead.promise, "post-unpair config poll");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(probes.count(), before);
        assert.equal(launches, 1);
      } finally {
        try {
          if (child && !closed) {
            const close = once(child, "close");
            killFixtureProcess(-child.pid!);
            await close;
          }
        } finally {
          await descendant?.dispose();
        }
      }
    });
  }

  for (const unpairFirst of [false, true]) {
    test(`single-flights before config IO and joins ${unpairFirst ? "pending unpair plus shutdown" : "shutdown"} while that read is blocked`, async () => {
      const { agentDir, cwd, configPath } = await pairedFiles();
      const bytes = JSON.stringify({ pairedChatId: 42 });
      const probes = stoppedDaemonSocket(agentDir);
      const started = completion();
      const released = completion();
      const read = fsp.readFile;
      let reads = 0;
      mock.method(fsp, "readFile", async (target: string, ...options: unknown[]) => {
        if (target === configPath) {
          reads++;
          started.resolve();
          await released.promise;
        }
        return (read as Function)(target, ...options);
      });
      syncBuiltinESMExports();
      try {
        const session = await bindTelegram(cwd);
        await deadline(started.promise, "blocked config read");
        mock.timers.tick(9_000);
        assert.equal(reads, 1, "three overlapping reconnect ticks share the first config read");
        assert.equal(probes.count(), 0);
        let unpaired = false;
        let stopped = false;
        const unpair = unpairFirst
          ? session.prompt("/telegram unpair").then(() => {
              unpaired = true;
            })
          : undefined;
        // Yield command continuations, not filesystem work: the only config read is still held.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(unpaired, false);
        const shutdown = session.extensionRunner
          .emit({ type: "session_shutdown", reason: "quit" })
          .then(() => {
            stopped = true;
          });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(stopped, false, "shutdown must join the blocked operation and pending unpair");
        released.resolve();
        await Promise.all([unpair, shutdown]);
        mock.timers.tick(30_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(reads, 1);
        assert.equal(probes.count(), 0);
        assert.equal(
          await read(configPath, "utf8"),
          bytes,
          "retired unpair must preserve exact pairing config",
        );
      } finally {
        released.resolve();
      }
    });
  }

  test("unpaired reconnect ticks neither read the token nor probe the daemon", async () => {
    const agentDir = getAgentDir();
    const cwd = path.join(agentDir, "otter-workshop");
    await mkdir(cwd, { recursive: true });
    delete process.env.TAU_TELEGRAM_BOT_TOKEN;
    const probes = stoppedDaemonSocket(agentDir);
    let keychainReads = 0;
    mock.method(
      childProcess,
      "execFile",
      (_command: string, _args: string[], _options: unknown, callback: Function) => {
        keychainReads++;
        callback(new Error("No otter token"), "");
      },
    );
    syncBuiltinESMExports();
    const session = await bindTelegram(cwd);
    mock.timers.tick(30_000);
    // The explicit status command is the only token read and daemon probe.
    await session.prompt("/telegram status");

    assert.equal(keychainReads, process.platform === "darwin" ? 1 : 0);
    assert.equal(probes.count(), 1);
  });

  for (const unavailable of ["unpaired", "missing capability", "disconnected"] as const) {
    test(`tree navigation reconciles live Telegram availability when ${unavailable}, preserving other branch tools`, async () => {
      const agentDir = getAgentDir();
      const cwd = path.join(agentDir, "otter-workshop");
      await mkdir(cwd, { recursive: true });
      const daemon = substituteDaemonTransport(agentDir, failures);
      const requests: TranscriptContext[] = [];
      resources = await createPiResources(cwd, agentDir, [
        telegram,
        scriptedProvider(fixtureModel, ({ context }) => {
          requests.push(context);
          return assistantMessage(reply);
        }),
      ]);
      ({ session } = await createAgentSession({ ...resources, model: fixtureModel }));
      await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
      session.setActiveToolsByName(["read"]);
      await session.prompt("Keep the otter's first report local.");
      const localLeaf = session.sessionManager.getLeafId()!;

      await session.prompt("/telegram pair");
      assert.deepEqual(session.getActiveToolNames().sort(), ["read", "telegram_send_file"]);
      session.setActiveToolsByName(["write", "telegram_send_file"]);
      await session.prompt("Prepare the next report for Telegram.");
      const telegramLeaf = session.sessionManager.getLeafId()!;

      await session.navigateTree(localLeaf, { summarize: false });
      assert.deepEqual(session.getActiveToolNames().sort(), ["read", "telegram_send_file"]);
      await session.prompt("Revisit the local report while Telegram is available.");

      if (unavailable === "disconnected") {
        await daemon.disconnect();
      } else {
        daemon.send({
          type: "registered",
          sessionNo: 8,
          paired: unavailable !== "unpaired",
          capabilities: unavailable === "missing capability" ? [] : ["send_file_queued"],
        });
      }
      assert.deepEqual(session.getActiveToolNames(), ["read"]);
      await session.navigateTree(telegramLeaf, { summarize: false });
      assert.deepEqual(session.getActiveToolNames(), ["write"]);
      await session.prompt("Revisit the writable report without Telegram.");
      assert.deepEqual(
        requests.map(({ messages }) =>
          getCurrentTools(messages)
            .map(({ name }) => name)
            .sort(),
        ),
        [["read"], ["telegram_send_file", "write"], ["read", "telegram_send_file"], ["write"]],
        "each provider sees the reconciled branch tools; commands and navigation add no turns",
      );
    });
  }

  for (const outcome of ["success", "cancel", "failure"] as const) {
    test(`retains window messages through ${outcome} of a held tree summary without false acceptance`, async () => {
      const agentDir = getAgentDir();
      const cwd = path.join(agentDir, "otter-workshop");
      await mkdir(cwd, { recursive: true });
      const acknowledged = completion();
      const delivered = completion();
      const daemon = substituteDaemonTransport(agentDir, failures, {
        onInjectResult: () => {
          if (daemon.injectResults.length === 4) acknowledged.resolve();
        },
      });
      const summaryStarted = completion();
      const releaseSummary = completion();
      let summarizing = false;
      const prompts: string[] = [];
      const first = "Telegram: check the otter's raft.";
      const second = "Telegram: bring the owl's life jacket.";
      resources = await createPiResources(cwd, agentDir, [
        telegram,
        scriptedProvider(fixtureModel, async ({ context }, signal) => {
          if (summarizing) {
            summaryStarted.resolve();
            await releaseSummary.promise;
            return {
              ...assistantMessage("The otter explored the kelp forest."),
              stopReason: signal?.aborted ? "aborted" : outcome === "failure" ? "error" : "stop",
              ...(outcome === "failure" ? { errorMessage: "Kelp summary unavailable" } : {}),
            };
          }
          const message = context.messages.findLast((candidate) => candidate.role === "user");
          assert.ok(message?.role === "user");
          const text = contentText(message.content);
          prompts.push(text);
          if (text === second) delivered.resolve();
          return assistantMessage(reply);
        }),
      ]);
      resources.settingsManager.applyOverrides({ retry: { enabled: false } });
      ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
      await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
      await session.prompt("Prepare the raft.");
      const target = session.sessionManager.getLeafId()!;
      await session.prompt("Explore the kelp forest.");
      const originalLeaf = session.sessionManager.getLeafId();
      await session.prompt("/telegram pair");
      mock.timers.reset();
      mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      summarizing = true;
      const navigation = session.navigateTree(target, { summarize: true }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        await deadline(summaryStarted.promise, "held native tree summary");
        assert.equal(session.isIdle, false);
        const sessionRef = {
          sessionId: session.sessionManager.getSessionId(),
          sessionFile: session.sessionManager.getSessionFile(),
        };
        daemon.send({ type: "inject", id: "raft", text: first, ...sessionRef });
        daemon.send({
          type: "inject",
          id: "wrong-session",
          text: "Do not deliver another burrow's message.",
          ...sessionRef,
          sessionId: "another-burrow",
        });
        daemon.send({
          type: "inject",
          id: "wrong-file",
          text: "Do not deliver another logbook's message.",
          ...sessionRef,
          sessionFile: path.join(cwd, "another-logbook.jsonl"),
        });
        daemon.send({ type: "inject", id: "life-jacket", text: second, ...sessionRef });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(
          { acknowledgements: daemon.injectResults, extensionErrors: failures },
          { acknowledgements: [], extensionErrors: [] },
          "busy navigation must not falsely accept input or cause asynchronous Pi rejection",
        );
        assert.equal(session.pendingMessageCount, 0, "navigation input stays in Telegram's queue");
        mock.timers.tick(500);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          daemon.injectResults.length,
          0,
          "a retry while still navigating retains input",
        );
        assert.deepEqual(prompts, ["Prepare the raft.", "Explore the kelp forest."]);
        if (outcome === "cancel") session.abortBranchSummary();
        summarizing = false;
        releaseSummary.resolve();
        const finished = await navigation;
        if (outcome === "failure") {
          assert.match(String(finished.error), /Kelp summary unavailable/);
        } else {
          assert.equal(finished.error, undefined);
          assert.equal(finished.result?.cancelled, outcome === "cancel");
        }
        if (outcome !== "success") assert.equal(session.sessionManager.getLeafId(), originalLeaf);
        assert.equal(session.isIdle, true);
        mock.timers.tick(500);
        await deadline(
          Promise.all([acknowledged.promise, delivered.promise]),
          "deferred window delivery",
        );
        await session.waitForIdle();
        assert.deepEqual(
          daemon.injectResults.map(({ id, status }) => ({ id, status })),
          [
            { id: "raft", status: "accepted" },
            { id: "wrong-session", status: "rejected" },
            { id: "wrong-file", status: "rejected" },
            { id: "life-jacket", status: "accepted" },
          ],
        );
        assert.match(daemon.injectResults[1]!.reason!, /switched Pi sessions/);
        assert.match(daemon.injectResults[2]!.reason!, /session file changed/);
        assert.deepEqual(prompts, ["Prepare the raft.", "Explore the kelp forest.", first, second]);
        assert.deepEqual(
          session.messages
            .filter((message) => message.role === "user")
            .map((message) => contentText(message.content))
            .filter((text) => text.startsWith("Telegram:")),
          [first, second],
          "both valid messages enter the selected branch once, in arrival order",
        );
        mock.timers.tick(1000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(daemon.injectResults.length, 4, "completed injections are never retried");
        assert.equal(session.pendingMessageCount, 0);
      } finally {
        summarizing = false;
        releaseSummary.resolve();
        await navigation;
        await session.abort();
      }
    });
  }

  for (const boundary of ["reload", "local input"] as const) {
    test(`explicitly rejects deferred window input on ${boundary} instead of discarding or replaying it`, async () => {
      const agentDir = getAgentDir();
      const cwd = path.join(agentDir, "otter-workshop");
      await mkdir(cwd, { recursive: true });
      const daemon = substituteDaemonTransport(agentDir, failures);
      const entered = completion();
      const release = completion();
      const prompts: string[] = [];
      resources = await createPiResources(cwd, agentDir, [
        telegram,
        (pi) => {
          pi.on("session_before_tree", async () => {
            entered.resolve();
            await release.promise;
            return { cancel: true };
          });
        },
        scriptedProvider(fixtureModel, ({ context }) => {
          const message = context.messages.findLast((candidate) => candidate.role === "user");
          assert.ok(message?.role === "user");
          prompts.push(contentText(message.content));
          return assistantMessage(reply);
        }),
      ]);
      ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
      await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
      await session.prompt("Prepare the raft.");
      const target = session.sessionManager.getLeafId()!;
      await session.prompt("Explore the kelp forest.");
      await session.prompt("/telegram pair");
      mock.timers.reset();
      mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const navigation = session.navigateTree(target, { summarize: false });
      try {
        await deadline(entered.promise, "held tree navigation");
        daemon.send({
          type: "inject",
          id: "retired-raft",
          text: "Telegram: wait for the raft.",
          sessionId: session.sessionManager.getSessionId(),
          sessionFile: session.sessionManager.getSessionFile(),
        });
        assert.equal(daemon.injectResults.length, 0);
        release.resolve();
        assert.equal((await navigation).cancelled, true);
        if (boundary === "reload") await session.reload();
        else await session.prompt("A local skipper takes over.");
        assert.deepEqual(
          daemon.injectResults.map(({ id, status }) => ({ id, status })),
          [{ id: "retired-raft", status: "rejected" }],
          "retired queued input must produce an explicit rejection, not disappear",
        );
        assert.match(
          daemon.injectResults[0]!.reason!,
          boundary === "reload" ? /session closed or reloaded/ : /superseded by local input/,
        );
        mock.timers.tick(1000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(daemon.injectResults.length, 1);
        assert.equal(
          prompts.some((text) => text.startsWith("Telegram:")),
          false,
        );
        assert.equal(session.pendingMessageCount, 0);
      } finally {
        release.resolve();
        await navigation;
      }
    });
  }

  for (const boundary of ["tool", "retry", "tool-retry", "empty-retry"] as const) {
    test(`relays ${boundary} cancellation once with only current-run text and resets on the next run`, async () => {
      const agentDir = getAgentDir();
      const cwd = path.join(agentDir, "otter-workshop");
      await mkdir(cwd, { recursive: true });
      const daemon = substituteDaemonTransport(agentDir, failures);
      let ready!: () => void;
      let toolAborted!: () => void;
      let cleanup!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const abortedPromise = new Promise<void>((resolve) => {
        toolAborted = resolve;
      });
      const cleanupPromise = new Promise<void>((resolve) => {
        cleanup = resolve;
      });
      let calls = 0;
      let retries = 0;
      const cancelledCalls = boundary === "tool-retry" ? 4 : 2;
      const settled: boolean[] = [];
      resources = await createPiResources(cwd, agentDir, [
        telegram,
        scriptedProvider(fixtureModel, () => {
          if (++calls === 1 || calls > cancelledCalls) return assistantMessage(reply);
          return boundary === "retry" || boundary === "empty-retry" || calls > 2
            ? {
                ...assistantMessage(boundary === "retry" ? "The otter checked the map." : ""),
                stopReason: "error",
                errorMessage: "529 overloaded",
              }
            : {
                ...assistantMessage("The otter checked the map."),
                stopReason: "toolUse",
                content: [
                  { type: "text", text: "The otter checked the map." },
                  { type: "toolCall", id: "dive", name: "dive", arguments: {} },
                ],
              };
        }),
        (pi) => {
          pi.registerTool({
            name: "dive",
            label: "Dive",
            description: "Wait underwater",
            parameters: Type.Object({}),
            async execute(_id, _args, signal) {
              if (boundary === "tool-retry") return { content: [], details: {} };
              assert.ok(signal);
              signal.addEventListener("abort", toolAborted, { once: true });
              ready();
              await cleanupPromise;
              signal.throwIfAborted();
              return { content: [], details: {} };
            },
          });
        },
      ]);
      resources.settingsManager.applyOverrides({
        retry: {
          enabled: boundary !== "tool",
          baseDelayMs: boundary === "tool-retry" ? 1 : 60_000,
          maxRetries: 2,
        },
      });
      ({ session } = await createAgentSession({
        ...resources,
        model: fixtureModel,
        tools: ["dive"],
      }));
      await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
      session.subscribe((event) => {
        if (event.type === "auto_retry_start" && ++retries === (boundary === "tool-retry" ? 2 : 1))
          ready();
        if (event.type === "agent_settled") settled.push(event.aborted);
      });
      await session.prompt("/telegram pair");
      await session.prompt("Finish the previous report.");
      assert.deepEqual(daemon.results, [
        { type: "assistant_result", text: reply, tone: "assistant" },
      ]);
      const prompt = session.prompt("Inspect the river.");
      try {
        await deadline(readyPromise, "cancellable work");
        if (boundary !== "tool") assert.equal(session.isRetrying, true);
        const abort = session.abort();
        if (boundary === "tool") {
          await deadline(abortedPromise, "tool abort");
          assert.equal(daemon.results.length, 1, "settlement must join tool cleanup");
          assert.equal(session.isIdle, false);
          cleanup();
        }
        await abort;
        await prompt;
        assert.deepEqual(settled, [false, true]);
        assert.equal(calls, cancelledCalls);
        const detail = boundary === "tool" ? "This operation was aborted" : "529 overloaded";
        const partial = boundary === "empty-retry" ? "" : "The otter checked the map.\n\n";
        assert.deepEqual(daemon.results, [
          { type: "assistant_result", text: reply, tone: "assistant" },
          {
            type: "assistant_result",
            text: `${partial}⚠️ ${detail}\n\n⚠️ Run aborted`,
            tone: "system",
          },
        ]);
        await session.prompt("Try the river again.");
        assert.deepEqual(settled, [false, true, false]);
        assert.deepEqual(daemon.results.at(-1), {
          type: "assistant_result",
          text: reply,
          tone: "assistant",
        });
        assert.equal(daemon.results.length, 3);
      } finally {
        cleanup();
        await session.abort();
        await prompt;
      }
    });
  }

  test("mirrors finalized message replacements from handlers before and after Telegram", async () => {
    const agentDir = getAgentDir();
    const cwd = path.join(agentDir, "otter-workshop");
    await mkdir(cwd, { recursive: true });
    const daemon = substituteDaemonTransport(agentDir, failures);
    const reasons = ["stop", "error", "aborted"] as const;
    let calls = 0;
    resources = await createPiResources(cwd, agentDir, [
      (pi) => {
        pi.on("message_end", (event) => {
          if (event.message.role !== "assistant") return;
          assert.deepEqual(event.message.content, [{ type: "text", text: "Raw otter reply" }]);
          return {
            message: {
              ...event.message,
              content: [{ type: "text", text: "Intermediate otter reply" }],
              errorMessage: "Intermediate detail",
            },
          };
        });
      },
      telegram,
      (pi) => {
        pi.on("message_end", (event) => {
          if (event.message.role !== "assistant") return;
          assert.deepEqual(event.message.content, [
            { type: "text", text: "Intermediate otter reply" },
          ]);
          return {
            message: {
              ...event.message,
              content: [{ type: "text", text: "Final otter reply" }],
              errorMessage: "Final detail",
            },
          };
        });
      },
      scriptedProvider(fixtureModel, () => ({
        ...assistantMessage("Raw otter reply"),
        stopReason: reasons[calls++]!,
        errorMessage: "Raw detail",
      })),
    ]);
    ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
    await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
    await session.prompt("/telegram pair");
    for (const reason of reasons) {
      await session.prompt(`Edit the ${reason} reply.`);
      const message: AssistantMessage | undefined = session.messages.findLast(
        (candidate) => candidate.role === "assistant",
      );
      assert.ok(message?.role === "assistant");
      assert.deepEqual(message.content, [{ type: "text", text: "Final otter reply" }]);
      assert.equal(message.errorMessage, "Final detail");
      const text =
        reason === "stop"
          ? "Final otter reply"
          : `Final otter reply\n\n⚠️ Final detail${reason === "aborted" ? "\n\n⚠️ Run aborted" : ""}`;
      assert.deepEqual(daemon.results.at(-1), {
        type: "assistant_result",
        text,
        tone: reason === "stop" ? "assistant" : reason === "error" ? "error" : "system",
      });
    }
    assert.equal(daemon.results.length, 3);
  });

  test("formats empty cancellation and message-level fallback without treating false as success", () => {
    for (const messages of [undefined, [], [{ role: "user", content: "hello" }]]) {
      assert.deepEqual(formatTelegramAssistantResultFromMessages(messages, true), {
        text: "⚠️ Run aborted",
        tone: "system",
      });
      assert.equal(formatTelegramAssistantResultFromMessages(messages, false), null);
    }
    assert.deepEqual(
      formatTelegramAssistantResultFromMessages(
        [{ ...assistantMessage(""), stopReason: "aborted", errorMessage: "Run aborted" }],
        true,
      ),
      { text: "⚠️ Run aborted", tone: "system" },
    );
    for (const stopReason of ["toolUse", "error", "aborted"] as const) {
      const message = {
        ...assistantMessage("Partial river map"),
        stopReason,
        errorMessage: "River detail",
      };
      assert.deepEqual(formatTelegramAssistantResultFromMessages([message], true), {
        text: "Partial river map\n\n⚠️ River detail\n\n⚠️ Run aborted",
        tone: "system",
      });
      const fallback = formatTelegramAssistantResultFromMessages([message], false)!;
      assert.equal(
        fallback.tone,
        stopReason === "aborted" ? "system" : stopReason === "error" ? "error" : "assistant",
      );
      assert.equal(fallback.text.includes("Run aborted"), stopReason === "aborted");
    }
  });

  for (const marker of ["TAU_SUBAGENT_CHILD", "TAU_TELEGRAM_DISABLE", undefined] as const) {
    test(`${marker ? `${marker}=1 hides Telegram` : "an ordinary parent retains /telegram"} through a completed turn`, async () => {
      const agentDir = getAgentDir();
      const cwd = path.join(agentDir, "otter-workshop");
      await mkdir(cwd, { recursive: true });
      if (marker) {
        process.env[marker] = "1";
        // Opt-out must win even when inherited settings would otherwise auto-connect.
        await mkdir(path.join(agentDir, "telegram"));
        await writeFile(
          path.join(agentDir, "telegram", "config.json"),
          JSON.stringify({ pairedChatId: 42 }),
        );
      }

      let api!: ExtensionAPI;
      let requests = 0;
      resources = await createPiResources(cwd, agentDir, [
        telegram,
        (pi) => {
          api = pi;
        },
        scriptedProvider(fixtureModel, ({ context }) => {
          requests++;
          assert.deepEqual(
            getCurrentTools(context.messages),
            [],
            "no Telegram tool reaches the model",
          );
          return assistantMessage(reply);
        }),
      ]);
      ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
      await session.bindExtensions({
        mode: "print",
        onError: (error) => failures.push(error),
      });

      assert.deepEqual(
        api.getCommands().map(({ name }) => name),
        marker ? [] : ["telegram"],
      );
      assert.equal(
        session.getAllTools().some(({ name }) => name === "telegram_send_file"),
        false,
      );
      await session.prompt("Keep the report local.");
      await session.waitForIdle();
      if (marker) mock.timers.tick(6000);
      assert.equal(requests, 1);
      const result = session.messages.at(-1);
      assert.equal(result?.role, "assistant");
      assert.ok(result && "content" in result);
      assert.deepEqual(result.content, [{ type: "text", text: reply }]);
      assert.deepEqual(failures, [], "startup, settlement and reconnect ticks stay offline");
    });
  }

  async function pairedFiles() {
    const agentDir = getAgentDir();
    const cwd = path.join(agentDir, "otter-workshop");
    const configPath = path.join(agentDir, "telegram", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(cwd);
    await writeFile(configPath, JSON.stringify({ pairedChatId: 42 }));
    return { agentDir, cwd, configPath };
  }

  async function bindTelegram(cwd: string) {
    resources = await createPiResources(cwd, getAgentDir(), [telegram]);
    ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
    await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });
    return session;
  }
});

/** Socket EOF proves descendant death, including orphaned Linux processes becoming zombies. */
async function descendantBoundary() {
  const directory = await fsp.realpath(await fsp.mkdtemp("/tmp/tau-descendant-"));
  const socketPath = path.join(directory, "credential.sock");
  let socket: net.Socket | undefined;
  let pid: number | undefined;
  let dead: Promise<unknown> | undefined;
  const server = net.createServer();
  const ready = once(server, "connection").then(async ([connection]) => {
    socket = connection as net.Socket;
    dead = once(socket, "close");
    const lines = createInterface({ input: socket });
    socket.once("close", () => lines.close());
    const [line] = await once(lines, "line");
    pid = Number(line);
    assert.ok(Number.isInteger(pid) && pid! > 0);
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    socketPath,
    ready: () => deadline(ready, "descendant ready"),
    waitDead: () => deadline(dead!, "descendant death"),
    async dispose() {
      if (pid && !socket?.destroyed) killFixtureProcess(pid);
      socket?.destroy();
      if (dead) await dead;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Negative IDs target process groups. An already-exited fixture still needs its handles joined. */
function killFixtureProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Substitute only the daemon socket. Production JSONL parsing, pairing, tool registration and Pi navigation stay real. */
function substituteDaemonTransport(
  agentDir: string,
  failures: unknown[],
  options: { available?: () => boolean; onMeta?: () => void; onInjectResult?: () => void } = {},
) {
  let persistent: net.Socket | undefined;
  const results: { type: string; text: string; tone: string }[] = [];
  const injectResults: { id: string; status: string; reason?: string }[] = [];
  const send = (message: object) => {
    assert.ok(persistent && !persistent.destroyed);
    persistent.emit("data", `${JSON.stringify(message)}\n`);
  };
  mock.method(net, "connect", (socketPath: string) => {
    assert.equal(socketPath, path.join(agentDir, "run", "telegram.sock"));
    const socket = new net.Socket();
    if (options.available?.() === false) {
      queueMicrotask(() =>
        socket.emit("error", Object.assign(new Error("No otter daemon"), { code: "ENOENT" })),
      );
      return socket;
    }
    mock.method(socket, "end", () => {
      socket.destroy();
      return socket;
    });
    mock.method(socket, "write", (chunk: string) => {
      const message = JSON.parse(chunk);
      switch (message.type) {
        case "register":
          persistent = socket;
          send({
            type: "registered",
            sessionNo: 8,
            paired: true,
            capabilities: ["send_file_queued"],
          });
          break;
        case "request_pin":
          send({ type: "pin", code: "OTTER8", expiresAt: Date.now() + 60_000 });
          break;
        case "meta":
          options.onMeta?.();
          break;
        case "assistant_result":
          results.push(message);
          break;
        case "inject_result":
          injectResults.push(message);
          options.onInjectResult?.();
          break;
        default: {
          const error = new Error(`Unexpected Telegram daemon request: ${message.type}`);
          failures.push(error);
          throw error;
        }
      }
      return true;
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  return {
    send,
    results,
    injectResults,
    async disconnect() {
      assert.ok(persistent);
      const closed = once(persistent, "close");
      persistent.destroy();
      await closed;
    },
  };
}

/** Refuse daemon connections without allowing any external socket access. */
function stoppedDaemonSocket(agentDir: string) {
  let count = 0;
  mock.method(net, "connect", (socketPath: string) => {
    assert.equal(socketPath, path.join(agentDir, "run", "telegram.sock"));
    count++;
    const socket = new net.Socket();
    queueMicrotask(() =>
      socket.emit("error", Object.assign(new Error("No otter daemon"), { code: "ENOENT" })),
    );
    return socket;
  });
  return { count: () => count };
}

/** No real daemon, bot, Keychain or model network is allowed. Pi's lifecycle and generation orchestration stay real. */
function rejectExternalWork(failures: unknown[]) {
  const reject = () => {
    const error = new Error(
      "Unexpected subprocess or network request in Telegram opt-out workflow",
    );
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  mock.method(net, "connect", reject);
  mock.method(net, "createConnection", reject);
  for (const method of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ] as const)
    mock.method(childProcess, method, reject);
  syncBuiltinESMExports();
}
