import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { setImmediate as nextCheckPhase } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  initTheme,
  SessionManager,
  type AgentSession,
  type CustomEntry,
  type CustomMessageEntry,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import loop from "../extensions/loop.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

const mainModel = { ...fixtureModel, provider: "openai-loop-fixture" };
const summaryModel = { ...mainModel, id: "gpt-5.3-codex-spark" };
const testsPrompt =
  "Run all tests. If they are passing, call the signal_loop_success tool. " +
  "Otherwise continue until the tests pass.";
const failureReply: AssistantMessage = {
  ...assistantMessage(""),
  stopReason: "error",
  errorMessage: "The fixture gateway has misplaced its octopus.",
};

describe("loop", { concurrency: false }, () => {
  let directory: string | undefined;
  let history: SessionManager;
  let rootEntry: string;
  let app: Awaited<ReturnType<typeof openLoop>> | undefined;
  let failures: unknown[];

  beforeEach(async () => {
    failures = [];
    const rejectExternalWork = () => {
      const error = new Error("Unexpected network request or subprocess in loop workflow");
      failures.push(error);
      throw error;
    };
    mock.method(globalThis, "fetch", rejectExternalWork);
    for (const method of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      mock.method(childProcess, method, rejectExternalWork);
    syncBuiltinESMExports();

    directory = await mkdtemp(path.join(os.tmpdir(), "tau-loop-"));
    const cwd = path.join(directory, "work");
    await mkdir(cwd);
    history = SessionManager.create(cwd, path.join(directory, "sessions"));
    history.appendModelChange(mainModel.provider, mainModel.id);
    history.appendMessage({ role: "user", content: "Check the octopus release.", timestamp: 0 });
    rootEntry = history.appendMessage(assistantMessage("Ready to verify."));
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "unexpected work or extension errors must not be swallowed");
    } finally {
      app = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  test("lets native tools and queued user work finish before repeating, then stops durably on success", async () => {
    const report = "Café checks: 7 passed, 1 squid-shaped failure.\n";
    const reportPath = path.join(history.getCwd(), "checks.txt");
    await writeFile(reportPath, report);
    const first = heldReply();
    app = await openLoop(directory!, history, failures, [
      first,
      assistantMessage("One check still needs work."),
      assistantMessage("The queued request is handled."),
      toolCall("signal_loop_success", {}),
      assistantMessage("Release verified."),
      assistantMessage("No more verification requested."),
    ]);
    const interjection = "Before retrying, keep the café in read-only mode. 🐙";

    await app.session.prompt("/loop tests");
    await first.started;
    await app.session.followUp(interjection);
    assert.deepEqual(app.session.getFollowUpMessages(), [interjection]);
    await settlesWith(app.session, "Release verified.", () =>
      first.finish(toolCall("read", { path: "checks.txt" })),
    );

    assert.deepEqual(
      app.requests.slice(0, 5).map((context) => context.messages.at(-1)?.role),
      ["user", "toolResult", "user", "user", "toolResult"],
      "tool continuations are not loop iterations",
    );
    assert.equal(messageText(app.requests[1].messages.at(-1)!), report);
    assert.equal(messageText(app.requests[2].messages.at(-1)!), interjection);
    assert.equal(messageText(app.requests[3].messages.at(-1)!), testsPrompt);
    assert.deepEqual(
      loopMessages(history).map((entry) => entry.content),
      [testsPrompt, testsPrompt],
    );
    assert.ok(loopMessages(history).every((entry) => entry.display));
    assert.equal(Math.max(...loopStates(history).map((entry) => entry.data.loopCount ?? 0)), 2);
    assert.deepEqual(lastState(history), { active: false });
    assert.equal(app.widget(), "");
    assert.equal(app.session.pendingMessageCount, 0);
    const result = app.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "signal_loop_success",
    );
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false);
    assert.deepEqual(result.details, { active: false });
    assert.equal(
      await readFile(reportPath, "utf8"),
      report,
      "verification leaves the report intact",
    );

    await app.session.reload();
    await app.session.prompt("No more verification requested.");
    await nextCheckPhase(); // Let any erroneously scheduled loop continuation run before asserting.
    assert.equal(app.requests.length, 6);
    assert.equal(app.summaryRequests.length, 1);
    const reopened = SessionManager.open(history.getSessionFile()!);
    assert.deepEqual(lastState(reopened), { active: false });
    assert.equal(loopMessages(reopened).length, 2);
  });

  test("stops after an agent error rather than spending another loop turn", async () => {
    app = await openLoop(directory!, history, failures, [failureReply]);
    await settlesWith(app.session, { stopReason: "error" }, () =>
      app!.session.prompt("/loop tests"),
    );

    assert.deepEqual(lastState(history), { active: false });
    assert.equal(app.widget(), "");
    assert.equal(app.session.pendingMessageCount, 0);
    assert.equal(app.requests.length, 1);
    assert.equal(loopMessages(history).length, 1);
    assert.equal(app.notifications.at(-1)?.type, "error");
    assert.match(app.notifications.at(-1)?.message ?? "", /loop.*error/i);
    assert.deepEqual(lastState(SessionManager.open(history.getSessionFile()!)), { active: false });
  });

  test("honors both answers to breaking an aborted loop without losing its iteration count", async () => {
    const first = heldReply();
    const second = heldReply();
    const summary = heldReply();
    const answers = [false, true];
    app = await openLoop(
      directory!,
      history,
      failures,
      [first, second],
      {
        confirm: async (title) => {
          assert.match(title, /break.*loop/i);
          const answer = answers.shift();
          assert.notEqual(answer, undefined, "no unsolicited repeat confirmation");
          return answer!;
        },
      },
      [summary],
    );
    await app.session.prompt("/loop self");
    await Promise.all([first.started, summary.started]);
    await app.session.abort();
    await second.started;
    assert.equal(
      summary.signal?.aborted,
      false,
      "declining the break keeps loop-scoped work alive",
    );
    assert.equal(summary.finished, false);
    assert.equal(first.signal?.aborted, true, "native abort reaches the active provider");
    assert.equal(lastState(history).active, true);
    assert.equal(lastState(history).loopCount, 2);
    assert.match(app.widget(), /turn 2/);

    await app.session.abort();
    await nextCheckPhase();
    assert.equal(second.signal?.aborted, true);
    assert.equal(summary.signal?.aborted, true);
    assert.equal(summary.finished, true);
    assert.deepEqual(answers, []);
    assert.deepEqual(lastState(history), { active: false });
    assert.equal(app.widget(), "");
    assert.equal(app.requests.length, 2);
    assert.equal(app.session.pendingMessageCount, 0);
    assert.deepEqual(lastState(SessionManager.open(history.getSessionFile()!)), { active: false });
  });

  test("restores the selected branch across reload, not the latest state elsewhere in the file", async () => {
    const first = heldReply();
    const condition = "the café serves eight happy octopuses 🐙";
    app = await openLoop(directory!, history, failures, [
      first,
      toolCall("signal_loop_success", {}),
      assistantMessage("Recovered loop completed."),
    ]);
    await app.session.prompt(`/loop custom ${condition}`);
    await first.started;
    await nextCheckPhase(); // The immediate summary stream has completed its promise continuations.
    const checkpoint = loopStates(history).at(-1)!;
    assert.equal(checkpoint.data.condition, condition);
    assert.equal(checkpoint.data.active, true);
    assert.equal(checkpoint.data.loopCount, 1);
    await settlesWith(app.session, { stopReason: "error" }, () => first.finish(failureReply));
    const oldEntries = SessionManager.open(history.getSessionFile()!).getEntries();

    await app.session.navigateTree(rootEntry, { summarize: false });
    await app.session.reload();
    assert.equal(app.widget(), "", "a branch preceding /loop has no active loop");
    await app.session.navigateTree(checkpoint.id, { summarize: false });
    await app.session.reload();
    assert.match(app.widget(), /turn 1/);
    assert.equal(lastState(history).condition, condition);
    assert.equal(app.requests.length, 1, "restoration alone must not start unsolicited work");
    assert.equal(app.summaryRequests.length, 1, "the saved summary is reusable");

    await settlesWith(app.session, "Recovered loop completed.", () =>
      app!.session.prompt("Resume verification."),
    );
    assert.deepEqual(
      lastState(history),
      { active: false },
      "the restored tool ends the restored loop",
    );
    const reopened = SessionManager.open(history.getSessionFile()!);
    assert.deepEqual(reopened.getEntries().slice(0, oldEntries.length), oldEntries);
    assert.deepEqual(lastState(reopened), { active: false });
    assert.ok(reopened.getBranch().some((entry) => entry.id === checkpoint.id));
  });

  for (const transition of ["reload", "tree", "shutdown"] as const) {
    test(`${transition} joins a restored loop's summary without publishing abandoned work`, async () => {
      // Resume an unfinished loop from a real file-backed selected branch, before its summary was saved.
      history.appendCustomEntry("loop-state", {
        active: true,
        mode: "tests",
        prompt: testsPrompt,
        loopCount: 3,
      });
      const summary = heldReply({ holdAbort: true });
      const restored = heldReply();
      app = await openLoop(
        directory!,
        history,
        failures,
        [],
        {},
        transition === "reload" ? [summary, restored] : [summary],
      );
      await ready(summary.started);
      const entries = history.getEntries();
      let completed = false;
      const work = (
        transition === "reload"
          ? app.session.reload()
          : transition === "tree"
            ? app.session.navigateTree(rootEntry, { summarize: false })
            : app.runtime.dispose()
      ).then(() => {
        completed = true;
      });
      try {
        await ready(
          Promise.race([
            summary.cancelled,
            work.then(() => {
              throw new Error("Lifecycle returned before cancelling its summary");
            }),
          ]),
        );
        await nextCheckPhase();
        assert.equal(completed, false, "the native lifecycle must wait for summary cleanup");
        assert.equal(app.summaryRequests.length, 1, "no overlapping replacement summary");
        summary.finish(assistantMessage("yesterday's octopus escaped"));
        await work;
        assert.deepEqual(
          history.getEntries(),
          entries,
          "cleanup must not persist a stale summary or erase saved state",
        );
        assert.equal(app.requests.length, 0, "restoration never starts an unsolicited agent turn");
        if (transition === "reload") {
          await ready(restored.started);
          assert.match(app.widget(), /turn 3/);
          assert.equal(restored.signal?.aborted, false);
        } else if (transition === "tree") {
          assert.equal(app.widget(), "");
          assert.equal(loopStates(history).length, 0);
        }
      } finally {
        summary.finish({ ...assistantMessage(""), stopReason: "aborted" });
        await work;
      }
    });
  }

  for (const response of [failureReply, new Error("The summary octopus lost its pencil.")]) {
    test(`summary ${response instanceof Error ? "thrown provider error" : "error response"} falls back without stopping the loop`, async () => {
      const first = heldReply();
      app = await openLoop(
        directory!,
        history,
        failures,
        [first, assistantMessage("Verified without fancy status text.")],
        {},
        [response],
      );
      await app.session.prompt("/loop tests");
      await ready(first.started);
      await nextCheckPhase(); // Drain the immediate scripted summary completion and its publication.
      assert.match(app.widget(), /tests pass.*turn 1/);
      assert.equal(lastState(history).active, true);
      await settlesWith(app.session, "Verified without fancy status text.", () =>
        first.finish(toolCall("signal_loop_success", {})),
      );
      assert.deepEqual(lastState(history), { active: false });
    });
  }

  test("cancels and joins outstanding status summarization before returning native loop success", async () => {
    const summary = heldReply({ holdAbort: true });
    const first = heldReply();
    app = await openLoop(
      directory!,
      history,
      failures,
      [first, assistantMessage("Done before the status summary.")],
      {},
      [summary],
    );
    await app.session.prompt("/loop tests");
    await Promise.all([first.started, summary.started]);
    const settled = settlesWith(app.session, "Done before the status summary.", () =>
      first.finish(toolCall("signal_loop_success", {})),
    );
    try {
      await ready(
        Promise.race([
          summary.cancelled,
          settled.then(() => {
            throw new Error("Loop returned success before cancelling its summary");
          }),
        ]),
      );
      await nextCheckPhase();
      assert.deepEqual(lastState(history), { active: false });
      assert.equal(app.widget(), "");
      assert.equal(summary.finished, false, "cancellation acknowledgement is still pending");
      assert.equal(
        app.requests.length,
        1,
        "the success tool must join before its native continuation",
      );
      assert.equal(
        app.session.messages.some(
          (message) => message.role === "toolResult" && message.toolName === "signal_loop_success",
        ),
        false,
        "success must not return while summary work is outstanding",
      );
      const statesAtCancellation = loopStates(history).length;
      // A provider may finish with text after receiving cancellation. It must still be joined, not published.
      summary.finish(assistantMessage("loops until yesterday's tests pass"));
      await settled;
      assert.equal(loopStates(history).length, statesAtCancellation);
      assert.equal(app.widget(), "");
      assert.deepEqual(lastState(history), { active: false });
      assert.equal(
        app.requests.length,
        2,
        "native success still permits the final assistant response",
      );
    } finally {
      summary.finish({ ...assistantMessage(""), stopReason: "aborted" });
      await settled;
    }
  });
});

