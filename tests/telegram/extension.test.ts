import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
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

const reply = "The otter keeps its report in the parent window.";

const connect = net.connect;

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
    mock.method(net, "connect", (socketPath: string) => {
      if (socketPath !== path.join(agentDir, "run", "telegram.sock")) {
        const error = new Error(`Unexpected socket: ${socketPath}`);
        failures.push(error);
        throw error;
      }
      return connect(socketPath);
    });
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
    resources = await createPiResources(cwd, agentDir, [telegram]);
    ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
    await session.bindExtensions({ mode: "print", onError: (error) => failures.push(error) });

    await session.prompt("/telegram pair");

    assert.equal(launches.length, 1);
    const { command, args, options } = launches[0]!;
    assert.equal(command, process.execPath);
    assert.equal(path.basename(args[0]!), "daemon.mjs");
    assert.equal(args.length, 1);
    assert.equal(options.detached, true);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.env?.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(options.env?.TAU_TELEGRAM_PI_ENTRYPOINT, process.argv[1] ?? "");
    assert.equal(options.env?.TAU_TELEGRAM_BOT_TOKEN, process.env.TAU_TELEGRAM_BOT_TOKEN);
    assert.deepEqual(
      Object.keys(options.env ?? {})
        .filter((key) => key.startsWith("TAU_TELEGRAM_"))
        .sort(),
      ["TAU_TELEGRAM_BOT_TOKEN", "TAU_TELEGRAM_PI_ENTRYPOINT"],
    );
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
});

/** Substitute only the daemon socket. Production JSONL parsing, pairing, tool registration and Pi navigation stay real. */
function substituteDaemonTransport(agentDir: string, failures: unknown[]) {
  let persistent: net.Socket | undefined;
  const results: { type: string; text: string; tone: string }[] = [];
  const send = (message: object) => {
    assert.ok(persistent && !persistent.destroyed);
    persistent.emit("data", `${JSON.stringify(message)}\n`);
  };
  mock.method(net, "connect", (socketPath: string) => {
    assert.equal(socketPath, path.join(agentDir, "run", "telegram.sock"));
    const socket = new net.Socket();
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
          break;
        case "assistant_result":
          results.push(message);
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
    async disconnect() {
      assert.ok(persistent);
      const closed = once(persistent, "close");
      persistent.destroy();
      await closed;
    },
  };
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
