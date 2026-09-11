import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import ghostty from "../extensions/ghostty.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

describe("ghostty", { concurrency: false }, () => {
  let directory: string;
  let history: SessionManager;
  let failures: unknown[];
  let opened: Awaited<ReturnType<typeof openTitles>>[];
  let pending: Promise<unknown>[];
  let release: (() => void)[];

  beforeEach(async () => {
    failures = [];
    opened = [];
    pending = [];
    release = [];
    rejectExternalWork(failures);
    mock.timers.enable({ apis: ["setInterval"] });
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-ghostty-"));
    const cwd = path.join(directory, "octopus café");
    await mkdir(cwd);
    history = savedSession(cwd, path.join(directory, "sessions"), "Night shift 🐙");
  });

  afterEach(async () => {
    try {
      for (const app of opened) {
        app.session.clearQueue();
        app.session.abortCompaction();
      }
      for (const finish of release) finish();
      await Promise.all(opened.map((app) => app.session.abort()));
      await Promise.allSettled(pending);
    } finally {
      try {
        await Promise.all(opened.map((app) => app.dispose()));
        const before = opened.map((app) => [...app.titles]);
        mock.timers.tick(1000);
        assert.deepEqual(
          opened.map((app) => app.titles),
          before,
          "shutdown must stop all future title writes",
        );
        assert.deepEqual(failures, [], "unexpected work and extension errors must surface");
      } finally {
        mock.timers.reset();
        mock.restoreAll();
        syncBuiltinESMExports();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("keeps tool and waiting status accurate through parallel tools and a queued follow-up", async () => {
    const secret = "The espresso password is eight tiny umbrellas. 🐙\n";
    await writeFile(path.join(history.getCwd(), "recipe.txt"), secret);
    const permission = deferred<boolean>();
    const inspection = deferred<boolean>();
    release.push(
      () => permission.resolve(false),
      () => inspection.resolve(false),
    );
    const writeEnded = deferred<void>();
    const inspectionStarted = deferred<void>();
    const answer = heldReply();
    const followUp = heldReply();
    let requests = 0;
    let dialogs = 0;
    const app = await openTitles(directory, history, failures, {
      generate: (_model, _context, options) => {
        requests++;
        if (requests === 1) {
          return completedReply({
            ...assistantMessage(""),
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "recipe", name: "read", arguments: { path: "recipe.txt" } },
              {
                type: "toolCall",
                id: "menu",
                name: "write",
                arguments: { path: "menu.txt", content: "Umbrella espresso\n" },
              },
            ],
          });
        }
        assert.ok(requests <= 3, "no unplanned model work");
        return (requests === 2 ? answer : followUp).start(options?.signal);
      },
      confirm: () => (++dialogs === 1 ? permission.promise : inspection.promise),
      extension: (pi) => {
        pi.on("tool_call", async (event, ctx) => {
          if (event.toolName === "read") {
            if (!(await ctx.ui.confirm("Open the recipe?", "The café keeps secrets."))) {
              return { block: true, reason: "Recipe stays closed" };
            }
          }
        });
        pi.on("tool_result", async (event, ctx) => {
          if (event.toolName === "read") await ctx.ui.confirm("Recipe inspected?", "Continue?");
        });
        pi.on("tool_execution_end", (event) => {
          if (event.toolCallId === "menu") writeEnded.resolve();
        });
        pi.on("ui_prompt_start", (event) => {
          if (event.title === "Recipe inspected?") inspectionStarted.resolve();
        });
      },
    });
    opened.push(app);
    const work = app.session.prompt("Read the recipe and write today's menu.");
    pending.push(work);
    await app.waitForTitle((title) => title === "? · octopus café · Night shift 🐙 · read");
    app.session.setSessionName("Umbrella service");
    await app.waitForTitle((title) => title === "? · octopus café · Umbrella service · read");
    const waiting = [...app.titles];
    mock.timers.tick(1000);
    assert.deepEqual(app.titles, waiting, "waiting for a user must not animate as working");

    permission.resolve(true);
    await ready(Promise.all([writeEnded.promise, inspectionStarted.promise]));
    assert.equal(dialogs, 2);
    assert.equal(
      await readFile(path.join(history.getCwd(), "menu.txt"), "utf8"),
      "Umbrella espresso\n",
    );
    assert.equal(
      app.title,
      "? · octopus café · Umbrella service · read",
      "finishing write must not erase the outstanding read",
    );
    inspection.resolve(true);
    await ready(answer.started);
    assertWorkingTitle(app.title, "octopus café · Umbrella service");
    const result = app.session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "recipe",
    );
    assert.ok(result?.role === "toolResult" && !result.isError);
    assert.deepEqual(result.content, [{ type: "text", text: secret }]);
    await app.session.followUp("And close the café.");
    const continuingFrom = app.titles.length;

    answer.finish(assistantMessage("The umbrellas are ready."));
    await ready(followUp.started);
    assert.equal(app.session.isIdle, false);
    assertWorkingTitle(app.title, "octopus café · Umbrella service");
    assert.ok(
      app.titles.slice(continuingFrom).every((title) => !title.startsWith("π · ")),
      "agent_end must not advertise idle while a follow-up remains",
    );
    app.events.emit("review:start", { sessionKey: history.getSessionFile() });
    app.events.emit("subagent:start", { sessionKey: history.getSessionFile() });
    assertWorkingTitle(app.title, "octopus café · Umbrella service");
    followUp.finish(assistantMessage("Café closed."));
    await work;
    await app.session.waitForIdle();
    assertWorkingTitle(
      app.title,
      "octopus café · Umbrella service · review",
      "settling the main agent must not hide its background review",
    );
    app.events.emit("review:end", { sessionKey: history.getSessionFile() });
    assertWorkingTitle(
      app.title,
      "octopus café · Umbrella service · subagent",
      "a completed review must not hide active subagents",
    );
    app.events.emit("subagent:end", { sessionKey: history.getSessionFile() });
    assert.equal(app.title, "π · octopus café · Umbrella service");
    const settled = [...app.titles];
    mock.timers.tick(1000);
    assert.deepEqual(app.titles, settled);
    assert.equal(requests, 3);
  });

  for (const outcome of ["success", "failure", "abort"] as const) {
    test(`clears compaction status after ${outcome} without leaving a spinning idle session`, async () => {
      const summary = heldReply();
      let requests = 0;
      const app = await openTitles(directory, history, failures, {
        generate: (_model, _context, options) => {
          assert.equal(++requests, 1, "only the requested summary may be generated");
          return summary.start(options?.signal);
        },
      });
      opened.push(app);
      const compaction = app.session.compact();
      pending.push(compaction);
      const outcomeResult = compaction.then(
        () => undefined,
        (error: unknown) => error,
      );
      await ready(summary.started);
      assertWorkingTitle(app.title, "octopus café · Night shift 🐙 · compacting");
      app.session.setSessionName("Condensed coffee");
      await app.waitForTitle((title) => title.endsWith(" · Condensed coffee · compacting"));
      mock.timers.tick(1000);
      assertWorkingTitle(app.title, "octopus café · Condensed coffee · compacting");

      if (outcome === "abort") app.session.abortCompaction();
      else
        summary.finish(
          outcome === "success"
            ? assistantMessage("The café serves umbrella espresso.")
            : {
                ...assistantMessage(""),
                stopReason: "error",
                errorMessage: "Fixture summary unavailable",
              },
        );
      const error = await outcomeResult;
      if (outcome === "success") assert.equal(error, undefined);
      else
        assert.ok(
          error instanceof Error,
          "failure or cancellation must not masquerade as successful compaction",
        );
      assert.equal(
        history.getEntries().filter((entry) => entry.type === "compaction").length,
        outcome === "success" ? 1 : 0,
      );
      assert.equal(app.title, "π · octopus café · Condensed coffee");
      const settled = [...app.titles];
      mock.timers.tick(1000);
      assert.deepEqual(app.titles, settled);
    });
  }

  for (const kind of ["review", "subagent"]) {
    test(`scopes background ${kind} titles to their session and releases ownership on reload and resume`, async () => {
      const app = await openTitles(directory, history, failures);
      opened.push(app);
      const originalFile = history.getSessionFile()!;
      const otherCwd = path.join(directory, "moon bakery");
      await mkdir(otherCwd);
      const other = savedSession(
        otherCwd,
        path.join(directory, "other sessions"),
        "Lunar croissants",
      );
      const neighbor = await openTitles(directory, other, failures);
      opened.push(neighbor);
      assert.equal(app.title, "π · octopus café · Night shift 🐙");
      assert.equal(neighbor.title, "π · moon bakery · Lunar croissants");
      const entries = structuredClone(history.getEntries());

      app.events.emit(`${kind}:start`, { sessionKey: other.getSessionFile() });
      app.events.emit(`${kind}:start`, { sessionKey: "  " });
      assert.equal(
        app.title,
        "π · octopus café · Night shift 🐙",
        "foreign or invalid lifecycle messages do not make this tab busy",
      );
      app.events.emit(`${kind}:start`, { sessionKey: originalFile });
      assertWorkingTitle(app.title, `octopus café · Night shift 🐙 · ${kind}`);
      neighbor.events.emit(`${kind}:start`, { sessionKey: other.getSessionFile() });
      assertWorkingTitle(neighbor.title, `moon bakery · Lunar croissants · ${kind}`);
      app.session.setSessionName("");
      await app.waitForTitle((title) => title.endsWith(` · octopus café · ${kind}`));
      mock.timers.tick(1000);
      assertWorkingTitle(app.title, `octopus café · ${kind}`);
      assertWorkingTitle(neighbor.title, `moon bakery · Lunar croissants · ${kind}`);
      app.events.emit(`${kind}:end`, { sessionKey: other.getSessionFile() });
      assertWorkingTitle(app.title, `octopus café · ${kind}`);
      app.events.emit(`${kind}:end`, { sessionKey: originalFile });
      assert.equal(app.title, "π · octopus café");
      assert.deepEqual(
        history.getEntries().slice(0, -1),
        entries,
        "transient title status must not write session entries",
      );

      app.events.emit(`${kind}:start`, { sessionKey: originalFile });
      await app.session.reload();
      assert.equal(app.title, "π · octopus café");
      const neighborUpdates = neighbor.titles.length;
      mock.timers.tick(1000);
      assert.ok(
        neighbor.titles.length > neighborUpdates,
        "the other session continues updating its busy title",
      );
      assert.equal(app.title, "π · octopus café", "the replaced spinner cannot reclaim the title");
      assertWorkingTitle(
        neighbor.title,
        `moon bakery · Lunar croissants · ${kind}`,
        "reloading one instance must not stop another",
      );
      await neighbor.dispose();
      await app.runtime.switchSession(other.getSessionFile()!);
      assert.equal(app.title, "π · moon bakery · Lunar croissants");
      app.events.emit(`${kind}:end`, { sessionKey: originalFile });
      mock.timers.tick(1000);
      assert.equal(
        app.title,
        "π · moon bakery · Lunar croissants",
        "late old-session events cannot restore old metadata",
      );
    });
  }
});

/** Adapt only title output, blocking dialogs and model generation; lifecycle, tools and replacement use real Pi APIs. */
async function openTitles(
  directory: string,
  history: SessionManager,
  failures: unknown[],
  options: {
    generate?: NonNullable<ProviderConfig["streamSimple"]>;
    confirm?: () => Promise<boolean>;
    extension?: ExtensionFactory;
  } = {},
) {
  let events!: ExtensionAPI["events"];
  const titles: string[] = [];
  const changed = new Set<() => void>();
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [
        ghostty,
        (pi) => {
          events = pi.events;
          pi.registerProvider(fixtureModel.provider, {
            api: fixtureModel.api,
            baseUrl: fixtureModel.baseUrl,
            apiKey: "fixture-only",
            models: [fixtureModel],
            streamSimple: (...args) => {
              try {
                assert.ok(options.generate, "Unexpected model request");
                return options.generate(...args);
              } catch (error) {
                failures.push(error);
                throw error;
              }
            },
          });
        },
        ...(options.extension ? [options.extension] : []),
      ]);
      resources.settingsManager.applyOverrides({
        compaction: { enabled: false, keepRecentTokens: 20 },
      });
      return {
        ...(await createAgentSession({
          ...resources,
          sessionManager,
          sessionStartEvent,
          model: fixtureModel,
          tools: ["read", "write"],
        })),
        services: { ...resources, diagnostics: [] },
        diagnostics: [],
      };
    },
    { cwd: history.getCwd(), agentDir: path.join(directory, "agent"), sessionManager: history },
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await runtime.services.settingsManager.flush();
    } finally {
      await runtime.dispose();
    }
  };
  try {
    const bind = async () => {
      await runtime.session.bindExtensions({
        mode: "tui",
        uiContext: uiBoundary(
          {
            setTitle(title) {
              titles.push(title);
              for (const notify of changed) notify();
            },
            ...(options.confirm ? { confirm: options.confirm } : {}),
          },
          failures,
        ),
        onError: (error) => failures.push(error),
      });
    };
    runtime.setRebindSession(bind);
    await bind();
    return {
      runtime,
      get session() {
        return runtime.session;
      },
      get events() {
        return events;
      },
      titles,
      get title() {
        return titles.at(-1)!;
      },
      async waitForTitle(predicate: (title: string) => boolean) {
        const found = deferred<void>();
        const check = () => {
          if (predicate(titles.at(-1)!)) found.resolve();
        };
        changed.add(check);
        try {
          check();
          await ready(found.promise);
        } finally {
          changed.delete(check);
        }
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function savedSession(cwd: string, sessionDir: string, name: string) {
  const history = SessionManager.create(cwd, sessionDir);
  history.appendModelChange(fixtureModel.provider, fixtureModel.id);
  history.appendThinkingLevelChange("off");
  history.appendSessionInfo(name);
  history.appendMessage({ role: "user", content: "Plan the café night shift.", timestamp: 0 });
  history.appendMessage(assistantMessage("The octopus handles all eight espresso machines."));
  history.appendMessage({
    role: "user",
    content:
      "Keep the umbrellas dry. Store them on the top shelf, away from the steam wand, and leave a note for the morning crew.",
    timestamp: 1,
  });
  history.appendMessage(assistantMessage("Stored above the coffee steam."));
  return history;
}

/** Check semantic busy state and exact metadata, never an incidental animation frame or its direction. */
function assertWorkingTitle(title: string, metadata: string, message?: string) {
  assert.match(title, /^[\u2800-\u28ff] · /u, message);
  assert.equal(title.slice(title.indexOf(" · ") + 3), metadata, message);
}

function completedReply(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  assert.ok(message.stopReason === "stop" || message.stopReason === "toolUse");
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

/** Hold generation at a real provider boundary until an explicit reply or the owning Pi abort signal completes it. */
function heldReply() {
  const started = deferred<void>();
  let finish: ((message: AssistantMessage) => void) | undefined;
  return {
    started: started.promise,
    start(signal?: AbortSignal) {
      const stream = createAssistantMessageEventStream();
      let done = false;
      const abort = () => finish!({ ...assistantMessage(""), stopReason: "aborted" });
      finish = (message) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        if (message.stopReason === "error" || message.stopReason === "aborted")
          stream.push({ type: "error", reason: message.stopReason, error: message });
        else {
          assert.equal(message.stopReason, "stop");
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      };
      stream.push({ type: "start", partial: { ...assistantMessage(""), stopReason: "pending" } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      started.resolve();
      return stream;
    },
    finish(message: AssistantMessage) {
      assert.ok(finish, "provider must be ready before responding");
      finish(message);
    },
  };
}

/** Deadlines only bound readiness failures; interval time is controlled separately without sleeping. */
async function ready<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Ghostty workflow did not reach readiness")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rejectExternalWork(failures: unknown[]) {
  const reject = () => {
    const error = new Error("Unexpected network request or subprocess in ghostty workflow");
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  for (const method of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const)
    mock.method(childProcess, method, reject);
  syncBuiltinESMExports();
}
