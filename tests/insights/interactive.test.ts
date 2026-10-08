import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { deadline } from "../helpers/async.js";
import {
  captureTerminal,
  observeInteractive,
  openInteractive,
  rejectInteractiveExternalWork,
} from "../helpers/interactive.js";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider, type Generation } from "../helpers/provider.js";

const report = Array.from(
  { length: 40 },
  (_, i) => `RESULT_${String(i + 1).padStart(2, "0")}: Rehearse this rollback checkpoint.`,
).join("\n\n");
const model = {
  ...fixtureModel,
  id: Array.from(
    { length: 24 },
    (_, i) => `MODEL_${String(i + 1).padStart(2, "0")}-${"reef-reader-".repeat(4)}`,
  ).join(" "),
};

describe("insights native reader", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let insights: ExtensionFactory;
  let directory: string;
  let failures: unknown[];
  let app: Awaited<ReturnType<typeof openInteractive>> | undefined;

  before(async () => {
    home = await isolatePiHome();
    ({ default: insights } = await import("../../extensions/insights.js"));
  });

  after(async () => home.dispose());

  beforeEach(async () => {
    failures = [];
    rejectInteractiveExternalWork(failures);
    directory = await mkdtemp(path.join(os.tmpdir(), "tau-insights-reader-"));
    mock.method(os, "tmpdir", () => directory);
    syncBuiltinESMExports();
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-15T12:00:00Z") });
  });

  afterEach(async () => {
    try {
      await app?.dispose();
      assert.deepEqual(failures, []);
    } finally {
      app = undefined;
      mock.restoreAll();
      mock.timers.reset();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
      await rm(path.join(getAgentDir(), "insights"), { recursive: true, force: true });
    }
  });

  for (const mode of ["default", "regular"] as const) {
    test(`${mode}: reads tall metadata and the entire saved report without changing history`, async () => {
      const terminal = captureTerminal(80, 24);
      const observer = observeInteractive();
      const calls: Generation[] = [];
      const history = SessionManager.create(directory, path.join(directory, "sessions"));
      history.appendModelChange(fixtureModel.provider, fixtureModel.id);
      history.appendMessage({
        role: "user",
        content: "Keep the reef online.",
        timestamp: Date.now(),
      });
      history.appendMessage(assistantMessage("Let's investigate."));
      mock.timers.tick(61_000);
      history.appendMessage({
        role: "user",
        content: "Review rollout risks.",
        timestamp: Date.now(),
      });
      history.appendMessage(assistantMessage("Older reef notes.\n\n".repeat(80)));
      const resources = await createPiResources(directory, getAgentDir(), [
        insights,
        observer.extension,
        scriptedProvider(model, (call) => {
          calls.push(call);
          return getCurrentSystemPrompt(call.context.messages).includes("/insights report")
            ? assistantMessage(report)
            : assistantMessage(
                JSON.stringify({
                  underlyingGoal: "Review reef rollout",
                  goalCategories: ["fix_bug"],
                  outcome: "achieved",
                  frictionCategories: [],
                  frictionDetail: "",
                  briefSummary: "Review reef rollout",
                  explicitInstructionsToRemember: [],
                  repeatedWorkflowHints: [],
                }),
              );
        }),
      ]);
      app = await openInteractive({ ...resources, sessionManager: history }, failures, mode);
      await app.session.setModel(model);
      const { ctx, tui } = observer.get();
      assert.equal(tui.mode, mode === "default" ? "fullscreen" : "regular");
      terminal.send("ink");
      const before = await readFile(history.getSessionFile()!);
      const messages = structuredClone(app.session.messages);
      const command = app.session.prompt("/insights scope=current", { source: "interactive" });
      try {
        await terminal.waitForText("current scope");
        const repaint = () => terminal.repaint(tui);
        const initial = repaint();
        for (const corner of ["╭", "╮", "╰", "╯"]) assert.ok(initial.includes(corner));
        assert.match(initial, /Enter\/Esc close/);
        assert.match(
          initial,
          /↑↓\/j\/k scroll · pageUp\/pageDown page · ctrl\+home\/ctrl\+end ends/,
        );
        assert.doesNotMatch(initial, /RESULT_40/);
        const seen = [initial];
        // Enumerate this finite document in pages, not a readiness/retry loop.
        for (let i = 0; i < 12; i++) {
          terminal.send("\x1b[6~");
          seen.push(repaint());
        }
        for (const [prefix, count] of [
          ["MODEL", 24],
          ["RESULT", 40],
        ] as const) {
          for (let i = 1; i <= count; i++) {
            assert.ok(
              seen.some((frame) => frame.includes(`${prefix}_${String(i).padStart(2, "0")}`)),
            );
          }
        }
        assert.match(seen.at(-1)!, /RESULT_40/);
        terminal.send("\x1b[5~");
        assert.doesNotMatch(repaint(), /RESULT_40/);
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), /RESULT_40/);
        terminal.send("\x1b[1;5H");
        assert.match(repaint(), /current scope/);
        const top = readingPosition(repaint());
        for (const key of ["j", "\x1b[B"]) terminal.send(key);
        assert.equal(readingPosition(repaint()), top + 2);
        for (const key of ["k", "\x1b[A"]) terminal.send(key);
        assert.equal(readingPosition(repaint()), top);

        terminal.resize(120, 30);
        let frame = repaint();
        for (const corner of ["╭", "╮", "╰", "╯"]) assert.ok(frame.includes(corner));
        terminal.send("\x1b[1;5F");
        assert.match(repaint(), /RESULT_40/);
        terminal.resize(120, 12);
        repaint();
        terminal.send("\x1b[1;5F");
        frame = repaint();
        assert.match(frame, /RESULT_40/);
        assert.match(frame, /Enter\/Esc close/);
        assert.match(frame, /╰.*╯/);
        terminal.resize(120, 8);
        assert.match(repaint(), /Esc close.*Resize/);
        terminal.send("\x1b[1;5H"); // Tiny mode ignores Ctrl+Home and keeps the reading position.
        terminal.resize(120, 30);
        assert.match(repaint(), /RESULT_40/);
        terminal.send("\x1b[1;5H");
        assert.match(repaint(), /current scope/);
        terminal.resize(30, 8);
        assert.match(repaint(), /Esc close.*Resize/);
      } finally {
        terminal.writes.length = 0;
        terminal.send("q");
        await deadline(command, "Insights command completion");
        terminal.resize(80, 24);
        await terminal.waitForText("ink");
      }
      assert.equal(ctx.ui.getEditorText(), "ink");
      assert.deepEqual(await readFile(history.getSessionFile()!), before);
      assert.deepEqual(app.session.messages, messages);
      assert.equal(app.session.pendingMessageCount, 0);
      assert.equal(calls.length, 2);
      assert.equal(
        calls.filter((call) =>
          getCurrentSystemPrompt(call.context.messages).includes("/insights report"),
        ).length,
        1,
      );
      const reports = (await readdir(directory)).filter((file) =>
        /^tau-insights-.*\.md$/.test(file),
      );
      assert.equal(reports.length, 1);
      assert.equal(await readFile(path.join(directory, reports[0]), "utf8"), `${report}\n`);
      terminal.send("!");
      assert.equal(ctx.ui.getEditorText(), "ink!", "close restores native editor focus");
    });
  }
});

function readingPosition(frame: string) {
  const match = frame.match(/Enter\/Esc close · (\d+)-\d+\/\d+/);
  assert.ok(match, "physical reader controls are visible");
  return Number(match[1]);
}