/**
 * Real command dispatch, queues, tools and durable session; only model generation and UI output are adapted.
 * Scripts reject extra requests. Teardown completes every held provider stream before removing its session.
 */
async function openLoop(
  directory: string,
  history: SessionManager,
  failures: unknown[],
  replies: (AssistantMessage | ReturnType<typeof heldReply>)[],
  dialogs: Pick<Partial<ExtensionUIContext>, "confirm"> = {},
  summaries: (AssistantMessage | ReturnType<typeof heldReply> | Error)[] = [
    assistantMessage("loops until checks pass"),
  ],
) {
  const requests: Context[] = [];
  const summaryRequests: Context[] = [];
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider(mainModel.provider, {
      api: mainModel.api,
      baseUrl: mainModel.baseUrl,
      apiKey: "fixture-only",
      models: [mainModel, summaryModel],
      streamSimple: (model, context, options) => {
        const isSummary = model.id === summaryModel.id;
        const reply = isSummary ? summaries[summaryRequests.length] : replies[requests.length];
        (isSummary ? summaryRequests : requests).push({
          ...context,
          messages: structuredClone(context.messages),
          tools: context.tools?.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        });
        if (!reply) {
          const error = new Error("Unexpected model request in loop workflow");
          failures.push(error);
          throw error;
        }
        if (reply instanceof Error) throw reply;
        if ("start" in reply) return reply.start(options);
        return replyStream(reply);
      },
    });
  };
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [loop, provider]);
      return {
        ...(await createAgentSession({
          ...resources,
          sessionManager,
          sessionStartEvent,
          model: mainModel,
          tools: ["read", "signal_loop_success"],
        })),
        services: { ...resources, diagnostics: [] },
        diagnostics: [],
      };
    },
    {
      cwd: history.getCwd(),
      agentDir: path.join(directory, "agent"),
      sessionManager: history,
    },
  );
  const session = runtime.session;
  let disposed = false;
  const shutdown = async () => {
    if (disposed) return;
    disposed = true;
    try {
      session.clearQueue();
      // Release scripted acknowledgements even if a regression assertion failed before cancellation.
      for (const reply of [...replies, ...summaries]) {
        if ("finish" in reply) reply.finish({ ...assistantMessage(""), stopReason: "aborted" });
      }
      await session.abort();
      await runtime.services.settingsManager.flush();
    } finally {
      await runtime.dispose();
      await nextCheckPhase();
    }
  };
  try {
    initTheme("dark", false);
    let widget = "";
    const notifications: { message: string; type: string | undefined }[] = [];
    await session.bindExtensions({
      mode: "tui",
      uiContext: uiBoundary(
        {
          theme: session.extensionRunner.getUIContext().theme,
          setWidget: (_key, content) => {
            assert.ok(content === undefined || Array.isArray(content));
            widget = (content ?? []).map(stripVTControlCharacters).join("\n");
          },
          notify: (message, type) => notifications.push({ message, type }),
          ...dialogs,
        },
        failures,
      ),
      onError: (error) => failures.push(error),
    });
    return {
      runtime,
      session,
      requests,
      summaryRequests,
      notifications,
      widget: () => widget,
      dispose: shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** Wait for a specific completed native run, including Pi's extension lifecycle drain; timeout is only a deadlock guard. */
async function settlesWith(
  session: AgentSession,
  expected: string | { stopReason: "error" },
  action: () => void | Promise<void>,
) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const settled = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "agent_settled") return;
    const matches =
      typeof expected === "string"
        ? session.getLastAssistantText() === expected
        : session.messages.findLast((message) => message.role === "assistant")?.stopReason ===
          expected.stopReason;
    if (matches) resolve();
  });
  const deadline = setTimeout(
    () => reject(new Error(`Loop did not settle with ${JSON.stringify(expected)}`)),
    5_000,
  );
  try {
    await action();
    await settled;
    await session.waitForIdle();
    await nextCheckPhase();
  } finally {
    clearTimeout(deadline);
    unsubscribe();
  }
}

