import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  initTheme,
  SessionManager,
  type ExtensionFactory,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import btw from "../extensions/btw.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

const model = { ...fixtureModel, provider: "btw-fixture", reasoning: true };

describe("btw", { concurrency: false }, () => {
  let directory: string;
  let history: SessionManager;
  let branchPoint: string;
  let failures: unknown[];
  let app: Awaited<ReturnType<typeof openBtw>> | undefined;

  beforeEach(async () => {
    failures = [];
    const rejectExternalWork = () => {
      const error = new Error("Unexpected network request or subprocess in BTW workflow");
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

    directory = await mkdtemp(path.join(os.tmpdir(), "tau-btw-"));
    const cwd = path.join(directory, "cafe");
    await mkdir(cwd);
    history = SessionManager.create(cwd, path.join(directory, "sessions"));
    history.appendModelChange(model.provider, model.id);
    history.appendThinkingLevelChange("high");
    history.appendMessage({ role: "user", content: "Plan the café release.", timestamp: 0 });
    branchPoint = history.appendMessage(assistantMessage("The octopus owns the rollback."));
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, [], "unexpected external work and extension errors stay visible");
    } finally {
      app = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reads the selected branch's project without allowing writes or persisting the side conversation", async () => {
    history.appendMessage({ role: "user", content: "Abandoned submarine plan.", timestamp: 1 });
    history.appendMessage(assistantMessage("Replace the café with a submarine."));
    const file = path.join(history.getCwd(), "menu.txt");
    const menu = "café special: kelp croissant 🐙\n  keep these spaces  \n";
    await writeFile(file, menu);
    app = await openBtw(directory, history, failures);
    await app.session.navigateTree(branchPoint, { summarize: false });
    const before = await readFile(history.getSessionFile()!);
    const messages = structuredClone(app.session.messages);
    const tools = app.session.getActiveToolNames();
    const first = app.expectRequest();
    const second = app.expectRequest();
    const outcome = app.nextOutcome();
    const question = "What is on menu.txt? Do not change the café.";
    await app.session.prompt(`/btw   ${question}  `);
    const request = await deadline(first.started);

    assert.equal(request.model.id, model.id);
    assert.equal(request.model.provider, model.provider);
    assert.equal(request.options?.reasoning, "high");
    assert.equal(request.options?.apiKey, "fixture-only");
    assert.deepEqual(request.context.messages.map(messageText), [
      "Plan the café release.",
      "The octopus owns the rollback.",
      question,
    ]);
    assert.ok(request.context.systemPrompt?.includes(app.session.systemPrompt));
    assert.deepEqual(request.context.tools?.map((tool) => tool.name).sort(), [
      "find",
      "grep",
      "ls",
      "read",
    ]);
    first.reply({
      ...assistantMessage(""),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "read-menu", name: "read", arguments: { path: "menu.txt" } },
        {
          type: "toolCall",
          id: "write-menu",
          name: "write",
          arguments: { path: "menu.txt", content: "submarine soup" },
        },
      ],
    });
    const followup = await deadline(second.started);
    const results = followup.context.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 2);
    assert.equal(results.find((result) => result.toolCallId === "read-menu")?.isError, false);
    assert.equal(messageText(results.find((result) => result.toolCallId === "read-menu")!), menu);
    assert.equal(results.find((result) => result.toolCallId === "write-menu")?.isError, true);
    second.reply({
      ...assistantMessage(""),
      content: [
        { type: "thinking", thinking: "Secret squid deliberation." },
        { type: "text", text: "**Kelp croissant** 🐙" },
        { type: "text", text: "Ask in the main conversation for menu changes." },
      ],
    });
    const result = await deadline(outcome);
    assert.equal(result.kind, "dialog");
    if (result.kind !== "dialog") return;
    const text = screen(result.component);
    assert.ok(text.includes(question));
    assert.match(text, /Kelp croissant/);
    assert.match(text, /Ask in the main conversation/);
    assert.doesNotMatch(text, /Secret squid/);
    press(result.component, "\r");
    await deadline(result.closed);

    assert.equal(await readFile(file, "utf8"), menu);
    assert.deepEqual(await readFile(history.getSessionFile()!), before);
    assert.deepEqual(app.session.messages, messages);
    assert.deepEqual(app.session.getActiveToolNames(), tools);
    assert.equal(app.session.thinkingLevel, "high");
    assert.equal(app.statuses.size, 0);
    assert.equal(app.session.pendingMessageCount, 0);

    const main = app.expectRequest();
    const prompt = app.session.prompt("Continue the release plan.");
    const mainRequest = await deadline(main.started);
    assert.deepEqual(mainRequest.context.messages.map(messageText), [
      ...messages.map((message) => messageText(message as Context["messages"][number])),
      "Continue the release plan.",
    ]);
    main.reply(assistantMessage("Rollback ready."));
    await prompt;
    const persisted = SessionManager.open(history.getSessionFile()!).buildSessionContext().messages;
    assert.deepEqual(persisted, app.session.messages, "resuming sees only the main conversation");
  });

  test("answers alongside a streaming main turn without consuming its follow-up queue, and rejects duplicate side requests", async () => {
    app = await openBtw(directory, history, failures);
    const main = app.expectRequest();
    const mainRun = app.session.prompt("Prepare the deployment.");
    await deadline(main.started);
    await app.session.followUp("Then check the rollback.");
    const before = await readFile(history.getSessionFile()!);
    const side = app.expectRequest();
    const outcome = app.nextOutcome();
    await app.session.prompt("/btw Who owns rollback?");
    await deadline(side.started);
    assert.equal(app.session.isStreaming, true);
    assert.ok(app.statuses.size > 0);
    assert.equal(app.session.pendingMessageCount, 1);

    await app.session.prompt("/btw Buy the octopus a second answer.");
    assert.equal(app.notifications.at(-1)?.type, "warning");
    assert.match(app.notifications.at(-1)?.message ?? "", /already active/i);
    side.reply(assistantMessage("The octopus."));
    const result = await deadline(outcome);
    assert.equal(result.kind, "dialog");
    if (result.kind !== "dialog") return;
    assert.match(screen(result.component), /The octopus\./);
    press(result.component, "\x1b");
    await deadline(result.closed);
    assert.equal(app.session.isStreaming, true);
    assert.equal(app.session.pendingMessageCount, 1);
    assert.deepEqual(await readFile(history.getSessionFile()!), before);
    assert.equal(app.statuses.size, 0);

    const queued = app.expectRequest();
    main.reply(assistantMessage("Deployment prepared."));
    const request = await deadline(queued.started);
    assert.equal(messageText(request.context.messages.at(-1)!), "Then check the rollback.");
    assert.ok(
      !request.context.messages.some((message) =>
        messageText(message).includes("Who owns rollback?"),
      ),
    );
    queued.reply(assistantMessage("Rollback checked."));
    await mainRun;
    await app.session.waitForIdle();
    assert.equal(app.session.pendingMessageCount, 0);
    assert.equal(app.requests.length, 3);
  });

  test("shutdown cancels an in-flight side provider and clears its status without a result or history entry", async () => {
    app = await openBtw(directory, history, failures);
    const before = await readFile(history.getSessionFile()!);
    const side = app.expectRequest();
    await app.session.prompt("/btw Count all eight deployment tentacles.");
    const request = await deadline(side.started);
    assert.equal(request.options?.signal?.aborted, false);
    await app.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    assert.equal(
      request.options?.signal?.aborted,
      true,
      "shutdown must cancel the child, not just hide stale output",
    );
    await deadline(side.finished);
    assert.equal(app.dialogs.length, 0);
    assert.deepEqual(app.notifications, []);
    assert.equal(app.statuses.size, 0);
    assert.deepEqual(await readFile(history.getSessionFile()!), before);
  });

  test("reports a failed partial answer without presenting it as success, then accepts a fresh request", async () => {
    app = await openBtw(directory, history, failures);
    const before = await readFile(history.getSessionFile()!);
    const failure = app.expectRequest();
    const failed = app.nextOutcome();
    await app.session.prompt("/btw Is the release safe?");
    await deadline(failure.started);
    failure.reply({
      ...assistantMessage("Absolutely safe"),
      stopReason: "error",
      errorMessage: "Fixture credentials rejected",
    });
    const notice = await deadline(failed);
    assert.equal(notice.kind, "error");
    if (notice.kind === "error") assert.match(notice.message, /Fixture credentials rejected/);
    assert.equal(app.dialogs.length, 0);
    assert.equal(app.statuses.size, 0);

    const retry = app.expectRequest();
    const recovered = app.nextOutcome();
    await app.session.prompt("/btw Try the release check again.");
    await deadline(retry.started);
    retry.reply(assistantMessage("Review the rollback first."));
    const result = await deadline(recovered);
    assert.equal(result.kind, "dialog");
    if (result.kind !== "dialog") return;
    assert.match(screen(result.component), /Review the rollback first\./);
    assert.doesNotMatch(screen(result.component), /Absolutely safe/);
    press(result.component, "q");
    await deadline(result.closed);
    assert.equal(app.statuses.size, 0);
    assert.deepEqual(await readFile(history.getSessionFile()!), before);
  });

  for (const width of [80, 40]) {
    test(`retains a long answer while resizing through ${width} columns`, async () => {
      app = await openBtw(directory, history, failures);
      const reply = app.expectRequest();
      const outcome = app.nextOutcome();
      await app.session.prompt("/btw List the launch checks.");
      await deadline(reply.started);
      reply.reply(
        assistantMessage(
          Array.from(
            { length: 40 },
            (_, i) => `Checkpoint ${String(i + 1).padStart(2, "0")} 🐙`,
          ).join("\n\n"),
        ),
      );
      const result = await deadline(outcome);
      assert.equal(result.kind, "dialog");
      if (result.kind !== "dialog") return;
      app.dimensions.columns = 100;
      assert.match(screen(result.component, 100), /Checkpoint 01/);
      assert.doesNotMatch(screen(result.component, 100), /Checkpoint 40/);
      press(result.component, "\x1b[F"); // End
      assert.match(screen(result.component, 100), /Checkpoint 40/);
      press(result.component, "\x1b[H"); // Home
      assert.match(screen(result.component, 100), /Checkpoint 01/);
      app.dimensions.columns = width;
      result.component.invalidate();
      const lines = result.component.render(width);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `render(${width}) returned ${visibleWidth(line)} columns: ${stripVTControlCharacters(line)}`,
        );
      }
      press(result.component, "\x1b[F");
      if (width === 40) {
        assert.match(screen(result.component, width), /resize/i);
        app.dimensions.columns = 100;
        result.component.invalidate();
        assert.match(screen(result.component, 100), /Checkpoint 01/);
        press(result.component, "\x1b[F");
        assert.match(screen(result.component, 100), /Checkpoint 40/);
        assert.equal(app.requests.length, 1, "resizing must not regenerate the answer");
        app.dimensions.columns = width;
      } else {
        assert.match(screen(result.component, width), /Checkpoint 40/);
      }
      press(result.component, "\x03");
      await deadline(result.closed);
    });
  }
});

