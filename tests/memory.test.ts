import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createAgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import memoryExtension from "../extensions/memory.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

const blockNames = ["directives", "context", "focus", "pending"] as const;
const pending = "- Ask the octopus before deploying on Friday.\n";
const consolidated = {
  directives: "- No Friday deployments.",
  context: "- The octopus owns release approval.",
  focus: "- Prepare the aquarium release.",
  pending,
};

describe("memory", { concurrency: false }, () => {
  let directory: string;
  let app: Awaited<ReturnType<typeof openMemory>> | undefined;
  let failures: unknown[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-memory-"));
    failures = [];
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-01T12:00:00.000Z") });
    const rejectExternalWork = () => {
      const error = new Error("Unexpected network request or subprocess in memory workflow");
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
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "Pi must not swallow unexpected boundary or extension errors");
    } finally {
      app = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("initializes without overwriting user memory and reloads disk rules into each prompt", async () => {
    app = await openMemory(directory, failures);
    await app.chat("Hello, uninitialized aquarium.");
    assert.doesNotMatch(app.contexts.at(-1)?.systemPrompt ?? "", /<repo_memory>/);
    assert.ok(!app.session.getActiveToolNames().includes("memory_update_block"));
    await writeFile(path.join(app.cwd, ".gitignore"), "# User rules\npond.tmp");

    await app.session.prompt("/memory init");
    assert.ok(app.session.getActiveToolNames().includes("memory_update_block"));
    await app.tools([call("memory_update_block", { name: "pending", content: pending })]);
    await writeFile(app.file("README.md"), "# Aquarium rules\n\nNever feed the CI gremlins.\n");
    await writeFile(app.file("research/tides.md"), "RESEARCH_BODY_NOT_AUTO_LOADED\n");
    await writeFile(app.file("attachments/map.txt"), "ATTACHMENT_NOT_AUTO_LOADED\n");
    const before = await snapshot(app.file(""));
    await app.session.prompt("/memory init");
    assert.deepEqual(await snapshot(app.file("")), before, "init is repair, not reset");
    assert.equal(
      await readFile(path.join(app.cwd, ".gitignore"), "utf8"),
      "# User rules\npond.tmp\n/.agents/memory/attachments/\n",
    );

    await app.session.reload();
    await app.chat("What remains to do?");
    const prompt = app.contexts.at(-1)?.systemPrompt ?? "";
    assert.ok(prompt.includes("Never feed the CI gremlins."));
    assert.ok(prompt.includes(pending.trimEnd()));
    assert.ok(prompt.includes(".agents/memory/research/tides.md"));
    assert.doesNotMatch(prompt, /RESEARCH_BODY_NOT_AUTO_LOADED|ATTACHMENT_NOT_AUTO_LOADED/);
    assert.equal(prompt.split("<repo_memory>").length - 1, 1);

    await rm(app.file("README.md"));
    await app.chat("Can we still talk while the rules are missing?");
    assert.doesNotMatch(app.contexts.at(-1)?.systemPrompt ?? "", /<repo_memory>/);
    assert.ok(
      app.notifications.some(
        ({ message, type }) => type === "warning" && /README.md.*missing/.test(message),
      ),
    );
    await app.session.prompt("/memory init");
    assert.equal(await readFile(app.file("core/pending.md"), "utf8"), pending);
    await app.chat("Rules restored?");
    assert.match(app.contexts.at(-1)?.systemPrompt ?? "", /<repo_memory>/);
  });

  for (const [cap, content, error] of [
    ["line", Array.from({ length: 200 }, () => "- Feed one fish.").join("\n"), /300-line cap/],
    ["character", "🐟".repeat(5_500), /20000-character cap/],
  ] as const) {
    test(`parallel block updates respect the combined ${cap} cap without losing the accepted write`, async () => {
      app = await openMemory(directory, failures);
      await app.session.prompt("/memory init");
      const results = await app.tools([
        call("memory_update_block", { name: "context", content }),
        call("memory_update_block", { name: "focus", content }),
      ]);
      assert.equal(results.filter((result) => !result.isError).length, 1);
      assert.equal(results.filter((result) => result.isError).length, 1);
      assert.match(text(results.find((result) => result.isError)!.content), error);
      const saved = await Promise.all(
        ["context", "focus"].map((name) => readFile(app!.file(`core/${name}.md`), "utf8")),
      );
      assert.deepEqual(saved.sort(), ["", `${content}\n`].sort());
      const accepted = results.find((result) => !result.isError)!;
      assert.equal(
        await readFile(app.file(`core/${accepted.details.block}.md`), "utf8"),
        `${content}\n`,
      );
    });
  }

  test("dream preserves append-only provenance and replays only logs not yet consolidated", async () => {
    app = await openMemory(directory, failures);
    await app.session.prompt("/memory init");
    const entries = await app.tools([
      call("memory_append_log", {
        type: "decision",
        title: "Release captain",
        body: "The octopus approves releases.",
        importance: "high",
      }),
      call("memory_append_log", {
        type: "experiment",
        title: "Friday failed",
        body: "The gremlins ate the deploy.",
        supersedes: ["old-plan", "old-plan"],
        invalidates: ["Friday is safe"],
      }),
    ]);
    assert.ok(entries.every((entry) => !entry.isError));
    const log = await readFile(app.file("log.md"), "utf8");
    for (const { details } of entries) {
      assert.ok(
        log.includes(
          `## ${details.timestamp} | ${details.type} | ${details.importance} | ${details.title}\n`,
        ),
      );
    }
    assert.equal(log.split("- Supersedes: old-plan").length - 1, 1);
    app.dreams.push((context) => {
      const input = text(context.messages[0].content);
      assert.ok(input.includes("The octopus approves releases."));
      assert.ok(input.includes("The gremlins ate the deploy."));
      assert.ok(input.includes("- Invalidates: Friday is safe"));
      return dreamReply(consolidated);
    });
    const [dream] = await app.tools([call("memory_dream", {})]);
    assert.equal(dream.isError, false, text(dream.content));
    assert.equal(dream.details.consumedLogs, 2);
    assert.equal(await readFile(app.file("log.md"), "utf8"), log);
    const state = JSON.parse(await readFile(app.file("state.json"), "utf8"));
    assert.equal(state.last_dreamed_log_at, entries.at(-1)!.details.timestamp);
    for (const name of blockNames)
      assert.equal(
        await readFile(app.file(`core/${name}.md`), "utf8"),
        `${consolidated[name].trimEnd()}\n`,
      );
    const summary = await readFile(path.join(app.cwd, dream.details.summaryPath), "utf8");
    assert.match(summary, /Undreamed log count: 2/);
    assert.ok(summary.includes(state.last_dreamed_log_at));

    mock.timers.tick(1);
    await app.tools([
      call("memory_append_log", {
        type: "plan",
        title: "Next tide",
        body: "NEW_LOG: launch on Monday.",
      }),
    ]);
    app.dreams.push((context) => {
      const replay = text(context.messages[0].content)
        .split("<undreamed-log>\n")[1]
        .split("\n</undreamed-log>")[0];
      assert.ok(replay.includes("NEW_LOG: launch on Monday."));
      assert.doesNotMatch(replay, /The octopus approves releases|The gremlins ate the deploy/);
      return dreamReply(consolidated);
    });
    const [nextDream] = await app.tools([call("memory_dream", {})]);
    assert.equal(nextDream.isError, false, text(nextDream.content));
    assert.equal(nextDream.details.consumedLogs, 1);
    assert.equal(await readFile(path.join(app.cwd, dream.details.summaryPath), "utf8"), summary);
    const beforeNoop = await snapshot(app.file(""));
    await app.session.prompt("/memory dream");
    assert.deepEqual(
      await snapshot(app.file("")),
      beforeNoop,
      "no-op dream neither calls the model nor writes files",
    );
  });

  for (const [proposal, response, error] of [
    ["malformed JSON", "the octopus ate the JSON", /valid JSON/],
    [
      "unresolved pending deletion",
      JSON.stringify({
        blocks: { ...consolidated, pending: "" },
        summary: "Compressed the notes.",
      }),
      /pending.md/,
    ],
  ] as const) {
    test(`rejects ${proposal} without consuming memory, then permits a valid retry`, async () => {
      app = await openMemory(directory, failures);
      await app.session.prompt("/memory init");
      await app.tools([
        call("memory_update_block", { name: "pending", content: pending }),
        call("memory_append_log", {
          type: "plan",
          title: "Ask first",
          body: "Approval is still outstanding.",
        }),
      ]);
      const before = await snapshot(app.file(""));
      app.dreams.push(() => assistantMessage(response));
      const [rejected] = await app.tools([call("memory_dream", {})]);
      assert.equal(rejected.isError, true, `Dream must reject ${proposal} before writing memory`);
      assert.match(text(rejected.content), error);
      assert.deepEqual(await snapshot(app.file("")), before);
      app.dreams.push(() => dreamReply(consolidated));
      const [retry] = await app.tools([call("memory_dream", {})]);
      assert.equal(retry.isError, false, text(retry.content));
      assert.equal(retry.details.consumedLogs, 1);
      assert.equal(await readFile(app.file("core/pending.md"), "utf8"), pending);
    });
  }

  test("a dream cannot overwrite a native write made while its model is thinking", async () => {
    app = await openMemory(directory, failures);
    await app.session.prompt("/memory init");
    const started = deferred<void>();
    const reply = deferred<AssistantMessage>();
    app.dreams.push(() => {
      started.resolve();
      return reply.promise;
    });
    const dreaming = app.session.prompt("/memory dream Compress the aquarium notes");
    try {
      await Promise.race([
        started.promise,
        dreaming.then(() => {
          throw new Error("Dream command finished before requesting a model reply");
        }),
      ]);
      const [write] = await app.tools([
        call("write", { path: ".agents/memory/core/pending.md", content: pending }),
      ]);
      assert.equal(write.isError, false, text(write.content));
      const before = await snapshot(app.file(""));
      reply.resolve(dreamReply({ ...consolidated, pending: "" }));
      await dreaming;
      assert.deepEqual(await snapshot(app.file("")), before);
      const conflict = app.extensionErrors.splice(0);
      assert.equal(conflict.length, 1);
      assert.match(conflict[0].error, /Memory changed while dream was running/);
      app.dreams.push(() => dreamReply(consolidated));
      const [retry] = await app.tools([
        call("memory_dream", { reason: "Retry with the new pending item" }),
      ]);
      assert.equal(retry.isError, false, text(retry.content));
    } finally {
      reply.resolve(dreamReply(consolidated));
      await dreaming;
    }
  });

  for (const [clock, adjustment] of [
    ["in the same millisecond", 0],
    ["after the clock moves backward", -1],
  ] as const) {
    test(`a log appended ${clock} after a dream is consumed exactly once across reload`, async () => {
      app = await openMemory(directory, failures);
      await app.session.prompt("/memory init");
      const [entry] = await app.tools([
        call("memory_append_log", {
          type: "decision",
          title: "First",
          body: "🐙 Release on Monday.",
        }),
      ]);
      const logBefore = await readFile(app.file("log.md"), "utf8");
      app.dreams.push(() => dreamReply(consolidated));
      const [first] = await app.tools([call("memory_dream", {})]);
      assert.equal(first.isError, false, text(first.content));
      const firstSummary = await readFile(path.join(app.cwd, first.details.summaryPath), "utf8");
      const firstState = JSON.parse(await readFile(app.file("state.json"), "utf8"));
      mock.timers.setTime(Date.now() + adjustment);
      const [correction] = await app.tools([
        call("memory_append_log", {
          type: "decision",
          title: "Correction",
          body: "Monday is also a holiday.",
          supersedes: ["First"],
          invalidates: ["Monday is safe"],
        }),
      ]);
      assert.equal(
        Date.parse(correction.details.timestamp) - Date.parse(entry.details.timestamp),
        adjustment,
      );
      const logAfter = await readFile(app.file("log.md"), "utf8");
      assert.ok(logAfter.startsWith(logBefore));
      await app.session.reload();
      await app.session.prompt("/memory status");
      assert.match(
        app.notifications.at(-1)?.message ?? "",
        /Undreamed logs: 1\b/,
        "newly appended memory must remain replayable even when wall-clock timestamps collide",
      );
      app.dreams.push((context) => {
        const replay = text(context.messages[0].content)
          .split("<undreamed-log>\n")[1]
          .split("\n</undreamed-log>")[0];
        assert.ok(replay.includes("Monday is also a holiday."));
        assert.ok(replay.includes("- Supersedes: First"));
        assert.ok(replay.includes("- Invalidates: Monday is safe"));
        assert.doesNotMatch(replay, /🐙 Release on Monday/);
        return dreamReply(consolidated);
      });
      const [second] = await app.tools([call("memory_dream", {})]);
      assert.equal(second.isError, false, text(second.content));
      assert.equal(second.details.consumedLogs, 1);
      assert.equal(await readFile(app.file("log.md"), "utf8"), logAfter);
      assert.equal(
        await readFile(path.join(app.cwd, first.details.summaryPath), "utf8"),
        firstSummary,
      );
      assert.notEqual(second.details.summaryPath, first.details.summaryPath);
      const state = JSON.parse(await readFile(app.file("state.json"), "utf8"));
      assert.equal(firstState.last_dreamed_log_cursor.bytes, Buffer.byteLength(logBefore));
      assert.equal(state.last_dreamed_log_cursor.bytes, Buffer.byteLength(logAfter));
      const beforeNoop = await snapshot(app.file(""));
      await app.session.reload();
      await app.session.prompt("/memory dream");
      assert.deepEqual(await snapshot(app.file("")), beforeNoop);
    });
  }

  test("startup auto-dream consumes a same-timestamp backlog after an earlier dream", async () => {
    app = await openMemory(directory, failures);
    await app.session.prompt("/memory init");
    await app.tools([
      call("memory_append_log", { type: "plan", title: "First", body: "Already dreamed." }),
    ]);
    app.dreams.push(() => dreamReply(consolidated));
    const [first] = await app.tools([call("memory_dream", {})]);
    assert.equal(first.isError, false, text(first.content));
    const appended = await app.tools(
      Array.from({ length: 8 }, (_, index) =>
        call("memory_append_log", {
          type: "plan",
          title: `Tide ${index}`,
          body: `Check buoy ${index}.`,
        }),
      ),
    );
    assert.ok(appended.every((entry) => !entry.isError));
    let dreamed = false;
    app.dreams.push((context) => {
      const replay = text(context.messages[0].content)
        .split("<undreamed-log>\n")[1]
        .split("\n</undreamed-log>")[0];
      for (let index = 0; index < 8; index++) assert.ok(replay.includes(`Check buoy ${index}.`));
      assert.doesNotMatch(replay, /Already dreamed/);
      dreamed = true;
      return dreamReply(consolidated);
    });
    await app.session.reload();
    // before_agent_start is the extension's completion barrier for a startup dream.
    await app.chat("Have the buoys been checked?");
    assert.equal(dreamed, true, "startup must inspect the append cursor, not equal timestamps");
    const state = JSON.parse(await readFile(app.file("state.json"), "utf8"));
    assert.equal(
      state.last_dreamed_log_cursor.bytes,
      Buffer.byteLength(await readFile(app.file("log.md"), "utf8")),
    );
    const beforeNoop = await snapshot(app.file(""));
    await app.session.prompt("/memory dream");
    assert.deepEqual(await snapshot(app.file("")), beforeNoop);
  });

  test("a changed consumed prefix cannot redirect the append cursor and restoring it permits retry", async () => {
    app = await openMemory(directory, failures);
    await app.session.prompt("/memory init");
    await app.tools([
      call("memory_append_log", { type: "plan", title: "First", body: "Protect the tide chart." }),
    ]);
    app.dreams.push(() => dreamReply(consolidated));
    const [first] = await app.tools([call("memory_dream", {})]);
    assert.equal(first.isError, false, text(first.content));
    const log = await readFile(app.file("log.md"), "utf8");
    await app.tools([
      call("write", { path: ".agents/memory/log.md", content: log.replace("Protect", "Destroy") }),
    ]);
    const before = await snapshot(app.file(""));
    const [rejected] = await app.tools([call("memory_dream", { reason: "Check the chart." })]);
    assert.equal(rejected.isError, true);
    assert.match(text(rejected.content), /log changed before its dream cursor/);
    assert.deepEqual(await snapshot(app.file("")), before);
    await app.tools([call("write", { path: ".agents/memory/log.md", content: log })]);
    app.dreams.push(() => dreamReply(consolidated));
    const [retry] = await app.tools([
      call("memory_dream", { reason: "Check the restored chart." }),
    ]);
    assert.equal(retry.isError, false, text(retry.content));
    assert.equal(retry.details.consumedLogs, 0);
  });
});

/** Real Pi session with only model generation and notifications adapted; commands, tools and queues stay native. */
async function openMemory(directory: string, failures: unknown[]) {
  const cwd = path.join(directory, "work");
  await mkdir(cwd);
  type Reply = (context: Context) => AssistantMessage | Promise<AssistantMessage>;
  const replies: Reply[] = [];
  const dreams: Reply[] = [];
  const contexts: Context[] = [];
  const work = new Set<Promise<void>>();
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      baseUrl: fixtureModel.baseUrl,
      apiKey: "fixture-only",
      models: [fixtureModel],
      streamSimple: (_model, context) => {
        const stream = createAssistantMessageEventStream();
        const task = (async () => {
          try {
            const isDream = context.tools === undefined;
            if (!isDream) contexts.push(context);
            const respond = (isDream ? dreams : replies).shift();
            assert.ok(respond, `Unexpected ${isDream ? "dream" : "agent"} request`);
            const message = await respond(context);
            assert.ok(message.stopReason === "stop" || message.stopReason === "toolUse");
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
          } catch (error) {
            failures.push(error);
            const message = {
              ...assistantMessage(""),
              stopReason: "error" as const,
              errorMessage: String(error),
            };
            stream.push({ type: "error", reason: "error", error: message });
            stream.end();
          }
        })();
        work.add(task);
        void task.finally(() => work.delete(task));
        return stream;
      },
    });
  };
  const resources = await createPiResources(cwd, path.join(directory, "agent"), [
    memoryExtension,
    provider,
  ]);
  const { session } = await createAgentSession({
    ...resources,
    model: fixtureModel,
    noTools: "builtin",
    tools: ["write", "memory_update_block", "memory_append_log", "memory_dream"],
  });
  const notifications: { message: string; type?: string }[] = [];
  const extensionErrors: { error: string }[] = [];
  const shutdown = async () => {
    try {
      await session.abort();
      await Promise.all(work);
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
    }
  };
  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: uiBoundary(
        { notify: (message, type) => notifications.push({ message, type }) },
        failures,
      ),
      onError: (error) => extensionErrors.push(error),
    });
    let toolId = 0;
    return {
      cwd,
      session,
      contexts,
      dreams,
      notifications,
      extensionErrors,
      file: (relative: string) => path.join(cwd, ".agents/memory", relative),
      async chat(prompt: string) {
        replies.push(() => assistantMessage("Acknowledged."));
        await session.prompt(prompt);
        assert.equal(
          session.getLastAssistantText(),
          "Acknowledged.",
          JSON.stringify(session.messages),
        );
      },
      async tools(calls: Omit<ToolCall, "id">[]) {
        const message = assistantMessage("");
        message.content = calls.map((call) => ({ ...call, id: `memory-${++toolId}` }));
        message.stopReason = "toolUse";
        replies.push(
          () => message,
          () => assistantMessage("Tools finished."),
        );
        const start = session.messages.length;
        await session.prompt("Apply the requested memory operation.");
        const results = session.messages
          .slice(start)
          .filter((message) => message.role === "toolResult");
        assert.equal(results.length, calls.length, JSON.stringify(session.messages.slice(start)));
        return results;
      },
      async dispose() {
        await shutdown();
        assert.deepEqual(extensionErrors, []);
        assert.equal(replies.length + dreams.length, 0, "all scripted requests were consumed");
      },
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** Control the model boundary without timing assumptions; callers release and await work in finally. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function call(name: string, args: Record<string, unknown>): Omit<ToolCall, "id"> {
  return { type: "toolCall", name, arguments: args };
}

function dreamReply(blocks: Record<(typeof blockNames)[number], string>) {
  return assistantMessage(
    JSON.stringify({
      blocks,
      summary: "Consolidated release notes; approval remains pending.",
    }),
  );
}

function text(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      assert.equal(part.type, "text");
      return part.text;
    })
    .join("");
}

/** Capture every memory file's bytes to detect partial writes or destructive consumption on refusal. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(root, file)] = await readFile(file, "utf8");
    }
  }
  return files;
}
