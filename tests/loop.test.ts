import assert from "node:assert/strict";
import { Type } from "typebox";
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
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  defineTool,
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

const mainModel = { ...fixtureModel, provider: "openai-loop-fixture", reasoning: true };
const summaryModel = { ...mainModel, id: "gpt-5.6-luna" };
const testsPrompt =
  "Run all tests. If they are passing, call the signal_loop_success tool. " +
  "Otherwise continue until the tests pass.";
const failureReply: AssistantMessage = {
  ...assistantMessage(""),
  stopReason: "error",
  errorMessage: "The fixture gateway has misplaced its octopus.",
};

type ModelRequest = {
  model: Model<Api>;
  context: TranscriptContext;
  options: StreamOptions | undefined;
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
    app = await openLoop(
      directory!,
      history,
      failures,
      [
        first,
        assistantMessage("One check still needs work."),
        assistantMessage("The queued request is handled."),
        toolCall("signal_loop_success", {}),
        assistantMessage("Release verified."),
        assistantMessage("No more verification requested."),
      ],
      {
        select: async (_title, options) => {
          assert.ok(options.includes("Until tests pass"));
          return "Until tests pass";
        },
      },
    );
    const interjection = "Before retrying, keep the café in read-only mode. 🐙";

    await app.session.prompt("/loop");
    await first.started;
    await app.session.followUp(interjection);
    assert.deepEqual(app.session.getFollowUpMessages(), [interjection]);
    await settlesWith(app.session, "Release verified.", () =>
      first.finish(toolCall("read", { path: "checks.txt" })),
    );

    assert.deepEqual(
      app.requests
        .slice(0, 5)
        .map(
          ({ context }) => context.messages.findLast((message) => message.role !== "system")?.role,
        ),
      ["user", "toolResult", "user", "user", "toolResult"],
      "tool continuations are not loop iterations",
    );
    const afterRead = app.requests[1].context.messages;
    assert.deepEqual(
      afterRead.slice(-2).map((message) => message.role),
      ["toolResult", "system"],
      "Pi's persisted prompt update remains in the provider transcript after the tool result",
    );
    assert.match(getCurrentSystemPrompt(afterRead), /Reply to the user's message\./);
    assert.equal(messageText(afterRead.at(-2)!), report);
    assert.equal(messageText(app.requests[2].context.messages.at(-1)!), interjection);
    assert.equal(messageText(app.requests[3].context.messages.at(-1)!), testsPrompt);
    assert.deepEqual(
      getCurrentTools(app.requests[0].context.messages)
        .map((tool) => tool.name)
        .sort(),
      ["read", "signal_loop_success"],
    );
    assert.match(
      getCurrentSystemPrompt(app.summaryRequests[0].context.messages),
      /summarize loop breakout conditions/,
    );
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

  test("dismissing the native preset picker or condition editor leaves the loop inactive", async () => {
    let selections = 0;
    let edits = 0;
    app = await openLoop(directory!, history, failures, [], {
      select: async (_title, options) => {
        assert.ok(options.includes("Until custom condition"));
        return ++selections === 1 ? undefined : "Until custom condition";
      },
      editor: async () => {
        edits++;
        return undefined;
      },
    });
    const entries = structuredClone(history.getEntries());
    await app.session.prompt("/loop");
    await app.session.prompt("/loop");
    assert.equal(selections, 2);
    assert.equal(edits, 1);
    assert.deepEqual(history.getEntries(), entries);
    assert.equal(app.widget(), "");
    assert.equal(app.requests.length, 0);
    assert.equal(app.summaryRequests.length, 0);
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

  for (const phase of ["tool", "retry"] as const) {
    test(`confirms session abort during ${phase}, joins cleanup, and resets on a fresh loop`, async () => {
      const tools = [heldTool(), heldTool()];
      const retries = [deferred<void>(), deferred<void>()];
      const summary = heldReply();
      const answers = [false, true];
      const abortReply =
        phase === "tool"
          ? toolCall("lifeboat", {})
          : { ...failureReply, errorMessage: "529 overloaded" };
      app = await openLoop(
        directory!,
        history,
        failures,
        [
          abortReply,
          abortReply,
          toolCall("signal_loop_success", {}),
          assistantMessage("Fresh loop done."),
        ],
        {
          confirm: async (title) => {
            assert.match(title, /break.*loop/i);
            const answer = answers.shift();
            assert.notEqual(answer, undefined);
            return answer!;
          },
        },
        [summary, assistantMessage("loops until the lifeboat is ready")],
        undefined,
        {
          tools: phase === "tool" ? ["lifeboat"] : [],
          extensions:
            phase === "tool"
              ? [
                  (pi) => {
                    let call = 0;
                    pi.registerTool(
                      defineTool({
                        name: "lifeboat",
                        label: "Lifeboat",
                        description: "Inspect the lifeboat.",
                        parameters: Type.Object({}),
                        execute: async (_id, _args, signal) => {
                          const tool = tools[call++];
                          assert.ok(tool, "no extra tool execution");
                          return tool.execute(signal);
                        },
                      }),
                    );
                  },
                ]
              : [],
        },
      );
      app.runtime.services.settingsManager.applyOverrides({
        retry: { enabled: phase === "retry", maxRetries: 1, baseDelayMs: 60_000 },
      });
      const settled: boolean[] = [];
      const reasons: string[] = [];
      const retryWaiters = [...retries];
      const unsubscribe = app.session.subscribe((event) => {
        if (event.type === "auto_retry_start") {
          const waiter = retryWaiters.shift();
          assert.ok(waiter, "no extra retry");
          waiter.resolve();
        }
        if (event.type === "agent_end")
          reasons.push(
            event.messages.findLast((message) => message.role === "assistant")!.stopReason,
          );
        if (event.type === "agent_settled") settled.push(event.aborted);
      });
      try {
        await app.session.prompt("/loop self");
        await ready(summary.started);
        for (let index = 0; index < 2; index++) {
          await ready(phase === "tool" ? tools[index].started : retries[index].promise);
          assert.equal(lastState(history).loopCount, index + 1);
          assert.equal(
            summary.signal?.aborted,
            false,
            "declining cancellation keeps the summary alive",
          );
          if (phase === "retry") assert.equal(app.session.isRetrying, true);
          let finished = false;
          const abort = app.session.abort().then(() => {
            finished = true;
          });
          if (phase === "tool") {
            await ready(tools[index].cancelled);
            await nextCheckPhase();
            assert.equal(finished, false, "session abort joins real tool cleanup");
            assert.equal(settled.length, index);
            assert.equal(answers.length, 2 - index, "confirmation waits for tool cleanup");
            tools[index].finish();
          }
          await ready(abort);
        }
        await nextCheckPhase();
        assert.deepEqual(answers, []);
        assert.deepEqual(settled, [true, true]);
        assert.deepEqual(
          reasons,
          ["error", "error"],
          "native cancellation need not produce an aborted assistant",
        );
        assert.equal(summary.signal?.aborted, true);
        assert.equal(summary.finished, true);
        assert.deepEqual(lastState(history), { active: false });
        assert.equal(app.requests.length, 2);
        assert.equal(app.session.pendingMessageCount, 0);
        assert.equal(
          app.notifications.some(({ type }) => type === "error"),
          false,
        );

        await settlesWith(app.session, "Fresh loop done.", () =>
          app!.session.prompt("/loop tests"),
        );
        assert.deepEqual(settled, [true, true, false]);
        assert.deepEqual(lastState(history), { active: false });
        assert.equal(app.requests.length, 4);
      } finally {
        for (const tool of tools) tool.finish();
        unsubscribe();
      }
    });
  }

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

  test("compacts an active loop through configured auth while preserving instructions, usage and retained context", async () => {
    const { firstKeptEntryId, retainedText } = saveLoopForCompaction(history);
    const summary = {
      ...assistantMessage("The octopus release still needs eight passing checks."),
      usage: {
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 130,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
      },
    };
    const configuredAuth = {
      auth: {
        apiKey: "compaction-fixture-only",
        baseUrl: "https://octopus-gateway.invalid/v1",
        headers: { "X-Octopus": "eight", "X-Discarded": null },
      },
      env: { TAU_LOOP_REGION: "café-cove" },
    };
    app = await openLoop(
      directory!,
      history,
      failures,
      [summary, toolCall("signal_loop_success", {}), assistantMessage("Compacted loop completed.")],
      {},
      [],
      async () => configuredAuth,
    );
    app.session.setThinkingLevel("high");
    const instructions = "Preserve the café release checklist verbatim. 🐙";
    const result = await app.session.compact(instructions);

    assert.equal(app.requests.length, 1);
    const request = app.requests[0];
    assert.equal(request.model.baseUrl, configuredAuth.auth.baseUrl);
    assert.equal(request.options?.apiKey, configuredAuth.auth.apiKey);
    assert.deepEqual(request.options?.headers, configuredAuth.auth.headers);
    assert.deepEqual(request.options?.env, configuredAuth.env);
    assert.ok(request.options && "reasoning" in request.options);
    assert.equal(request.options.reasoning, "high");
    assert.equal(request.options?.cacheRetention, "none");
    assert.equal(request.options?.maxTokens, mainModel.maxTokens);
    assert.ok(request.options?.sessionId, "one-off compaction keeps its native routing ID");
    assert.ok(request.options?.signal instanceof AbortSignal);
    assert.equal(request.options.signal.aborted, false);
    assert.match(getCurrentSystemPrompt(request.context.messages), /summari/i);
    assert.deepEqual(getCurrentTools(request.context.messages), []);
    const prompt = messageText(request.context.messages.at(-1)!);
    assert.ok(prompt.includes(instructions));
    assert.ok(prompt.includes("Loop active. Breakout condition: tests pass."));
    assert.ok(prompt.includes("Check the octopus release."));
    assert.equal(prompt.includes(retainedText), false, "retained input is not summarized");
    assert.equal(result.firstKeptEntryId, firstKeptEntryId);
    assert.deepEqual(result.usage, summary.usage);
    assert.deepEqual(result.details, { readFiles: [], modifiedFiles: [] });
    assert.equal(lastState(history).active, true);
    assert.equal(lastState(history).loopCount, 3);
    assert.deepEqual(app.notifications, []);
    const saved = history.getEntries().findLast((entry) => entry.type === "compaction");
    assert.ok(saved?.type === "compaction");
    assert.equal(saved.fromHook, true);
    assert.deepEqual(saved.usage, summary.usage);
    assert.equal(saved.firstKeptEntryId, firstKeptEntryId);
    assert.deepEqual(SessionManager.open(history.getSessionFile()!).getEntry(saved.id), saved);

    await settlesWith(app.session, "Compacted loop completed.", () =>
      app!.session.prompt("Resume release checks."),
    );
    const resumed = app.requests[1].context.messages;
    assert.deepEqual(
      getCurrentTools(resumed)
        .map((tool) => tool.name)
        .sort(),
      ["read", "signal_loop_success"],
    );
    assert.ok(resumed.some((message) => messageText(message).includes(messageText(summary))));
    assert.ok(resumed.some((message) => messageText(message) === retainedText));
    assert.deepEqual(lastState(history), { active: false });
    assert.equal(app.requests.length, 3);
  });

  test("cancels compaction during Loop's auth resolution without provider work, warnings or persisted changes", async () => {
    saveLoopForCompaction(history);
    const { promise: started, resolve: start } = deferred<AbortSignal>();
    const { promise: released, resolve: release } = deferred<void>();
    const { promise: finished, resolve: finish } = deferred<void>();
    let compacting = false;
    let authCalls = 0;
    let heldSignal: AbortSignal | undefined;
    app = await openLoop(directory!, history, failures, [], {}, [], async ({ signal }) => {
      // Loop resolves summary authentication before any native fallback.
      if (compacting && ++authCalls === 1) {
        heldSignal = signal;
        start(signal);
        await released;
        finish();
      }
      return { auth: { apiKey: "fixture-only" } };
    });
    const entries = history.getEntries();
    const bytes = await readFile(history.getSessionFile()!);
    compacting = true;
    const outcome = app.session.compact().then(
      () => assert.fail("cancelled compaction must not succeed"),
      (error: unknown) => error,
    );
    try {
      const signal = await ready(started);
      app.session.abortCompaction();
      assert.ok((await ready(outcome)) instanceof Error);
      assert.equal(signal.aborted, true);
      assert.equal(app.requests.length, 0);
      assert.deepEqual(app.notifications, []);
      assert.deepEqual(history.getEntries(), entries);
    } finally {
      app.session.abortCompaction();
      release();
      if (heldSignal) await ready(finished);
      await ready(outcome);
    }
    await nextCheckPhase(); // Observe any incorrectly dispatched work after the late auth result.
    assert.equal(app.requests.length, 0);
    assert.deepEqual(app.notifications, []);
    assert.deepEqual(history.getEntries(), entries);
    assert.deepEqual(await readFile(history.getSessionFile()!), bytes);
  });

  for (const failure of ["missing authentication", "provider error"] as const) {
    test(`falls back to native compaction after ${failure} in Loop's summary`, async () => {
      const { firstKeptEntryId } = saveLoopForCompaction(history);
      let compacting = false;
      let authCalls = 0;
      const summary = assistantMessage("The fallback octopus remembered the checklist.");
      app = await openLoop(
        directory!,
        history,
        failures,
        failure === "provider error" ? [failureReply, summary] : [summary],
        {},
        [],
        async ({ credential }) => {
          if (compacting && ++authCalls === 1 && failure === "missing authentication") {
            return undefined;
          }
          return { auth: { apiKey: credential?.key ?? "fixture-only" } };
        },
      );
      compacting = true;
      const instructions = "Keep the octopus checklist.";
      const result = await app.session.compact(instructions);
      assert.equal(result.firstKeptEntryId, firstKeptEntryId);
      const saved = history.getEntries().findLast((entry) => entry.type === "compaction");
      assert.ok(saved?.type === "compaction");
      assert.equal(
        saved.fromHook,
        false,
        "the default summary, not Loop's failed attempt, is saved",
      );
      assert.equal(saved.summary, messageText(summary));
      assert.deepEqual(
        app.notifications.map(({ type }) => type),
        ["warning"],
      );
      assert.match(app.notifications[0].message, /Loop compaction failed:/);
      assert.equal(app.requests.length, failure === "provider error" ? 2 : 1);
      const fallbackPrompt = messageText(app.requests.at(-1)!.context.messages.at(-1)!);
      assert.ok(fallbackPrompt.includes(instructions));
      assert.equal(fallbackPrompt.includes("Loop active."), false);
      assert.equal(lastState(history).active, true);
      assert.equal(lastState(history).loopCount, 3);
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

/** Restore an idle active loop with enough old history to compact and one verbatim retained input. */
function saveLoopForCompaction(history: SessionManager) {
  const retainedText = "Keep the café's eight umbrellas. 🐙";
  const firstKeptEntryId = history.appendMessage({
    role: "user",
    content: retainedText,
    timestamp: 1,
  });
  history.appendCustomEntry("loop-state", {
    active: true,
    mode: "tests",
    prompt: testsPrompt,
    summary: "tests pass",
    loopCount: 3,
  });
  return { firstKeptEntryId, retainedText };
}

/**
 * Real command dispatch, queues, tools and durable session; only model generation, auth and UI output are adapted.
 * Scripts reject extra requests. Teardown completes every held provider stream before removing its session.
 */
async function openLoop(
  directory: string,
  history: SessionManager,
  failures: unknown[],
  replies: (AssistantMessage | ReturnType<typeof heldReply>)[],
  dialogs: Pick<Partial<ExtensionUIContext>, "select" | "confirm" | "editor"> = {},
  summaries: (AssistantMessage | ReturnType<typeof heldReply> | Error)[] = [
    assistantMessage("loops until checks pass"),
  ],
  resolveAuth: ApiKeyAuth["resolve"] = async () => ({ auth: { apiKey: "fixture-only" } }),
  fixture: { extensions: ExtensionFactory[]; tools: string[] } = { extensions: [], tools: [] },
) {
  const requests: ModelRequest[] = [];
  const summaryRequests: ModelRequest[] = [];
  const provider: ExtensionFactory = (pi) => {
    const generate = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
      const isSummary = model.id === summaryModel.id;
      const reply = isSummary ? summaries[summaryRequests.length] : replies[requests.length];
      (isSummary ? summaryRequests : requests).push({
        model: structuredClone(model),
        context: structuredClone(context),
        options: options && { ...options },
      });
      if (!reply) {
        const error = new Error("Unexpected model request in loop workflow");
        failures.push(error);
        throw error;
      }
      if (reply instanceof Error) throw reply;
      if ("start" in reply) return reply.start(options);
      return replyStream(reply);
    };
    pi.registerProvider({
      id: mainModel.provider,
      name: "Loop fixture",
      baseUrl: mainModel.baseUrl,
      auth: {
        apiKey: {
          name: "Fixture credential",
          check: async () => ({ type: "api_key" }),
          resolve: resolveAuth,
        },
      },
      getModels: () => [mainModel, summaryModel],
      stream: generate,
      streamSimple: generate,
    });
  };
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [
        loop,
        provider,
        ...fixture.extensions,
      ]);
      resources.settingsManager.applyOverrides({
        compaction: { enabled: false, keepRecentTokens: 1 },
      });
      return {
        ...(await createAgentSession({
          ...resources,
          sessionManager,
          sessionStartEvent,
          model: mainModel,
          tools: ["read", "signal_loop_success", ...fixture.tools],
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
  const { promise: settled, resolve, reject } = deferred<void>();
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
  const { promise: started, resolve: ready } = deferred<void>();
  const { promise: cancelled, resolve: cancel } = deferred<void>();
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

/** A controlled tool boundary that acknowledges abort only after its cleanup is released. */
function heldTool() {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const cleanup = deferred<void>();
  return {
    started: started.promise,
    cancelled: cancelled.promise,
    finish: () => cleanup.resolve(),
    async execute(signal?: AbortSignal) {
      assert.ok(signal);
      const onAbort = () => cancelled.resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      started.resolve();
      try {
        await cleanup.promise;
        signal.throwIfAborted();
        return { content: [{ type: "text" as const, text: "Lifeboat inspected." }], details: {} };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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

function toolCall(name: string, args: JsonObject): AssistantMessage {
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

function messageText(message: TranscriptContext["messages"][number]) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