type Request = { model: Model<string>; context: Context; options?: SimpleStreamOptions };
type Dialog = { kind: "dialog"; component: Component; closed: Promise<void> };
type Outcome = Dialog | { kind: "error"; message: string };

/** Real Pi command dispatch, session history, tools and child runtime; only provider generation is scripted. */
async function openBtw(directory: string, history: SessionManager, failures: unknown[]) {
  const steps: ReturnType<typeof exchange>[] = [];
  const requests: Request[] = [];
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "fixture-only",
      models: [model],
      streamSimple(currentModel, context, options) {
        const request = {
          model: currentModel,
          context: {
            ...context,
            messages: structuredClone(context.messages),
            tools: context.tools?.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          },
          options,
        };
        const step = steps[requests.length];
        requests.push(request);
        if (!step) {
          const error = new Error("Unexpected BTW model request");
          failures.push(error);
          throw error;
        }
        return step.start(request);
      },
    });
  };
  const resources = await createPiResources(history.getCwd(), path.join(directory, "agent"), [
    btw,
    provider,
  ]);
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: history,
    model,
    tools: ["read", "write"],
  });
  const dialogs: Dialog[] = [];
  const notifications: { message: string; type: string | undefined }[] = [];
  const statuses = new Map<string, string>();
  let outcome = deferred<Outcome>();
  const mounts = new Set<Promise<unknown>>();
  const closers = new Set<() => void>();
  initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  const dimensions = { columns: 80, rows: 24 };
  const terminal = new Proxy(
    {
      get columns() {
        return dimensions.columns;
      },
      get rows() {
        return dimensions.rows;
      },
      stop() {},
      showCursor() {},
    } as Terminal,
    {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        const error = new Error(`Unexpected BTW terminal operation: ${String(key)}`);
        failures.push(error);
        throw error;
      },
    },
  );
  const tui = new TuiMainScreen(terminal);
  tui.stop(); // Render explicitly, never schedule physical terminal output.
  // The app manager is type-only; the factory does not use bindings. Reject app-only access.
  const keybindings = new Proxy(getKeybindings(), {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected BTW app keybinding: ${String(key)}`);
      failures.push(error);
      throw error;
    },
  }) as KeybindingsManager;

  const dispose = async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      for (const close of closers) close();
      await Promise.all(mounts);
      await session.abort();
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
    }
  };
  try {
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => failures.push(error),
      uiContext: uiBoundary(
        {
          theme,
          setStatus(key, value) {
            if (value === undefined) statuses.delete(key);
            else statuses.set(key, value);
          },
          notify(message, type) {
            notifications.push({ message, type });
            if (type === "error") outcome.resolve({ kind: "error", message });
          },
          // Mount the production component, exposing its public render/input contract.
          // No physical editor replacement or CLI/PTY behavior is simulated here.
          custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
            const done = deferred<unknown>();
            const closed = deferred<void>();
            const close = () => done.resolve(undefined);
            closers.add(close);
            const mount = (async () => {
              const component = await factory(tui, theme, keybindings, done.resolve);
              const dialog: Dialog = { kind: "dialog", component, closed: closed.promise };
              dialogs.push(dialog);
              outcome.resolve(dialog);
              try {
                return (await done.promise) as T;
              } finally {
                component.dispose?.();
                closers.delete(close);
                closed.resolve();
              }
            })();
            mounts.add(mount);
            return mount;
          },
        },
        failures,
      ),
    });
    return {
      session,
      requests,
      dialogs,
      notifications,
      statuses,
      dimensions,
      dispose,
      expectRequest() {
        const step = exchange();
        steps.push(step);
        return step;
      },
      nextOutcome() {
        outcome = deferred<Outcome>();
        return outcome.promise;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** A controllable provider stream: readiness is explicit and abort completes the real agent's stream. */
function exchange() {
  const started = deferred<Request>();
  const finished = deferred<void>();
  const stream = createAssistantMessageEventStream();
  let request: Request | undefined;
  let ended = false;
  const abort = () => reply({ ...assistantMessage(""), stopReason: "aborted" });
  function reply(message: AssistantMessage) {
    if (ended) return;
    ended = true;
    request?.options?.signal?.removeEventListener("abort", abort);
    const output = { ...message, provider: model.provider, model: model.id, api: model.api };
    if (output.stopReason === "error" || output.stopReason === "aborted") {
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } else {
      assert.ok(output.stopReason !== "pending");
      stream.push({ type: "done", reason: output.stopReason, message: output });
    }
    stream.end();
    finished.resolve();
  }
  return {
    started: started.promise,
    finished: finished.promise,
    reply,
    start(value: Request) {
      request = value;
      stream.push({ type: "start", partial: { ...assistantMessage(""), stopReason: "pending" } });
      value.options?.signal?.addEventListener("abort", abort, { once: true });
      if (value.options?.signal?.aborted) abort();
      started.resolve(value);
      return stream;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A deadline is only a failure safety net, never the synchronization mechanism. */
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("BTW workflow did not reach its next boundary")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function messageText(message: Context["messages"][number]) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function press(component: Component, key: string) {
  assert.ok(component.handleInput);
  component.handleInput(key);
}

function screen(component: Component, width = 80) {
  return component.render(width).map(stripVTControlCharacters).join("\n");
}
