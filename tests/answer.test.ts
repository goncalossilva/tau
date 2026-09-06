import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
} from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  createAgentSession,
  initTheme,
  SessionManager,
  type KeybindingsManager,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import answer from "../extensions/answer.js";
import { assistantMessage, createPiResources, fixtureModel, uiBoundary } from "./helpers/pi.js";

const currentModel = { ...fixtureModel, provider: "anthropic-answer-fixture" };
const fastModel = { ...currentModel, id: "claude-haiku-4-5" };
const questions = [
  {
    question: "What is the recovery plan?",
    context: "Keep the café online.\nNo octopus overtime.",
  },
  { question: "Who approves the release?" },
  { question: "Any final instructions?" },
];
const sourceText = [
  "What is the recovery plan? Keep the café online, with no octopus overtime.",
  "Who approves the release? Any final instructions?",
];
describe("answer", { concurrency: false }, () => {
  let directory: string | undefined;
  let history: SessionManager;
  let questionEntry: string;
  let ui: Awaited<ReturnType<typeof openAnswer>> | undefined;
  let failures: unknown[];

  beforeEach(async () => {
    failures = [];
    const rejectExternalWork = () => {
      const error = new Error("Unexpected network request or subprocess in answer workflow");
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

    directory = await mkdtemp(path.join(os.tmpdir(), "tau-answer-"));
    const cwd = path.join(directory, "work");
    await mkdir(cwd);
    history = SessionManager.create(cwd, path.join(directory, "sessions"));
    history.appendModelChange(currentModel.provider, currentModel.id);
    history.appendMessage({ role: "user", content: "Plan the café release.", timestamp: 0 });
    questionEntry = history.appendMessage({
      ...assistantMessage(""),
      provider: currentModel.provider,
      content: [
        { type: "text", text: sourceText[0] },
        { type: "thinking", thinking: "Private deliberation is not a user question." },
        { type: "text", text: sourceText[1] },
      ],
    });
  });

  afterEach(async () => {
    try {
      await ui?.dispose();
      assert.deepEqual(failures, [], "unexpected work or extension errors must not be swallowed");
    } finally {
      ui = undefined;
      mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  test("answers the selected branch, preserving pasted answers through revision and durable submission", async () => {
    const abandoned = "Should we replace the café with a submarine?";
    history.appendMessage({ role: "user", content: "Try another plan.", timestamp: 1 });
    history.appendMessage(assistantMessage(abandoned));
    const multiline =
      "  " +
      Array.from({ length: 12 }, (_, i) => `${i + 1}. Restore café lane ${i + 1} 🐙`).join("\n");
    const longLine = "Keep the jellyfish away from the deploy button. ".repeat(30) + "  ";
    const expected = [
      `Q: ${questions[0].question}`,
      "> Keep the café online.",
      "> No octopus overtime.",
      "",
      `A: ${multiline.trim()}\nSigned by the night octopus.`,
      "",
      `Q: ${questions[1].question}`,
      "A: (no answer)",
      "",
      `Q: ${questions[2].question}`,
      `A: ${longLine}Release only after review.`,
    ].join("\n");

    ui = await openAnswer(
      directory!,
      history,
      failures,
      [extraction(), assistantMessage("Plan accepted.")],
      (form) => {
        assert.match(screen(form), /What is the recovery plan\?/);
        paste(form, multiline);
        press(form, "\t");
        press(form, "\x1b[Z"); // Shift+Tab: revisit the answer after its paste store was replaced.
        press(form, "\x05"); // End of line.
        press(form, "\x1b[13;2u"); // Shift+Enter, encoded by a Kitty-compatible terminal.
        paste(form, "Signed by the night octopus.");
        press(form, "\r");
        assert.match(screen(form), /Who approves the release\?/);
        press(form, "\r"); // Leave this answer blank.
        assert.match(screen(form), /Any final instructions\?/);
        paste(form, longLine);
        press(form, "\r");
        assert.match(screen(form), /Submit all answers\?/);
        assert.equal(
          history.getEntries().filter((entry) => entry.type === "custom_message").length,
          0,
        );
        assert.equal(ui!.requests.length, 1, "confirmation must precede any answering turn");
        press(form, "\x1b"); // Return to editing rather than cancelling the questionnaire.
        assert.doesNotMatch(screen(form), /Submit all answers\?/);
        press(form, "\x05");
        paste(form, "Release only after review.");
        press(form, "\r");
        press(form, "y");
      },
    );
    await ui.session.navigateTree(questionEntry, { summarize: false });
    const before = structuredClone(history.getEntries());
    await ui.run();

    assert.equal(ui.openedQuestionnaires, 1);
    assert.equal(ui.requests.length, 2, "one extraction and one triggered answer turn");
    const [extractRequest, answerRequest] = ui.requests;
    assert.equal(extractRequest.model.id, fastModel.id);
    assert.equal(extractRequest.model.provider, currentModel.provider);
    assert.deepEqual(extractRequest.context.messages.map(messageText), [sourceText.join("\n")]);
    assert.equal(extractRequest.context.messages[0].role, "user");
    assert.equal(
      answerRequest.model.id,
      currentModel.id,
      "extraction must not switch the main model",
    );
    for (const request of ui.requests) assert.deepEqual(request.context.tools ?? [], []);

    const reopened = SessionManager.open(history.getSessionFile()!);
    assert.deepEqual(
      reopened.getEntries().slice(0, before.length),
      before,
      "both old branches remain intact",
    );
    const answers = reopened.getBranch().filter((entry) => entry.type === "custom_message");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].customType, "answers");
    assert.equal(answers[0].display, true);
    assert.equal(answers[0].parentId, questionEntry);
    const content = answers[0].content;
    assert.ok(typeof content === "string");
    assert.equal(
      content.slice(content.indexOf("Q: ")),
      expected,
      "question, context and answer bytes survive",
    );
    assert.equal(
      messageText(answerRequest.context.messages.at(-1)!),
      content,
      "the model receives the persisted answers",
    );
    assert.equal(answerRequest.context.messages.at(-1)!.role, "user");
    assert.ok(
      !answerRequest.context.messages.some((message) => messageText(message).includes(abandoned)),
    );
    assert.equal(ui.session.getLastAssistantText(), "Plan accepted.");
    assert.deepEqual(ui.notifications, []);
  });

  test("backs out of confirmation, cancels without sending, and starts the next questionnaire empty", async () => {
    let attempt = 0;
    ui = await openAnswer(directory!, history, failures, [extraction(), extraction()], (form) => {
      if (++attempt === 1) {
        paste(form, "Do not send the jellyfish's password.");
        press(form, "\r");
        press(form, "\r");
        press(form, "\r");
        assert.match(screen(form), /Submit all answers\?/);
        press(form, "n");
        press(form, "\x1b[Z");
        press(form, "\x1b[Z");
        assert.match(screen(form), /Do not send the jellyfish's password\./);
      } else {
        assert.match(screen(form), /What is the recovery plan\?/);
        assert.doesNotMatch(screen(form), /jellyfish's password/);
      }
      press(form, "\x1b");
    });
    const before = await readFile(history.getSessionFile()!);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await ui.run();
      assert.equal(ui.requests.length, attempt, "cancelling must not trigger a reply");
      assert.equal(ui.session.pendingMessageCount, 0);
      assert.deepEqual(
        await readFile(history.getSessionFile()!),
        before,
        "no draft or cancellation enters history",
      );
      assert.equal(ui.notifications.at(-1)?.type, "info");
      assert.match(ui.notifications.at(-1)?.message ?? "", /cancel/i);
    }
    assert.equal(ui.openedQuestionnaires, 2);
  });

  describe("extraction without a questionnaire", () => {
    for (const [name, reply, noticeType, message] of [
      [
        "provider failure with returned questions",
        {
          ...extraction(),
          stopReason: "error",
          errorMessage: "Fixture gateway unavailable",
        },
        "error",
        /Fixture gateway unavailable/,
      ],
      [
        "incomplete output with returned questions",
        { ...extraction(), stopReason: "length" },
        "error",
      ],
      [
        "a rejected provider request",
        new Error("The fixture gateway is on strike"),
        "error",
        /gateway is on strike/,
      ],
      [
        "malformed question context",
        assistantMessage(
          JSON.stringify({ questions: [{ question: "Where should we deploy?", context: 8 }] }),
        ),
        "error",
      ],
      [
        "an aborted extraction",
        { ...assistantMessage(""), stopReason: "aborted" },
        "info",
        /cancel/i,
      ],
      ["no pending questions", assistantMessage('{"questions":[]}'), "info", /no questions/i],
    ] satisfies [string, AssistantMessage | Error, "error" | "info", RegExp?][]) {
      test(`reports ${name} without soliciting answers or changing history`, async () => {
        ui = await openAnswer(directory!, history, failures, [reply], (form) =>
          press(form, "\x1b"),
        );
        const before = await readFile(history.getSessionFile()!);
        await ui.run();

        assert.equal(ui.requests.length, 1);
        assert.equal(
          ui.openedQuestionnaires,
          0,
          "only successful, nonempty extraction should solicit answers",
        );
        assert.deepEqual(await readFile(history.getSessionFile()!), before);
        assert.equal(ui.session.pendingMessageCount, 0);
        assert.equal(ui.notifications.length, 1);
        const notice = ui.notifications[0];
        assert.equal(
          notice.type,
          noticeType,
          "failure, cancellation and empty results remain distinct",
        );
        if (noticeType === "error") assert.doesNotMatch(notice.message, /cancel/i);
        if (message) assert.match(notice.message, message);
      });
    }
  });

  test("keeps every progress indicator within terminal width while navigating a long questionnaire", async () => {
    const questions = Array.from({ length: 40 }, (_, i) => ({
      question: `Approve café migration step ${i + 1}? 🐙`,
    }));
    const views: string[][] = [];
    ui = await openAnswer(
      directory!,
      history,
      failures,
      [assistantMessage(JSON.stringify({ questions }))],
      (form) => {
        views.push(form.render(80));
        for (let i = 1; i < questions.length; i++) press(form, "\t");
        views.push(form.render(80));
        press(form, "\x1b");
      },
    );
    await ui.run();

    assert.equal(ui.openedQuestionnaires, 1);
    assert.ok(views[0].map(stripVTControlCharacters).join("\n").includes(questions[0].question));
    assert.ok(
      views[1].map(stripVTControlCharacters).join("\n").includes(questions.at(-1)!.question),
    );
    for (const lines of views) {
      const plain = lines.map(stripVTControlCharacters).join("\n");
      assert.equal(
        plain.match(/[●○]/g)?.length,
        questions.length,
        "no progress indicators are clipped",
      );
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= 80,
          `render(80) returned ${visibleWidth(line)} columns: ${stripVTControlCharacters(line)}`,
        );
      }
    }
  });
});

/**
 * Run /answer through Pi's command dispatcher, model runtime and durable session.
 * Only generation is scripted; recorded requests are the actual provider-facing context.
 */
async function openAnswer(
  directory: string,
  history: SessionManager,
  failures: unknown[],
  replies: (AssistantMessage | Error)[],
  questionnaire: (form: Component) => void,
) {
  const requests: { model: Model<string>; context: Context }[] = [];
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider(currentModel.provider, {
      api: currentModel.api,
      baseUrl: currentModel.baseUrl,
      apiKey: "fixture-only",
      models: [currentModel, fastModel],
      streamSimple: (model, context) => {
        const reply = replies[requests.length];
        requests.push({ model, context: structuredClone(context) });
        if (!reply) {
          const error = new Error("Unexpected model request in answer workflow");
          failures.push(error);
          throw error;
        }
        if (reply instanceof Error) throw reply;
        return replyStream({ ...reply, provider: model.provider, model: model.id, api: model.api });
      },
    });
  };
  const resources = await createPiResources(history.getCwd(), path.join(directory, "agent"), [
    answer,
    provider,
  ]);
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: history,
    model: currentModel,
    tools: [],
  });
  const shutdown = async () => {
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await resources.settingsManager.flush();
    } finally {
      session.dispose();
    }
  };

  try {
    initTheme("dark", false);
    const dialogs = componentDialogs(
      session.extensionRunner.getUIContext().theme,
      questionnaire,
      failures,
    );
    await session.bindExtensions({
      uiContext: dialogs.context,
      mode: "tui",
      onError: (error) => failures.push(error),
    });
    return {
      session,
      requests,
      notifications: dialogs.notifications,
      get openedQuestionnaires() {
        return dialogs.openedQuestionnaires;
      },
      async run() {
        await session.prompt("/answer", { source: "interactive" });
        await session.waitForIdle();
        assert.deepEqual(failures, []);
      },
      dispose: shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/**
 * Drive the real custom components via their public render/input contract, without a physical terminal.
 * Only dialog mounting and notification output are adapted; this is not CLI/PTY end-to-end coverage.
 */
function componentDialogs(
  theme: ExtensionUIContext["theme"],
  questionnaire: (form: Component) => void,
  failures: unknown[],
) {
  const terminal = new Proxy({ columns: 80, rows: 24, showCursor() {}, stop() {} } as Terminal, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected terminal operation: ${String(key)}`);
      failures.push(error);
      throw error;
    },
  });
  const tui = new TuiMainScreen(terminal);
  tui.stop(); // Component renders are explicit; disable scheduled physical-terminal rendering.
  // Pi exports its app manager as a type only. Supply real TUI bindings, rejecting
  // app-only operations at this unused factory boundary rather than fabricating them.
  const keybindings = new Proxy(getKeybindings(), {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected app keybinding operation: ${String(key)}`);
      failures.push(error);
      throw error;
    },
  }) as KeybindingsManager;
  const notifications: { message: string; type: string | undefined }[] = [];
  let openedQuestionnaires = 0;
  const context = uiBoundary(
    {
      theme,
      notify: (message, type) => {
        notifications.push({ message, type });
      },
      async custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
        let done!: (value: unknown) => void;
        const result = new Promise<unknown>((resolve) => {
          done = resolve;
        });
        const component = await factory(tui, theme, keybindings, done);
        let deadline: NodeJS.Timeout | undefined;
        try {
          tui.setFocus(component);
          if (!(component instanceof BorderedLoader)) {
            openedQuestionnaires++;
            questionnaire(component);
          }
          return await Promise.race([
            result as Promise<T>,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error("Custom answer dialog did not finish")),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(deadline);
          tui.setFocus(null);
          component.dispose?.();
        }
      },
    },
    failures,
  );
  return {
    context,
    notifications,
    get openedQuestionnaires() {
      return openedQuestionnaires;
    },
  };
}

function extraction() {
  return assistantMessage("```json\n" + JSON.stringify({ questions }) + "\n```");
}

function replyStream(reply: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: reply });
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    stream.push({ type: "error", reason: reply.stopReason, error: reply });
  } else {
    assert.ok(reply.stopReason !== "pending");
    stream.push({ type: "done", reason: reply.stopReason, message: reply });
  }
  stream.end();
  return stream;
}

function press(component: Component, data: string) {
  assert.ok(component.handleInput);
  component.handleInput(data);
}

function paste(component: Component, text: string) {
  press(component, `\x1b[200~${text}\x1b[201~`);
}

function screen(component: Component) {
  return component.render(80).map(stripVTControlCharacters).join("\n");
}

function messageText(message: Context["messages"][number]) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