/** A controlled external generation boundary that responds to native cancellation and is explicitly finished in teardown. */
function heldReply({ holdAbort = false } = {}) {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const stream = createAssistantMessageEventStream();
  let signal: AbortSignal | undefined;
  let finished = false;
  const aborted = () => {
    cancel();
    if (!holdAbort) finish({ ...assistantMessage(""), stopReason: "aborted" });
  };
  function finish(reply: AssistantMessage) {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", aborted);
    endStream(stream, reply);
  }
  return {
    started,
    cancelled,
    get signal() {
      return signal;
    },
    get finished() {
      return finished;
    },
    start(options?: SimpleStreamOptions) {
      signal = options?.signal;
      stream.push({ type: "start", partial: { ...assistantMessage(""), stopReason: "pending" } });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      ready();
      return stream;
    },
    finish,
  };
}

/** Bound missing lifecycle handshakes; the owning test releases and joins work in finally. */
async function ready<T>(promise: Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Loop workflow did not reach readiness")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function replyStream(reply: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: reply });
  endStream(stream, reply);
  return stream;
}

function endStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  reply: AssistantMessage,
) {
  const message = { ...reply, provider: mainModel.provider, model: mainModel.id };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    assert.ok(message.stopReason !== "pending");
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end();
}

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    ...assistantMessage(""),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
  };
}

type SavedLoopState = { active: boolean; condition?: string; loopCount?: number };

function loopStates(history: SessionManager) {
  return history
    .getBranch()
    .filter(
      (entry): entry is CustomEntry<SavedLoopState> & { data: SavedLoopState } =>
        entry.type === "custom" && entry.customType === "loop-state" && entry.data !== undefined,
    );
}

function lastState(history: SessionManager) {
  return loopStates(history).at(-1)!.data;
}

function loopMessages(history: SessionManager) {
  return history
    .getBranch()
    .filter(
      (entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" && entry.customType === "loop",
    );
}

function messageText(message: Context["messages"][number]) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
