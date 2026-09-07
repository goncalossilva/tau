import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  createAgentSession,
  getAgentDir,
  initTheme,
  SessionManager,
  type ExtensionFactory,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  TuiMainScreen,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  assistantMessage,
  createPiResources,
  fixtureModel,
  isolatePiHome,
  uiBoundary,
} from "./helpers/pi.js";

const report = "# Café insights 🐙\n\n## At a glance\nKeep the rollback drill.\n\n";
const instruction = "Keep the café online";
type Viewport = { columns: number; rows: number };

describe("insights", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>> | undefined;
  let extension: ExtensionFactory;
  let directory: string;
  let cwd: string;
  let sessions: string;
  let ui: Awaited<ReturnType<typeof openInsights>> | undefined;
  let failures: unknown[];

  before(async () => {
    home = await isolatePiHome();
    // Insights fixes its cache root at import time.
    ({ default: extension } = await import("../extensions/insights.js"));
  });

  after(async () => home?.dispose());

  beforeEach(async () => {
    failures = [];
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-insights-test-"));
    cwd = path.join(directory, "café");
    sessions = path.join(directory, "sessions");
    await mkdir(cwd);
    // Keep real report creation inside this case's owned directory.
    mock.method(os, "tmpdir", () => directory);
    const rejectExternalWork = () => {
      const error = new Error("Unexpected network request or subprocess in insights workflow");
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
    // Session entry timestamps, not message timestamps, determine meaningful duration.
    mock.timers.enable({ apis: ["Date"], now: new Date("2025-02-03T10:00:00Z") });
  });

  afterEach(async () => {
    try {
      await ui?.dispose();
      assert.deepEqual(failures, [], "unexpected work and extension errors cannot be swallowed");
    } finally {
      ui = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
      await rm(path.join(getAgentDir(), "insights"), { recursive: true, force: true });
    }
  });

  test("analyzes only substantial project sessions, reuses durable facets after reload, and saves a useful synthesis fallback", async () => {
    const history = conversation(cwd, sessions, "Repair the espresso queue");
    const other = conversation(cwd, sessions, "Rehearse the rollback drill");
    const unrelated = conversation(path.join(directory, "submarine"), sessions, "Launch torpedoes");
    const trivial = SessionManager.create(cwd, sessions);
    trivial.appendMessage({ role: "user", content: "Hello, octopus!", timestamp: Date.now() });
    trivial.appendMessage(assistantMessage("Hello!"));
    history.appendMessage({
      ...assistantMessage("The queue patch is ready."),
      content: [
        { type: "thinking", thinking: "THINKING_ONLY_DO_NOT_EXPORT" },
        {
          type: "toolCall",
          id: "espresso-write",
          name: "write",
          arguments: { path: "src/espresso.ts", content: "WRITE_BODY_DO_NOT_EXPORT" },
        },
      ],
      stopReason: "toolUse",
    });
    history.appendMessage({
      role: "toolResult",
      toolCallId: "espresso-write",
      toolName: "write",
      content: [{ type: "text", text: "Queue patch written." }],
      isError: false,
      timestamp: Date.now(),
    });
    let syntheses = 0;
    ui = await openInsights(directory, history, extension, failures, (context) => {
      if (isSynthesis(context)) {
        return ++syntheses === 1
          ? assistantMessage(report)
          : { ...assistantMessage(""), stopReason: "error", errorMessage: "Fixture gateway down" };
      }
      const prompt = requestText(context);
      return facet(
        prompt.includes("Repair the espresso queue") ? "Queue repaired" : "Rollback rehearsed",
      );
    });
    const files = [history, other, unrelated, trivial].map((manager) => manager.getSessionFile()!);
    const before = await Promise.all(files.map((file) => readFile(file)));

    await ui.run(); // No scope argument means the owning project, not process.cwd().
    const facets = ui.requests.filter((context) => !isSynthesis(context));
    assert.equal(facets.length, 2, "small talk and another cwd must not cost classification calls");
    const prompts = facets.map(requestText).join("\n");
    assert.doesNotMatch(prompts, /Launch torpedoes|Hello, octopus|THINKING_ONLY|WRITE_BODY/);
    assert.match(prompts, /path: src\/espresso\.ts/);
    assert.match(prompts, /Queue patch written/);
    const aggregate = synthesisPayload(ui.requests.find(isSynthesis)!);
    assert.equal(aggregate.scope, "project");
    assert.equal(aggregate.sessionsConsidered, 3);
    assert.equal(aggregate.sessionsAnalyzed, 2);
    assert.equal(aggregate.sessionsWithFacets, 2);
    assert.equal(aggregate.sessionsSkipped, 1);
    assert.deepEqual(aggregate.topProjects, [{ key: cwd, value: 2 }]);
    assert.deepEqual(aggregate.topGoalCategories, [{ key: "fix_bug", value: 2 }]);
    assert.deepEqual(aggregate.topTools, [{ key: "write", value: 1 }]);
    assert.deepEqual(aggregate.topLanguages, [{ key: "TypeScript", value: 1 }]);
    assert.deepEqual(aggregate.repeatedInstructions, [{ text: instruction, count: 2 }]);
    assert.deepEqual(
      aggregate.repeatedWorkflows,
      [],
      "one-off and within-session duplicates are not repeated evidence",
    );
    const firstReport = await savedReport(directory);
    assert.equal(await readFile(firstReport, "utf8"), `${report.trimEnd()}\n`);
    assert.equal(
      (await stat(firstReport)).mode & 0o777,
      0o600,
      "reports contain private session evidence",
    );

    await ui.session.reload();
    await ui.run();
    assert.equal(
      ui.requests.filter((context) => !isSynthesis(context)).length,
      2,
      "reload must not pay to reclassify unchanged sessions",
    );
    assert.equal(ui.requests.length, 4, "two classifications and one synthesis per report");
    assert.deepEqual(synthesisPayload(ui.requests.at(-1)!), aggregate);
    const fallback = await readFile(await savedReport(directory), "utf8");
    assert.match(fallback, /synthesis failed.*deterministic fallback/i);
    assert.match(fallback, /Sessions analyzed: 2/);
    assert.ok(fallback.includes(`${instruction} — repeated in 2 sessions`));
    assert.deepEqual(
      await Promise.all(files.map((file) => readFile(file))),
      before,
      "analysis never rewrites source sessions",
    );
    assert.equal(ui.session.pendingMessageCount, 0);
    assert.equal(ui.session.model?.id, fixtureModel.id);
    assert.ok(ui.notifications.every((notice) => notice.type === "info"));
  });

  test("current scope follows tree navigation even when the previous branch has a warm cache", async () => {
    const history = conversation(cwd, sessions, "BRANCH_A: repair the café");
    const branchA = history.getLeafId()!;
    const ancestor = history
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    history.branch(ancestor.id);
    mock.timers.tick(61_000);
    history.appendMessage({
      role: "user",
      content: "BRANCH_B: build a submarine",
      timestamp: Date.now(),
    });
    const branchB = history.appendMessage(assistantMessage("Submarine ready."));
    ui = await openInsights(directory, history, extension, failures, (context) => {
      if (isSynthesis(context)) return assistantMessage(report);
      return facet(requestText(context).includes("BRANCH_B") ? "Submarine built" : "Café repaired");
    });
    const before = await readFile(history.getSessionFile()!);
    await ui.run("scope=current");
    assert.equal(
      synthesisPayload(ui.requests.at(-1)!).representativeSessions[0].goal,
      "Submarine built",
    );

    await ui.session.navigateTree(branchA, { summarize: false });
    assert.equal(history.getLeafId(), branchA);
    assert.deepEqual(
      await readFile(history.getSessionFile()!),
      before,
      "navigation changes only the active view",
    );
    await ui.run("scope=current");

    assert.equal(
      synthesisPayload(ui.requests.at(-1)!).representativeSessions[0].goal,
      "Café repaired",
      "cached insights must describe the selected branch, not the previously analyzed one",
    );
    const currentFacets = ui.requests.filter((context) => !isSynthesis(context)).map(requestText);
    assert.equal(currentFacets.length, 2);
    assert.match(currentFacets[0], /BRANCH_B/);
    assert.doesNotMatch(currentFacets[0], /BRANCH_A/);
    assert.match(currentFacets[1], /BRANCH_A/);
    assert.doesNotMatch(currentFacets[1], /BRANCH_B/);
    assert.match(currentFacets[0], /duration_minutes: 2\n/);
    assert.match(currentFacets[1], /duration_minutes: 1\n/);

    await ui.session.reload();
    assert.equal(history.getLeafId(), branchA, "reload preserves the actual selected view");
    await ui.run("scope=current");
    assert.equal(ui.requests.filter((context) => !isSynthesis(context)).length, 2);
    assert.equal(
      synthesisPayload(ui.requests.at(-1)!).representativeSessions[0].goal,
      "Café repaired",
    );

    await ui.run("scope=project");
    assert.equal(
      synthesisPayload(ui.requests.at(-1)!).representativeSessions[0].goal,
      "Submarine built",
    );
    assert.equal(history.getLeafId(), branchA, "file-based analysis must not move the live leaf");

    await ui.session.navigateTree(branchB, { summarize: false });
    const callsBeforeReturn = ui.requests.length;
    await ui.run("scope=current");
    assert.equal(ui.requests.length, callsBeforeReturn + 1, "returning to B reuses its facet");
    assert.equal(
      synthesisPayload(ui.requests.at(-1)!).representativeSessions[0].goal,
      "Submarine built",
    );
    assert.equal(history.getLeafId(), branchB);
    assert.deepEqual(await readFile(history.getSessionFile()!), before);
  });

  for (const extended of [false, true]) {
    test(`retains final user feedback within a reduced transcript (${extended ? "long conversation and summaries" : "huge opening brief"})`, async () => {
      const ending = "FINAL_OUTCOME: This failed; the espresso queue still loses orders.";
      const history = conversation(
        cwd,
        sessions,
        extended ? "MIDPOINT: Try the rollback drill." : ending,
        `OPENING_GOAL: Fix the café queue.\n${"Long incident log. ".repeat(2_000)}`,
      );
      if (extended) {
        history.branchWithSummary(
          history.getLeafId()!,
          `SUMMARY_START: Rollback assumptions.\n${"Summary evidence. ".repeat(2_000)}\nSUMMARY_END: Verify the queue.`,
        );
        for (let index = 0; index < 40; index++) {
          history.appendMessage(
            assistantMessage(`DRILL_${index}: ${"Rehearsal notes. ".repeat(100)}`),
          );
        }
        history.appendMessage({
          role: "user",
          content: `FINAL_REVIEW: Here are the results.\n${"Still losing orders. ".repeat(2_000)}\n${ending}`,
          timestamp: Date.now(),
        });
        history.appendMessage(assistantMessage("ACKNOWLEDGED: More repair work is needed."));
      }
      ui = await openInsights(directory, history, extension, failures, (context) =>
        isSynthesis(context) ? assistantMessage(report) : facet("Investigate lost orders"),
      );
      const before = await readFile(history.getSessionFile()!);
      await ui.run("scope=current");
      assert.equal(ui.requests.length, 2, "one classification and one synthesis");
      const prompt = requestText(ui.requests[0]);
      const transcript = prompt.match(/<session>\n([\s\S]*)\n<\/session>/)?.[1];
      assert.ok(transcript);
      assert.ok(transcript.length <= 30_000, "analysis stays within its transcript budget");
      assert.ok(prompt.length < 32_000, "the opening brief must not leak through metadata either");
      assert.match(transcript, /\[User\]\nOPENING_GOAL/);
      assert.ok(
        transcript.includes(ending),
        "outcome classification needs the final correction, not just the opening brief",
      );
      assert.match(transcript, /omitted/);
      assert.ok(transcript.indexOf("OPENING_GOAL") < transcript.indexOf(ending));
      if (extended) {
        assert.match(transcript, /\[BranchSummary\]\nSUMMARY_START/);
        assert.match(transcript, /SUMMARY_END/);
        assert.match(transcript, /\[User\]\nFINAL_REVIEW/);
        assert.match(transcript, /\[Assistant\]\nACKNOWLEDGED/);
        const chronology = [
          "OPENING_GOAL",
          "SUMMARY_START",
          "SUMMARY_END",
          "FINAL_REVIEW",
          ending,
          "ACKNOWLEDGED",
        ];
        const positions = chronology.map((text) => transcript.indexOf(text));
        assert.deepEqual(
          positions,
          [...positions].sort((a, b) => a - b),
        );
        assert.match(transcript, /\d+ blocks omitted/);
      } else {
        assert.match(transcript, /\[Assistant\]\nLet's investigate\./);
        assert.ok(transcript.includes(`[User]\n${ending}`));
        assert.match(transcript, /\[Assistant\]\nInvestigation recorded\./);
      }
      assert.deepEqual(await readFile(history.getSessionFile()!), before);
    });
  }
});

/** Seed durable native history under a controlled clock; no tools or model calls execute here. */
function conversation(
  cwd: string,
  sessionDir: string,
  followUp: string,
  opening = "Help keep the café online.",
) {
  const history = SessionManager.create(cwd, sessionDir);
  history.appendModelChange(fixtureModel.provider, fixtureModel.id);
  history.appendThinkingLevelChange("off");
  history.appendMessage({ role: "user", content: opening, timestamp: Date.now() });
  history.appendMessage(assistantMessage("Let's investigate."));
  mock.timers.tick(61_000);
  history.appendMessage({ role: "user", content: followUp, timestamp: Date.now() });
  history.appendMessage(assistantMessage("Investigation recorded."));
  return history;
}

/** Dispatch the command through real Pi resources and model runtime; only provider generation is scripted. */
async function openInsights(
  directory: string,
  history: SessionManager,
  extension: ExtensionFactory,
  failures: unknown[],
  reply: (context: Context) => AssistantMessage,
  readReport: (component: Component, terminal: Viewport) => void = () => {},
) {
  const requests: Context[] = [];
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider(fixtureModel.provider, {
      api: fixtureModel.api,
      baseUrl: fixtureModel.baseUrl,
      apiKey: "fixture-only",
      models: [fixtureModel],
      streamSimple: (model, context) => {
        try {
          assert.equal(model.id, fixtureModel.id);
          assert.deepEqual(context.tools ?? [], []);
          assert.equal(context.messages.length, 1);
          assert.equal(context.messages[0].role, "user");
          assert.match(context.systemPrompt ?? "", /coding session|insights report/);
          requests.push(structuredClone(context));
          return replyStream(reply(context));
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
    });
  };
  const resources = await createPiResources(history.getCwd(), getAgentDir(), [extension, provider]);
  const { session } = await createAgentSession({
    ...resources,
    sessionManager: history,
    model: fixtureModel,
    tools: [],
  });
  const dispose = async () => {
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
    const dialogs = reportDialogs(
      session.extensionRunner.getUIContext().theme,
      failures,
      readReport,
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
      async run(args = "") {
        mock.timers.tick(1_000); // Distinct deterministic report filenames, including after reload.
        await session.prompt(`/insights ${args}`.trimEnd(), { source: "interactive" });
        await session.waitForIdle();
        assert.deepEqual(failures, []);
        assert.ok(
          (await readdir(directory)).some((file) => file.startsWith("tau-insights-")),
          "a completed analysis saves a report",
        );
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Mount real loaders/report components without physical terminal output; this is not CLI/PTY E2E. */
function reportDialogs(
  theme: ExtensionUIContext["theme"],
  failures: unknown[],
  readReport: (component: Component, terminal: Viewport) => void,
) {
  const terminal = new Proxy(
    { columns: 80, rows: 24, showCursor() {}, stop() {} },
    {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        const error = new Error(`Unexpected terminal operation: ${String(key)}`);
        failures.push(error);
        throw error;
      },
    },
  );
  const tui = new TuiMainScreen(terminal as Terminal);
  tui.stop(); // Explicit component renders only; no scheduled physical-terminal rendering.
  const keybindings = new Proxy(getKeybindings(), {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      const error = new Error(`Unexpected app keybinding operation: ${String(key)}`);
      failures.push(error);
      throw error;
    },
  }) as KeybindingsManager;
  const notifications: { message: string; type: string | undefined }[] = [];
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
            try {
              readReport(component, terminal);
            } finally {
              press(component, "\r");
            }
          }
          return await Promise.race([
            result as Promise<T>,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(() => {
                press(component, "\x1b");
                reject(new Error("Insights dialog did not finish"));
              }, 10_000);
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
  return { context, notifications };
}

function facet(goal: string) {
  return assistantMessage(
    "```json\n" +
      JSON.stringify({
        underlyingGoal: goal,
        goalCategories: ["fix_bug", "fix_bug", "espresso_magic"],
        outcome: "achieved",
        frictionCategories: [],
        frictionDetail: "",
        briefSummary: goal,
        explicitInstructionsToRemember: [instruction, `${instruction}!`, instruction],
        repeatedWorkflowHints: [`Practice ${goal}`, `Practice ${goal}`],
      }) +
      "\n```",
  );
}

function isSynthesis(context: Context) {
  return context.systemPrompt?.includes("/insights report") === true;
}

function requestText(context: Context) {
  return context.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
    )
    .join("\n");
}

/** Read the actual structured aggregate sent to the provider, not production's private result type. */
function synthesisPayload(context: Context) {
  const text = requestText(context);
  return JSON.parse(text.slice(text.indexOf("{")));
}

async function savedReport(directory: string) {
  const files = (await readdir(directory))
    .filter((file) => /^tau-insights-.*\.md$/.test(file))
    .sort();
  assert.ok(files.length > 0);
  return path.join(directory, files.at(-1)!);
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

function press(component: Component, input: string) {
  assert.ok(component.handleInput);
  component.handleInput(input);
}
