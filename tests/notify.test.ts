import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import notify from "../extensions/notify.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

describe("notify", { concurrency: false }, () => {
  let directory: string;
  let terminal: ReturnType<typeof captureTerminal>;
  let failures: unknown[];
  let app: Awaited<ReturnType<typeof openNotify>> | undefined;
  let dialogs: ReturnType<typeof confirmation>[];

  beforeEach(async () => {
    failures = [];
    dialogs = [];
    terminal = captureTerminal(failures);
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-notify-"));
  });

  afterEach(async () => {
    try {
      for (const dialog of dialogs) dialog.answer(false);
      await app?.dispose();
      await nextImmediate();
      assert.deepEqual(failures, [], "unexpected external work and extension errors are failures");
    } finally {
      app = undefined;
      terminal.restore();
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const protocol of ["OSC 9", "OSC 99"] as const) {
    test(`${protocol}: alerts only after the reply and queued follow-up have both finished`, async () => {
      if (protocol === "OSC 99") process.env.KITTY_WINDOW_ID = "octopus-window";
      const first = reply("Life jackets checked.", true);
      const second = reply("The espresso machine has a lifeboat.", true);
      app = await openNotify(directory, failures, [first, second]);
      const prompt = app.prompt("Check the life jackets.");
      await ready(first.started);
      await app.session.followUp("And the espresso machine?");
      await nextImmediate();
      assert.equal(terminal.output(), "", "no alert while the first response is streaming");

      first.finish();
      await ready(second.started);
      await nextImmediate();
      assert.equal(app.session.isIdle, false);
      assert.equal(terminal.output(), "", "a queued continuation is not a request for user input");

      second.finish();
      await prompt;
      await app.session.waitForIdle();
      await nextImmediate();
      assert.equal(app.session.pendingMessageCount, 0);
      assert.equal(
        terminal.output(),
        protocol === "OSC 9"
          ? "\x1b]9;Pi: Ready for input\x1b\\"
          : "\x1b]99;i=1:d=0;Pi\x1b\\\x1b]99;i=1:p=body;Ready for input\x1b\\",
        "one complete native notification, including protocol framing and title/body pairing",
      );
    });
  }

  test("overlapping extension questions produce one waiting alert and suppress completion alerts until all close", async () => {
    const first = confirmation();
    const second = confirmation();
    dialogs.push(first, second);
    app = await openNotify(directory, failures, [reply(), reply()], {
      confirm: (title) => {
        const dialog = title === "Life jackets?" ? first : second;
        dialog.show();
        return dialog.result;
      },
    });
    const firstPrompt = app.prompt("/ask Life jackets?");
    await ready(first.shown);
    const secondPrompt = app.prompt("/ask Espresso lifeboat?");
    await ready(second.shown);
    await nextImmediate();
    assert.equal(terminal.output(), osc9("Waiting for input"));

    first.answer(true);
    await firstPrompt;
    app.events.emit("review:start", { sessionKey: app.sessionKey });
    await app.prompt("Finish checking the hull while I answer.");
    app.events.emit("review:end", { sessionKey: app.sessionKey, outcome: "success" });
    await nextImmediate();
    assert.equal(
      terminal.output(),
      osc9("Waiting for input"),
      "closing one question must not invite input or report review completion over the remaining question",
    );

    second.answer(false);
    await secondPrompt;
    await app.prompt("All questions answered; finish the checklist.");
    await nextImmediate();
    assert.equal(terminal.output(), osc9("Waiting for input") + osc9("Ready for input"));
  });

  test("review suppression is session-scoped, ends with the review, and resets on reload", async () => {
    app = await openNotify(directory, failures, [reply(), reply(), reply()]);
    const other = `session:${SessionManager.inMemory(directory).getSessionId()}`;
    app.events.emit("review:start", { sessionKey: other });
    await app.prompt("Check our lifeboat, not the neighboring submarine.");
    app.events.emit("review:end", { sessionKey: other, outcome: "failed" });
    await nextImmediate();
    assert.equal(terminal.output(), osc9("Ready for input"));

    app.events.emit("review:start", { sessionKey: app.sessionKey });
    await app.prompt("Summarize while the safety review continues.");
    await nextImmediate();
    assert.equal(terminal.output(), osc9("Ready for input"), "the review is still working");
    app.events.emit("review:end", { sessionKey: app.sessionKey, outcome: "success" });
    assert.equal(terminal.output(), osc9("Ready for input") + osc9("Review completed"));

    await app.session.reload();
    app.events.emit("review:start", { sessionKey: app.sessionKey });
    app.events.emit("review:end", { sessionKey: app.sessionKey, outcome: "success" });
    assert.equal(
      terminal.output(),
      osc9("Ready for input") + osc9("Review completed").repeat(2),
      "reload must not leave duplicate review listeners",
    );
    await app.prompt("One last ordinary checklist.");
    await nextImmediate();
    assert.equal(
      terminal.output(),
      osc9("Ready for input") + osc9("Review completed").repeat(2) + osc9("Ready for input"),
      "review completion restores ordinary readiness notifications",
    );
  });

  for (const [outcome, body] of [
    ["success", "Review completed"],
    ["failed", "Review failed"],
    ["cancelled", "Review cancelled"],
  ] as const) {
    test(`review ${outcome} supersedes a readiness alert queued in the same completion window`, async () => {
      app = await openNotify(directory, failures, [reply(), reply()]);
      app.events.emit("review:start", { sessionKey: app.sessionKey });
      await app.prompt("Finish the main checklist while the background review wraps up.");
      assert.equal(app.session.isIdle, true);
      assert.equal(terminal.output(), "", "readiness is deferred until other extensions react");

      app.events.emit("review:end", { sessionKey: app.sessionKey, outcome });
      // Cross the check phase after Pi has settled: the queued readiness callback has now run or been cancelled.
      await nextImmediate();
      assert.equal(
        terminal.output(),
        osc9(body),
        "one outcome, not a second competing ready alert",
      );

      await app.prompt("A fresh checklist needs its own readiness alert.");
      await nextImmediate();
      assert.equal(terminal.output(), osc9(body) + osc9("Ready for input"));
    });
  }

  for (const redirected of ["stdin", "stdout"] as const) {
    test(`redirected ${redirected} stays silent for questions, review outcomes and agent settlement`, async () => {
      terminal.setTTY(redirected, false);
      process.env.WT_SESSION = "must-not-launch-powershell";
      app = await openNotify(directory, failures, [reply()], { confirm: async () => false });
      await app.prompt("/ask Send the submarine?");
      app.events.emit("review:start", { sessionKey: app.sessionKey });
      app.events.emit("review:end", { sessionKey: app.sessionKey, outcome: "cancelled" });
      await app.prompt("Keep the submarine docked.");
      await nextImmediate();
      assert.equal(
        terminal.output(),
        "",
        "no control sequences in redirected streams or native toast launch",
      );
    });
  }

  test("shutdown cancels deferred readiness before it can notify after exit", async () => {
    app = await openNotify(directory, failures, [reply()]);
    await app.prompt("Close the café.");
    assert.equal(terminal.output(), "");
    await app.dispose();
    await nextImmediate();
    assert.equal(terminal.output(), "", "no late terminal write after runtime disposal");
  });
});

/** Real Pi sessions, event bus, UI prompt spans and queues; only generation and dialog answers are scripted. */
async function openNotify(
  directory: string,
  failures: unknown[],
  replies: ReturnType<typeof reply>[],
  ui: Partial<ExtensionUIContext> = {},
) {
  let events!: ExtensionAPI["events"];
  let requests = 0;
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const resources = await createPiResources(cwd, agentDir, [
        notify,
        (pi) => {
          events = pi.events;
          pi.registerCommand("ask", {
            description: "Fixture extension question",
            handler: async (title, ctx) => {
              await ctx.ui.confirm(title, "Keep the café afloat?");
            },
          });
          pi.registerProvider(fixtureModel.provider, {
            api: fixtureModel.api,
            baseUrl: fixtureModel.baseUrl,
            apiKey: "fixture-only",
            models: [fixtureModel],
            streamSimple: (_model, _context, options) => {
              const response = replies[requests++];
              if (!response) {
                const error = new Error("Unexpected model request");
                failures.push(error);
                throw error;
              }
              return response.start(options?.signal);
            },
          });
        },
      ]);
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
    {
      cwd: directory,
      agentDir: path.join(directory, "agent"),
      sessionManager: SessionManager.inMemory(directory),
    },
  );
  const pending: Promise<void>[] = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      runtime.session.clearQueue();
      await runtime.session.abort();
      await Promise.all(pending);
      await runtime.services.settingsManager.flush();
    } finally {
      await runtime.dispose();
    }
  };
  try {
    await runtime.session.bindExtensions({
      mode: "tui",
      uiContext: uiBoundary(ui, failures),
      onError: (error) => failures.push(error),
    });
    return {
      get session() {
        return runtime.session;
      },
      get sessionKey() {
        return runtime.session.sessionFile ?? `session:${runtime.session.sessionId}`;
      },
      get events() {
        return events;
      },
      prompt(text: string) {
        const work = runtime.session.prompt(text);
        pending.push(work);
        return work;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Capture transport bytes before they reach a terminal; reject all subprocess/network work, including PowerShell. */
function captureTerminal(failures: unknown[]) {
  const output: string[] = [];
  const streams = { stdin: process.stdin, stdout: process.stdout };
  const descriptors = Object.fromEntries(
    Object.entries(streams).map(([name, stream]) => [
      name,
      Object.getOwnPropertyDescriptor(stream, "isTTY"),
    ]),
  );
  const previous = {
    WT_SESSION: process.env.WT_SESSION,
    KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
  };
  delete process.env.WT_SESSION;
  delete process.env.KITTY_WINDOW_ID;
  const reject = () => {
    const error = new Error("Unexpected subprocess or network request in notify workflow");
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
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
  const write = process.stdout.write.bind(process.stdout);
  mock.method(process.stdout, "write", (...args: Parameters<typeof write>) => {
    // node:test sends binary IPC on stdout; leave it intact. The extension writes terminal strings.
    if (typeof args[0] !== "string") return write(...args);
    output.push(args[0]);
    const callback = typeof args[1] === "function" ? args[1] : args[2];
    callback?.();
    return true;
  });
  const setTTY = (name: keyof typeof streams, value: boolean) => {
    Object.defineProperty(streams[name], "isTTY", { configurable: true, value });
  };
  setTTY("stdin", true);
  setTTY("stdout", true);
  return {
    output: () => output.join(""),
    setTTY,
    restore() {
      for (const [name, stream] of Object.entries(streams)) {
        const descriptor = descriptors[name];
        if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
        else Reflect.deleteProperty(stream, "isTTY");
      }
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** A cancellable native provider stream; held replies expose a readiness handshake instead of timing assumptions. */
function reply(text = "The octopus approves the checklist.", held = false) {
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const stream = createAssistantMessageEventStream();
  let finish!: () => void;
  return {
    started,
    start(signal?: AbortSignal) {
      const abort = () => {
        signal?.removeEventListener("abort", abort);
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...assistantMessage(""), stopReason: "aborted" },
        });
        stream.end();
      };
      finish = () => {
        signal?.removeEventListener("abort", abort);
        stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
        stream.end();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else if (!held) finish();
      start();
      return stream;
    },
    finish: () => finish(),
  };
}

function confirmation() {
  let show!: () => void;
  let answer!: (value: boolean) => void;
  const shown = new Promise<void>((resolve) => {
    show = resolve;
  });
  const result = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  return { shown, show, result, answer };
}

function osc9(body: string) {
  return `\x1b]9;Pi: ${body}\x1b\\`;
}

/** A deadline only for missing readiness; teardown aborts streams and joins commands on assertion failure. */
async function ready<T>(promise: Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Notify workflow did not reach readiness")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
